// Design QA, shared by every artifact before it's sent (services/designSystem.ts, "QA BEFORE ANY SEND"). The artifact is rendered in
// headless Chrome exactly as it will be seen (decks a 1280x720 slide each, pages at phone and laptop width, docs as printed Letter
// pages), screenshotted, and measured in the page:
//   - type scale: the headline-to-body ratio, the smallest body size, how many sizes are in play;
//   - spacing: every line of text inside the safe margin of its frame;
//   - contrast: every text run against its actual ground, each end of a gradient included (WCAG ratio);
//   - overflow: text that runs past its frame;
//   - orphan headlines: a headline whose last line is one word;
//   - image placement: an image shown larger than its pixels (blurry), a logo touching its frame's edge;
// then per medium, from the content itself: decks one idea per slide; pages scannability (paragraph length, a heading every few
// blocks); docs and PDFs print type (body at least 10pt, line length) and page breaks (no heading stranded at the foot of a page).
// The browser loads only the font hosts and data: URLs. Findings come back with whether code can fix them ("auto") or Co must
// ("co"); the caller applies the fixes, measures again, and logs what was found.
import { contrast, inkOn } from "./coPages/style.js";
import * as artMod from "./coPages/art.js";
import { compositionProblem, placeholderIn } from "./coPages/art.js";

export type QaMedium = "deck" | "page" | "doc";
// contrast findings carry what was measured (the ink, its ground, the ratio it needs), so code can re-ink or move a gradient end.
export type QaFinding = { rule: "type_scale" | "spacing" | "contrast" | "overflow" | "orphan" | "image" | "one_idea" | "scannability" | "print_type" | "page_break" | "render" | "craft" | "composition" | "imagery"; where: string; detail: string; fix: "auto" | "co" | "none"; slide?: number; role?: string; color?: string; alpha?: number; ground?: string[]; need?: number; view?: "phone" };
export type QaResult = { ran: boolean; findings: QaFinding[]; screenshot: Buffer | null; measured: number; phone?: Buffer | null };

// alpha: how much of the text's own color shows (its opacity and its ancestors', times the color's own alpha); it's blended onto its
// ground before contrast is measured (design audit: a subtitle at 0.25 opacity measured as fully opaque).
// text: what it says (the craft bar reads it for placeholders); clipped: cut off by its box (an ellipsis, or past an edge that hides it).
type TextM = { role: string; size: number; color: string; alpha?: number; ground: string[]; slide: number | null; rect: [number, number, number, number]; frame: [number, number, number, number] | null; orphan: boolean; chars: number; words: number; text?: string; clipped?: boolean };
// crop: the share of the picture that shows when it's cropped to fill a box of another shape (object-fit cover), and whether the
// shapes are more than 1.5x apart.
// A logo chip (the craft bar): drawn at its own shape (distorted: off by more than 3%), not cut off by a box (clipped), and on a
// transparent ground or a plate (box: an opaque ground of its own that isn't the plate's or the slide's color, with that color).
type ImgM = { natural: [number, number]; shown: [number, number]; slide: number | null; logo: boolean; edge: boolean; crop?: { shown: number; mismatch: boolean }; distorted?: boolean; clipped?: boolean; box?: string | null };
type FrameM = { slide: number | null; overflow: boolean; layout: string | null; points?: number };
type HeadM = { top: number; text: string };
// secs: a document's sections in order (where each starts and how tall it is), to lay the printed pages out the way print does.
// pictures: how many pictures the artifact really shows (loaded photos and logos, a map with its tiles, a typographic plate).
export type Measure = { texts: TextM[]; imgs: ImgM[]; frames: FrameM[]; heads: HeadM[]; pageHeight: number; fontsLoaded: boolean; secs?: { top: number; height: number; head: string }[]; unloaded?: number; pictures?: number };

// In the page. Reads data-qa-* markers the renderers put on frames, text and images; anything unmarked is measured by tag.
function measureInPage(medium: string): Measure {
  const rgb = (c: string) => {
    const m = c.match(/\d+(\.\d+)?/g);
    return m ? "#" + m.slice(0, 3).map((v) => Math.round(Number(v)).toString(16).padStart(2, "0")).join("").toUpperCase() : "#000000";
  };
  const rectOf = (el: Element): [number, number, number, number] => {
    const r = el.getBoundingClientRect();
    return [r.left + scrollX, r.top + scrollY, r.width, r.height];
  };
  const groundOf = (el: Element): string[] => {
    let n: Element | null = el;
    while (n) {
      const g = n.getAttribute("data-ground");
      if (g) return g.split(",");
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return [rgb(bg)];
      n = n.parentElement;
    }
    return ["#FFFFFF"];
  };
  const orphanOf = (el: Element): boolean => {
    const text = el.textContent ?? "";
    const words = text.trim().split(/\s+/);
    if (words.length < 3) return false;
    const range = document.createRange();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const last = nodes[nodes.length - 1];
    if (!last) return false;
    const t = last.data.replace(/\s+$/, "");
    const lastStart = Math.max(t.search(/\S+$/), 0);
    range.setStart(last, lastStart);
    range.setEnd(last, t.length);
    const lastRect = range.getBoundingClientRect();
    const full = el.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.2;
    // More than one line, and the last word alone on the last line: it starts at the line's left edge.
    return full.height > lh * 1.5 && Math.abs(lastRect.left - full.left) < 2 && lastRect.top > full.top + 2;
  };
  const frames = [...document.querySelectorAll("[data-qa-frame]")];
  const frameOf = (el: Element) => el.closest("[data-qa-frame]");
  const slideOf = (el: Element) => {
    const f = frameOf(el);
    const n = f?.getAttribute("data-qa-slide");
    return n ? Number(n) : f ? 1 : null;
  };
  // Labels too (index numbers, the foot line and slide numbers, small capitals): they're read, so they're measured (design audit).
  const LABELS = ".num, .gl, .asof, .f dt, .meta, .date, .for, h3, .credit, .cover-credit, figcaption, .plab, .coords";
  const textEls = [...document.querySelectorAll(medium === "deck" ? "[data-qa-text]" : `h1, h2, h3, p, li, dd, .ln, .lnote, ${LABELS}`)].filter((el) => (el.textContent ?? "").trim() && (el as HTMLElement).offsetParent !== null);
  const alphaOf = (el: Element): number => {
    const m = getComputedStyle(el).color.match(/rgba?\(([^)]+)\)/);
    const parts = m ? m[1].split(/[ ,/]+/).filter(Boolean) : [];
    let a = parts.length >= 4 ? Number(parts[3]) : 1;
    for (let n: Element | null = el; n; n = n.parentElement) a *= Number(getComputedStyle(n).opacity || 1);
    return Math.round(a * 100) / 100;
  };
  const texts: TextM[] = textEls.map((el) => {
    const cs = getComputedStyle(el);
    const role = el.getAttribute("data-qa-text") ?? (el.matches(LABELS) ? "label" : /^H[1-2]$/.test(el.tagName) ? el.tagName.toLowerCase() : "body");
    const f = frameOf(el);
    const words = (el.textContent ?? "").trim().split(/\s+/).length;
    const he = el as HTMLElement;
    const r0 = el.getBoundingClientRect();
    // Cut off: an ellipsis that's in use, or a box above it that hides what runs past its edge.
    let clipped = cs.textOverflow === "ellipsis" && he.scrollWidth > he.clientWidth + 1;
    for (let n = el.parentElement; n && !clipped; n = n.parentElement) {
      const o = getComputedStyle(n);
      // A box that scrolls (a side-by-side carousel) shows the rest on a swipe: only a box that hides it cuts it off.
      if (!/hidden|clip/.test(o.overflowX) && !/hidden|clip/.test(o.overflowY)) continue;
      const nr = n.getBoundingClientRect();
      if (r0.right > nr.right + 1 || r0.left < nr.left - 1 || r0.bottom > nr.bottom + 1) clipped = true;
      if (n.hasAttribute("data-qa-frame")) break;
    }
    return { role: role === "credit" ? "label" : role, size: parseFloat(cs.fontSize), color: rgb(cs.color), alpha: alphaOf(el), ground: groundOf(el), slide: slideOf(el), rect: rectOf(el), frame: f ? rectOf(f) : null, orphan: /^h[12]$/.test(role) ? orphanOf(el) : false, chars: (el.textContent ?? "").length, words, text: (el.textContent ?? "").trim().slice(0, 300), clipped };
  });
  // An image that didn't load (a host the check can't reach) isn't measured as a 1x1 picture (design audit: every photo page read
  // "1280x its pixels"); it's counted apart.
  const allImgs = [...document.querySelectorAll("img")];
  const unloaded = allImgs.filter((im) => !im.naturalWidth).length;
  const imgs: ImgM[] = allImgs.filter((im) => im.naturalWidth > 0).map((im) => {
    const r = im.getBoundingClientRect();
    const f = frameOf(im);
    const fr = f?.getBoundingClientRect();
    const edge = !!fr && (r.left - fr.left < 2 || fr.right - r.right < 2 || r.top - fr.top < 2 || fr.bottom - r.bottom < 2);
    // The size it's drawn at: object-fit contain draws inside the box.
    const fit = getComputedStyle(im).objectFit;
    const nw = im.naturalWidth || 1, nh = im.naturalHeight || 1;
    const k = fit === "contain" || fit === "scale-down" ? Math.min(r.width / nw, r.height / nh) : fit === "cover" ? Math.max(r.width / nw, r.height / nh) : r.width / nw;
    const shownShare = fit === "cover" && r.width && r.height ? Math.min(r.width / (nw * k), r.height / (nh * k)) : 1;
    const ia = nw / nh, ba = r.width / Math.max(1, r.height);
    // A designed crop (a full-bleed cover, a strip, a found photo filling its plate) is meant to crop; it's not measured as one.
    const crop = fit === "cover" && im.getAttribute("data-qa-crop") !== "ok" ? { shown: Math.round(shownShare * 100) / 100, mismatch: Math.max(ia / ba, ba / ia) > 1.5 } : undefined;
    const isLogo = /\blogo\b/.test(im.className);
    let distorted = false, clipped = false;
    let box: string | null = null;
    if (isLogo) {
      distorted = !(fit === "contain" || fit === "scale-down") && Math.abs(r.width / Math.max(1, r.height) - nw / nh) / (nw / nh) > 0.03;
      for (let n = im.parentElement; n; n = n.parentElement) {
        const o = getComputedStyle(n);
        if (/hidden|clip/.test(o.overflowX) || /hidden|clip/.test(o.overflowY)) {
          const nr = n.getBoundingClientRect();
          if (r.left < nr.left - 1 || r.right > nr.right + 1 || r.top < nr.top - 1 || r.bottom > nr.bottom + 1) clipped = true;
        }
        if (n.hasAttribute("data-qa-frame")) break;
      }
      // Its corners: one opaque color all round is a ground of its own; it must be the color it sits on (or it's on a plate).
      try {
        const c = document.createElement("canvas");
        c.width = Math.min(nw, 400);
        c.height = Math.min(nh, 400);
        const x = c.getContext("2d")!;
        x.drawImage(im, 0, 0, c.width, c.height);
        const px = [[1, 1], [c.width - 2, 1], [1, c.height - 2], [c.width - 2, c.height - 2]].map(([a, b]) => Array.from(x.getImageData(a, b, 1, 1).data));
        const opaque = px.every((p) => p[3] > 240);
        const same = px.every((p) => Math.abs(p[0] - px[0][0]) + Math.abs(p[1] - px[0][1]) + Math.abs(p[2] - px[0][2]) < 24);
        if (opaque && same) {
          const hex = "#" + px[0].slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
          const on = groundOf(im.parentElement ?? im)[0];
          const d = [1, 3, 5].reduce((a, i) => a + Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(on.slice(i, i + 2), 16)), 0);
          if (d > 30) box = hex;
        }
      } catch {}
    }
    return { natural: [nw, nh], shown: [nw * k, nh * k], slide: slideOf(im), logo: isLogo, edge: edge && isLogo, ...(crop ? { crop } : {}), ...(isLogo ? { distorted, clipped, box } : {}) };
  });
  // The pictures it shows: loaded photos and logos (map tiles counted as their map), maps with tiles, typographic plates.
  const pictures = allImgs.filter((im) => im.naturalWidth > 0 && !im.hasAttribute("data-qa-tile")).length + [...document.querySelectorAll("[data-art=map]")].filter((m) => [...m.querySelectorAll("img")].some((t) => (t as HTMLImageElement).naturalWidth > 0)).length + document.querySelectorAll("[data-art=design]").length;
  const frameM: FrameM[] = frames.map((f) => {
    const fr = f.getBoundingClientRect();
    const over = [...f.querySelectorAll("[data-qa-text]")].some((t) => {
      const r = t.getBoundingClientRect();
      return r.bottom > fr.bottom + 1 || r.right > fr.right + 1;
    });
    const n = f.getAttribute("data-qa-slide");
    return { slide: n ? Number(n) : 1, overflow: over || (f as HTMLElement).scrollHeight > (f as HTMLElement).clientHeight + 2, layout: f.getAttribute("data-qa-layout"), points: Number(f.getAttribute("data-qa-points") ?? 3) };
  });
  const heads = [...document.querySelectorAll("h2, h3")].map((h) => ({ top: h.getBoundingClientRect().top + scrollY, text: (h.textContent ?? "").slice(0, 60) }));
  const fontsLoaded = [...(document as any).fonts].some((f: any) => f.status === "loaded");
  const secs = medium === "doc" ? [...document.querySelectorAll("section.sec")].map((sec) => ({ top: sec.getBoundingClientRect().top + scrollY, height: sec.getBoundingClientRect().height, head: (sec.querySelector("h2")?.textContent ?? "").slice(0, 60) })) : undefined;
  return { texts, imgs, frames: frameM, heads, pageHeight: document.documentElement.scrollHeight, fontsLoaded, ...(secs ? { secs } : {}), unloaded, pictures };
}

// Pure: a color at an alpha over a ground, as the eye sees it.
export function blend(color: string, ground: string, alpha: number): string {
  if (alpha >= 0.999) return color;
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(ch(color, i) * alpha + ch(ground, i) * (1 - alpha)).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

// Pure: where each document heading lands once printed. Sections don't break inside (documentSheet.ts), so one that doesn't fit what's
// left of a page moves whole to the next; one taller than a page starts where it is and runs on. A heading is stranded when its section
// starts in the last 14% of a page and runs past it.
export function strandedHeads(secs: { top: number; height: number; head: string }[], pageH: number): string[] {
  const out: string[] = [];
  let shift = 0;
  for (const s of secs) {
    let top = s.top + shift;
    const into = top % pageH;
    if (into + s.height > pageH && s.height <= pageH) {
      shift += pageH - into;
      top += pageH - into;
      continue;
    }
    if (s.head && into > pageH * 0.86 && into + s.height > pageH) out.push(s.head);
  }
  return out;
}

// Pure: the findings from a measure, per medium. Type limits are in CSS px at the size QA renders at (decks 1280 wide).
// phone: the 390px pass (decks and pages): the type floors are a phone's (body 15px, labels 11px); contrast and layout were measured at
// full size, so only type, overflow and images are read here.
export function qaFindings(m: Measure, medium: QaMedium, o: { printPageHeightPx?: number; phone?: boolean } = {}): QaFinding[] {
  const out: QaFinding[] = [];
  const where = (t: { slide: number | null }) => `${t.slide ? `slide ${t.slide}` : "the page"}${o.phone ? " on a phone" : ""}`;
  // Overflow.
  for (const f of m.frames) if (f.overflow) out.push({ rule: "overflow", where: `slide ${f.slide}`, detail: "text runs past the slide", fix: "auto", slide: f.slide ?? undefined });
  // Contrast: on every stop of its ground, with its opacity blended in.
  if (!o.phone)
    for (const t of m.texts) {
      const a = t.alpha ?? 1;
      const worst = Math.min(...t.ground.map((g) => contrast(blend(t.color, g, a), g)));
      const need = t.size >= 24 ? 3 : 4.5;
      if (worst < need) out.push({ rule: "contrast", where: where(t), detail: `${t.role === "label" ? "label" : t.role} ${t.color}${a < 1 ? ` at ${Math.round(a * 100)}% opacity` : ""} on ${t.ground.join(" to ")} is ${worst.toFixed(1)}:1 (needs ${need}:1)`, fix: "auto", slide: t.slide ?? undefined, role: t.role, color: t.color, alpha: a, ground: t.ground, need });
    }
  // Orphans.
  for (const t of m.texts) if (t.orphan) out.push({ rule: "orphan", where: where(t), detail: `the ${t.role} ends on one word alone`, fix: "auto", slide: t.slide ?? undefined });
  // Spacing: text inside a 3.5% safe margin of its frame.
  for (const t of m.texts) {
    // Labels are left out: the foot line lives in the slide's bottom margin by design.
    if (!t.frame || o.phone || t.role === "label") continue;
    const [fx, fy, fw, fh] = t.frame;
    const [x, y, w, h] = t.rect;
    const pad = fw * 0.035;
    // A deck's foot line (the title and the slide number) owns the bottom 6% of the slide: text there collides with it.
    const bottom = medium === "deck" ? fw * 0.06 : pad * 0.6;
    if (x - fx < pad - 1 || fx + fw - (x + w) < pad - 1 || y - fy < pad * 0.6 - 1 || fy + fh - (y + h) < bottom - 1) out.push({ rule: "spacing", where: where(t), detail: `the ${t.role} sits inside the slide's safe margin`, fix: "auto", slide: t.slide ?? undefined });
  }
  // Type scale.
  const bySlide = new Map<string, TextM[]>();
  for (const t of m.texts) bySlide.set(String(t.slide), [...(bySlide.get(String(t.slide)) ?? []), t]);
  const minBody = o.phone ? 15 : medium === "deck" ? 18 : medium === "page" ? 14 : 13.3;
  // Labels (slide numbers, the foot line, small capitals) read at 11px at least, everywhere.
  // (Print labels, a document's small capitals, are judged by contrast only: their size is set for paper.)
  for (const t of m.texts)
    if (medium !== "doc" && t.role === "label" && t.size < 11 - 0.05) {
      out.push({ rule: "type_scale", where: where(t), detail: `a label at ${t.size.toFixed(1)}px is under 11px`, fix: "auto", slide: t.slide ?? undefined, role: "label", view: o.phone ? "phone" : undefined });
      break;
    }
  for (const [, ts] of bySlide) {
    const head = Math.max(0, ...ts.filter((t) => /^h[12]$/.test(t.role)).map((t) => t.size));
    const bodies = ts.filter((t) => t.role === "body").map((t) => t.size);
    const body = bodies.length ? Math.max(...bodies) : 0;
    const ratio = medium === "deck" ? 1.6 : 1.25;
    if (head && body && head / body < ratio && !o.phone) out.push({ rule: "type_scale", where: where(ts[0]), detail: `headline ${head.toFixed(0)}px over body ${body.toFixed(0)}px is a flat scale (${(head / body).toFixed(2)}x, wants ${ratio}x)`, fix: "auto", slide: ts[0].slide ?? undefined });
    for (const b of bodies) if (b < minBody - 0.05) {
      out.push({ rule: medium === "doc" ? "print_type" : "type_scale", where: where(ts[0]), detail: `body type at ${b.toFixed(1)}px is under ${minBody}px`, fix: "auto", slide: ts[0].slide ?? undefined, view: o.phone ? "phone" : undefined });
      break;
    }
  }
  const sizes = new Set(m.texts.filter((t) => t.role !== "label").map((t) => Math.round(t.size)));
  if (sizes.size > 8 && !o.phone) out.push({ rule: "type_scale", where: "the whole thing", detail: `${sizes.size} type sizes in play; a scale wants five or six`, fix: "none" });
  // Images.
  for (const im of m.imgs) {
    const up = Math.max(im.shown[0] / im.natural[0], im.shown[1] / im.natural[1]);
    // The finding names the logo (design audit: the title slide's tiny logo was found and never fixed, its finding didn't say "logo").
    if (up > 1.35) out.push({ rule: "image", where: where(im), detail: `${im.logo ? "the logo" : "an image"} shown at ${up.toFixed(1)}x its own pixels (${im.natural[0]}x${im.natural[1]}) will look soft`, fix: "auto", slide: im.slide ?? undefined, role: im.logo ? "logo" : "image" });
    if (im.crop?.mismatch && !im.logo) out.push({ rule: "image", where: where(im), detail: `the picture is cropped to ${Math.round(im.crop.shown * 100)}% of it: its shape is far from its box's`, fix: "auto", slide: im.slide ?? undefined, role: "crop" });
    if (im.edge) out.push({ rule: "image", where: where(im), detail: "the logo touches the edge of its frame", fix: "auto", slide: im.slide ?? undefined });
  }
  // The craft bar (founder's brief, 2026-10-12): no literal placeholder in anything shown, no label cut off (the phone pass included),
  // logo chips drawn at their own shape, uncut, on a transparent ground or a plate.
  for (const t of m.texts) {
    const ph = t.text ? placeholderIn(t.text) : null;
    if (ph) out.push({ rule: "craft", where: where(t), detail: `"${ph}" is a placeholder in what ships`, fix: "co", slide: t.slide ?? undefined });
    if (t.clipped) out.push({ rule: "craft", where: where(t), detail: `the ${t.role} "${(t.text ?? "").slice(0, 40)}" is cut off`, fix: "none", slide: t.slide ?? undefined, role: t.role, view: o.phone ? "phone" : undefined });
  }
  for (const im of m.imgs.filter((x) => x.logo)) {
    if (im.distorted) out.push({ rule: "craft", where: where(im), detail: "the logo is stretched off its own shape", fix: "auto", slide: im.slide ?? undefined, role: "logo_shape" });
    if (im.clipped) out.push({ rule: "craft", where: where(im), detail: "the logo is cut off by its box", fix: "auto", slide: im.slide ?? undefined, role: "logo_clip" });
    if (im.box) out.push({ rule: "craft", where: where(im), detail: `the logo sits on a box of its own color (${im.box}) instead of a plate`, fix: "auto", slide: im.slide ?? undefined, role: "logo_box", color: im.box });
  }
  // Composition (decks): read off the rendered layouts too, each with how many points it carries.
  if (medium === "deck" && !o.phone) {
    const comp = compositionProblem(m.frames.filter((f) => f.layout && f.slide && f.slide >= 2).map((f) => ({ layout: f.layout!, bullets: f.points ?? 3 })));
    if (comp) out.push({ rule: "composition", where: "the whole thing", detail: comp, fix: "co" });
  }
  // No artifact ships with zero images.
  if (medium !== "doc" && m.pictures === 0) out.push({ rule: "imagery", where: "the whole thing", detail: "it shows no picture at all (no photo, map, logo or plate)", fix: "none" });
  // Docs: print line length and page breaks.
  if (medium === "doc") {
    for (const t of m.texts.filter((x) => x.role === "body" && x.words > 12)) {
      const perLine = t.rect[2] / (t.size * 0.5);
      if (perLine > 100) {
        out.push({ rule: "print_type", where: "the page", detail: `lines run about ${Math.round(perLine)} characters; print wants 45 to 90`, fix: "none" });
        break;
      }
    }
    const ph = o.printPageHeightPx ?? 0;
    if (ph && m.secs) for (const h of strandedHeads(m.secs, ph)) out.push({ rule: "page_break", where: `"${h}"`, detail: "a heading sits at the foot of a page, apart from what it heads", fix: "auto" });
    else if (ph)
      for (const h of m.heads) {
        const into = h.top % ph;
        if (into > ph * 0.86) out.push({ rule: "page_break", where: `"${h.text}"`, detail: "a heading sits at the foot of a page, apart from what it heads", fix: "auto" });
      }
  }
  if (!m.fontsLoaded) out.push({ rule: "render", where: "fonts", detail: "the web fonts didn't load, so it rendered in the fallback faces", fix: "none" });
  return dedupe(out);
}
const dedupe = (fs: QaFinding[]) => [...new Map(fs.map((f) => [`${f.rule}|${f.where}|${f.detail.slice(0, 30)}`, f])).values()];

// Pure: content rules from the data, before anything renders. Decks one idea per slide; pages scannable; docs readable in print.
export function contentFindings(medium: QaMedium, data: any): QaFinding[] {
  const out: QaFinding[] = [];
  const words = (s: string) => String(s ?? "").trim().split(/\s+/).filter(Boolean).length;
  if (medium === "deck") {
    (data?.slides ?? []).forEach((s: any, i: number) => {
      const n = i + 2;
      const total = words(s.headline) + (s.bullets ?? []).reduce((a: number, b: string) => a + words(b), 0);
      if ((s.bullets ?? []).length > 4) out.push({ rule: "one_idea", where: `slide ${n}`, detail: `${s.bullets.length} points on one slide; keep it to the one idea and at most 4 points, or split it`, fix: "co", slide: n });
      // The schema allows 4 points of up to 160 characters (about 110 words with the headline): QA asks for less only past that.
      else if (total > 110) out.push({ rule: "one_idea", where: `slide ${n}`, detail: `${total} words on one slide; cut it to the one idea (under 110 words)`, fix: "co", slide: n });
      if (words(s.headline) > 14) out.push({ rule: "one_idea", where: `slide ${n}`, detail: "the headline is a paragraph; say the one point in under 14 words", fix: "co", slide: n });
    });
    // The composition rule, after code has re-laid what it can (art.ts composeLayouts): what's left goes back to Co to rewrite.
    const slides = data?.slides ?? [];
    if (slides.length >= 2) {
      const { composeLayouts } = artMod;
      const ls = composeLayouts(slides.map((s: any) => ({ bullets: s.bullets ?? [], image: s.image ?? null, photos: s.photos, map: s.map, layout: s.layout })), data?.style?.grammar ?? "editorial").layouts;
      const comp = compositionProblem(ls.map((l: string, i: number) => ({ layout: l, bullets: (slides[i].bullets ?? []).length })));
      if (comp) out.push({ rule: "composition", where: "the whole thing", detail: comp, fix: "co" });
    }
  }
  if (medium === "page") {
    (data?.sections ?? []).forEach((s: any, i: number) => {
      for (const b of s.blocks ?? []) if (b.type === "text" && words(b.text) > 90) out.push({ rule: "scannability", where: `section ${i + 1}`, detail: "a paragraph over 90 words; break it into points", fix: "co" });
      if ((s.blocks ?? []).length > 4) out.push({ rule: "scannability", where: `section ${i + 1}`, detail: "more than 4 blocks under one heading", fix: "co" });
    });
  }
  if (medium === "doc") {
    (data?.sections ?? []).forEach((s: any, i: number) => {
      for (const p of s.paragraphs ?? []) if (words(p) > 120) out.push({ rule: "scannability", where: `section ${i + 1}`, detail: "a paragraph over 120 words", fix: "co" });
    });
  }
  return out;
}

// A document is measured at its printed content width (Letter less the 1in side margins: 6.5in, 624px) and its printed page height
// (11in less the 0.8in and 0.95in margins: 888px), so line lengths and where headings fall are what print gives (design audit: the
// 816px render missed a heading stranded at a page foot).
export const DOC_CONTENT = { width: 624, pageHeight: 888 } as const;
const VIEW: Record<QaMedium, { width: number; height: number }> = { deck: { width: 1280, height: 720 }, page: { width: 1280, height: 900 }, doc: { width: DOC_CONTENT.width, height: 1056 } };
export const PHONE_VIEW = { width: 390, height: 844 } as const;

// Renders the HTML, screenshots it and measures it. Null measure when Chrome isn't there (the caller sends without QA and says so in
// its log, never that QA passed).
// phone: rendered at 390px as a phone shows it (a deck's slides as the phone layout, not the 1280x720 frame).
export async function qaRender(html: string, medium: QaMedium, o: { width?: number; screenshot?: boolean; phone?: boolean } = {}): Promise<{ measure: Measure; screenshot: Buffer | null } | null> {
  const B = await import("./browserRead.js");
  if (!B.browserReadEnabled()) return null;
  const release = await B.browserSlot();
  let context: any = null;
  try {
    const browser = await B.sharedBrowser();
    const view = o.phone ? { ...PHONE_VIEW } : { ...VIEW[medium], ...(o.width ? { width: o.width } : {}) };
    context = await browser.newContext({ javaScriptEnabled: true, viewport: view, deviceScaleFactor: 1 });
    await context.route("**/*", (route: any) => {
      const u = route.request().url();
      let host = "";
      try {
        host = new URL(u).hostname;
      } catch {}
      return u.startsWith("data:") || u === "about:blank" || ["fonts.googleapis.com", "fonts.gstatic.com", "api.fontshare.com", "cdn.fontshare.com"].includes(host) ? route.continue() : route.abort();
    });
    const pg = await context.newPage();
    // Decks are measured one slide to the screen, as print lays them out.
    const doc = medium === "deck" && !o.phone ? html.replace("</style>", ".slide{min-height:0!important;height:720px;padding:0!important}.frame{width:1280px!important;height:720px!important;aspect-ratio:auto!important;border-radius:0!important;box-shadow:none!important}.dl{display:none}.notes{display:none}</style>") : html;
    await pg.setContent(doc, { waitUntil: "load", timeout: 15_000 });
    if (medium === "doc") await pg.emulateMedia({ media: "print" });
    await Promise.race([pg.evaluate("document.fonts && document.fonts.ready"), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
    // Every picture decoded before it's measured and shot (a full-page shot left decoding-async pictures blank).
    await Promise.race([pg.evaluate("Promise.all([...document.images].map((i) => i.decode().catch(() => {})))"), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
    const { inPage } = await import("./designRead.js");
    const measure = (await pg.evaluate(inPage(measureInPage, medium))) as Measure;
    const screenshot = o.screenshot === false ? null : Buffer.from(await pg.screenshot({ fullPage: true, type: "png" }));
    return { measure, screenshot };
  } catch (err: any) {
    console.error("designQa: render failed (non-fatal):", err?.message ?? err);
    return null;
  } finally {
    await context?.close().catch(() => {});
    release();
  }
}

// The whole check for one medium: content rules, then the render's measures. Letter at 96 dpi less the doc's margins is one page.
// phone: also measure at 390px (decks and pages); its findings join the rest, each saying "on a phone".
export async function runQa(html: string, medium: QaMedium, data: unknown, o: { screenshot?: boolean; phone?: boolean } = {}): Promise<QaResult> {
  const content = contentFindings(medium, data);
  const r = await qaRender(html, medium, o.phone ? { ...o, phone: false } : o);
  if (!r) return { ran: false, findings: content, screenshot: null, measured: 0 };
  const findings = [...content, ...qaFindings(r.measure, medium, medium === "doc" ? { printPageHeightPx: DOC_CONTENT.pageHeight } : {})];
  let phone: Buffer | null = null;
  if (o.phone && medium !== "doc") {
    const p = await qaRender(html, medium, { ...o, phone: true });
    if (p) {
      findings.push(...qaFindings(p.measure, medium, { phone: true }).filter((f) => f.rule !== "orphan" || medium === "page"));
      phone = p.screenshot;
    }
  }
  return { ran: true, findings: dedupe(findings), screenshot: r.screenshot, measured: r.measure.texts.length + r.measure.imgs.length, phone };
}

// Pure: the findings that still stand once code has done what it can: everything but the check's own trouble (fonts the QA browser
// couldn't load). First-shot acceptance counts these (designSystem.ts metrics).
export const unresolved = (fs: QaFinding[]) => fs.filter((f) => f.rule !== "render");

// Pure: one plain line for the delivery text when something still isn't right after the fixes (design audit: QA found contrast and blur
// and the deck went out silently). Null when nothing is left.
export function qaShortfall(fs: QaFinding[]): string | null {
  const left = unresolved(fs);
  if (!left.length) return null;
  const say = (f: QaFinding): string => {
    const at = f.where.replace(/^the whole thing$/, "the deck");
    if (f.rule === "contrast") return f.role === "label" ? `the small labels on ${at} are harder to read than they should be` : `the text on ${at} is harder to read than it should be`;
    if (f.rule === "overflow" || f.rule === "spacing") return `${at} is crowded`;
    if (f.rule === "image") return f.role === "crop" ? `the picture on ${at} is cropped tight` : `${f.role === "logo" ? "the logo" : "a picture"} on ${at} is softer than it should be`;
    if (f.rule === "type_scale" || f.rule === "print_type") return `the type on ${at} is smaller or flatter than it should be`;
    if (f.rule === "page_break") return `a heading lands at the foot of a page`;
    if (f.rule === "orphan") return `a headline on ${at} ends on a word alone`;
    if (f.rule === "one_idea") return `${at} carries more than one idea`;
    if (f.rule === "scannability") return `${at} is dense to read`;
    if (f.rule === "craft") return f.role?.startsWith("logo") ? `the logo on ${at} isn't set cleanly` : /placeholder/.test(f.detail) ? `${at} still has a placeholder` : `a label on ${at} is cut off`;
    if (f.rule === "composition") return "too many slides share one layout";
    if (f.rule === "imagery") return "it has no pictures yet";
    return `${at}: ${f.detail}`;
  };
  const items = [...new Set(left.map(say))];
  const n = items.length;
  const head = n === 1 ? "One thing I couldn't fix yet" : `${n > 3 ? "A few" : n === 2 ? "Two" : "Three"} things I couldn't fix yet`;
  const list = items.slice(0, 3);
  return `${head}: ${list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0]}.`;
}

// Pure: the findings in a few words for a log or Co's tool result.
export function qaSummary(r: QaResult): string {
  if (!r.ran) return "Design QA couldn't render it just now (no browser), so it went unchecked.";
  if (!r.findings.length) return `Design QA passed: ${r.measured} text runs and images measured, nothing off.`;
  return `Design QA: ${r.findings.slice(0, 6).map((f) => `${f.where}: ${f.detail}`).join("; ")}.`;
}

// Pure: a color moved toward black (amount < 0) or white (amount > 0).
function towards(hex: string, amount: number): string {
  const to = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) + (to - parseInt(hex.slice(i, i + 2), 16)) * t).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
// Pure: a color's HSL lightness moved by an amount (-1..1), its hue and saturation kept.
function lighter(hex: string, amount: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  const L = Math.min(1, Math.max(0, l + amount));
  const q = L < 0.5 ? L * (1 + s) : L + s - L * s, p = 2 * L - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  const out = s === 0 ? [L, L, L] : [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  return `#${out.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
// Pure: a color shaded toward black or white, whichever reads, until it reaches the ratio on a ground.
// alpha: the share of the color that shows (its opacity), so the blended color is what has to read.
export function inkFor(color: string, ground: string, min: number, alpha = 1): string {
  const reads = (c: string) => contrast(blend(c, ground, alpha), ground) >= min;
  if (reads(color)) return color;
  const dark = contrast("#000000", ground) > contrast("#FFFFFF", ground);
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = towards(color, dark ? -t : t);
    if (reads(c)) return c;
  }
  return dark ? "#000000" : "#FFFFFF";
}
// Pure: a field (a color or both ends of a gradient) its ink reads on at the ratio asked: only the end that fails moves, the least it
// has to, away from the ink, in lightness only (its hue and saturation kept, so a coral deepens as a coral rather than browning toward
// black). Null when nothing within reach works.
export function fieldFor(stops: string[], prefer: string[], need: number, alpha = 1): { stops: string[]; ink: string } | null {
  let best: { stops: string[]; ink: string; cost: number } | null = null;
  for (const ink of [...new Set([...prefer, "#FFFFFF", "#111111"])]) {
    let cost = 0;
    const reads = (g: string) => contrast(blend(ink, g, alpha), g) >= need;
    const next = stops.map((st) => {
      if (reads(st)) return st;
      const away = contrast(ink, "#000000") > contrast(ink, "#FFFFFF") ? -1 : 1;
      for (let t = 0.02; t <= 0.6001; t += 0.02) {
        const c = lighter(st, away * t);
        if (reads(c)) {
          cost += t;
          return c;
        }
      }
      cost += 99;
      return st;
    });
    // The renderer picks the field's ink the same way (deck.ts fieldInk), so it must land on this one.
    if (cost < 99 && inkOn(next, prefer) === ink.toUpperCase() && (!best || cost < best.cost)) best = { stops: next, ink, cost };
  }
  return best ? { stops: best.stops, ink: best.ink } : null;
}

// Pure: the fixes code makes on a deck from its findings, in plain words:
//   - type that ran over or crowds its margin steps down (tight, tighter, tightest; never under the type floor), and a slide still over
//     after the last step is split in two;
//   - text that doesn't read is re-inked on paper, and on a color field the gradient end it fails moves until it reads;
//   - a picture shown past its pixels is placed small (the logo on the title slide too, at its own pixels), a picture cropped hard is
//     shown whole on a plate, a logo touching its frame goes on a plate.
export function applyDeckFixes(data: any, findings: QaFinding[]): { data: any; fixed: string[] } {
  const next = JSON.parse(JSON.stringify(data));
  const fixed: string[] = [];
  const STEPS = ["tight", "tighter", "tightest"];
  const split: number[] = [];
  const stepped = new Set<number>();
  const st = next.style ?? {};
  // What the findings measured against: the look as it came in (each fix below moves the copy).
  const text0 = st.text;
  const stops0 = st.gradient && st.accent2 ? [st.accent, st.accent2] : [st.accent];
  for (const f of findings) {
    if (f.fix !== "auto") continue;
    const sl = f.slide && f.slide >= 2 ? next.slides[f.slide - 2] : null;
    if ((f.rule === "overflow" || f.rule === "spacing") && sl && f.view !== "phone") {
      if (stepped.has(f.slide!)) continue;
      stepped.add(f.slide!);
      const at = STEPS.indexOf(sl.fit ?? "");
      if (at < STEPS.length - 1) {
        sl.fit = STEPS[at + 1];
        fixed.push(`slide ${f.slide}: type stepped down a size (${f.rule})`);
      } else if (sl.bullets.length >= 2) split.push(f.slide! - 2);
    } else if (f.rule === "contrast" && f.color && f.ground?.length && f.need) {
      const stops = st.gradient && st.accent2 ? [st.accent, st.accent2] : [st.accent];
      const onField = f.ground.length > 1 ? f.ground.every((g, i) => g === stops0[i]) : f.ground[0] !== st.background && f.ground[0] === stops0[0];
      // A label (the foot line, slide numbers) is the renderer's to fix, never by re-inking their whole text color.
      if (f.role === "label") continue;
      if (!onField && f.ground[0] === st.background && f.color === text0) {
        const ink = inkFor(st.text, st.background, f.need, f.alpha ?? 1);
        if (ink !== st.text) {
          st.text = ink;
          fixed.push("the text is re-inked so it reads on the paper");
        }
      } else if (onField && st.accent) {
        const got = fieldFor(stops, [st.text, st.background], f.need, f.alpha ?? 1);
        if (got && got.stops.some((x, i) => x !== stops[i])) {
          st.accent = got.stops[0];
          if (got.stops[1]) st.accent2 = got.stops[1];
          fixed.push(`the color field is deepened a little so its ${got.ink === "#FFFFFF" ? "white" : "dark"} type reads`);
        }
      }
    } else if (f.rule === "image" && f.role === "logo" && next.logo) {
      const m = next.logoMeta ?? { fit: "full", ground: null, ink: null, mono: false };
      // A logo on its plate keeps the plate (it was cropped to its edges); the finding then stands and is said.
      if (m.fit !== "small" && m.fit !== "plate") {
        next.logoMeta = { ...m, fit: "small" };
        fixed.push("the logo is drawn at its own size so it stays sharp");
      }
    } else if (f.rule === "craft" && f.role?.startsWith("logo") && next.logo) {
      // A logo off its shape or cut off is drawn whole at its own proportions; one on a box of its own color sits on a plate of that color.
      const m = next.logoMeta ?? { fit: "full", ground: null, ink: null, mono: false };
      if (f.role === "logo_box" && f.color && m.fit !== "plate") {
        next.logoMeta = { ...m, fit: "plate", ground: f.color };
        fixed.push("the logo now sits on a plate of its own color");
      } else if (f.role !== "logo_box" && m.fit !== "small") {
        next.logoMeta = { ...m, fit: "small" };
        fixed.push("the logo is drawn whole at its own shape");
      }
    } else if (f.rule === "image" && /touches the edge/.test(f.detail) && next.logo) {
      next.logoMeta = { ...(next.logoMeta ?? { ground: null, ink: null, mono: false }), fit: "plate" };
      fixed.push("the logo now sits on a plate with room around it");
    } else if (f.rule === "image" && f.role === "crop" && sl?.image && sl.imageMeta?.fit !== "plate" && sl.imageMeta?.fit !== "small") {
      sl.imageMeta = { ...(sl.imageMeta ?? { ground: null, ink: null, mono: false }), fit: "plate" };
      fixed.push(`slide ${f.slide}: the picture is shown whole instead of cropped`);
    } else if (f.rule === "image" && sl?.image && f.role !== "crop" && sl.imageMeta?.fit !== "small") {
      sl.imageMeta = { ...(sl.imageMeta ?? { ground: null, ink: null, mono: false }), fit: "small" };
      fixed.push(`slide ${f.slide}: the image is placed small instead of stretched`);
    }
  }
  // Split last first, so earlier indexes hold. The same headline carries on; its picture and notes stay with the first half.
  // Never past 15 slides (a split that pushed the last slide, usually the closing ask, off the deck): the slide stays at its tightest
  // and the delivery line says it's crowded.
  for (const i of [...new Set(split)].sort((a, b) => b - a)) {
    if (next.slides.length >= 15) break;
    const sl = next.slides[i];
    const half = Math.ceil(sl.bullets.length / 2);
    const a = { ...sl, bullets: sl.bullets.slice(0, half), fit: "tight" };
    const b: any = { headline: sl.headline, bullets: sl.bullets.slice(half), image: null, fit: "tight" };
    next.slides.splice(i, 1, a, b);
    fixed.push(`slide ${i + 2}: split in two so it fits`);
  }

  return { data: next, fixed: [...new Set(fixed)] };
}

// A deck's QA: render with its own images inlined, check, fix what code can, and measure again until nothing more can be fixed (six
// rounds at most: three steps down and a split, twice over); then the phone pass. The findings left are what's logged, and said in one line with the link (qaShortfall).
export async function qaDeck(data: any, images: Map<string, { data: Buffer; mediaType: string }>, o: { screenshot?: boolean; phone?: boolean; art?: { src: (ref: string) => string | null; credit: (p: any) => any } } = {}): Promise<{ data: any; first: QaResult; final: QaResult; fixed: string[] }> {
  const { renderDeck } = await import("./coPages/deck.js");
  const html = (d: any) => renderDeck({ id: "q".repeat(24), data: d, updatedAt: new Date() }, { url: null, showNotes: false, artSrc: o.art?.src ?? (() => null), credit: o.art?.credit ?? (() => null), imageSrc: (id) => {
    const im = images.get(id);
    return im ? `data:${im.mediaType};base64,${im.data.toString("base64")}` : null;
  } });
  const first = await runQa(html(data), "deck", data, { ...o, phone: false });
  if (!first.ran) return { data, first, final: first, fixed: [] };
  let cur = data;
  let last = first;
  const fixed: string[] = [];
  for (let round = 0; round < 6; round++) {
    const r = applyDeckFixes(cur, last.findings);
    if (!r.fixed.length) break;
    cur = r.data;
    fixed.push(...r.fixed);
    last = await runQa(html(cur), "deck", cur, { ...o, phone: false });
    if (!last.ran) break;
  }
  const phone = o.phone === false ? null : await runQa(html(cur), "deck", cur, { ...o, phone: true });
  const final: QaResult = phone?.ran ? { ...last, findings: dedupe([...last.findings, ...phone.findings.filter((f) => f.view === "phone" || /on a phone/.test(f.where))]), phone: phone.phone } : last;
  return { data: cur, first, final, fixed: [...new Set(fixed)] };
}

// A page's QA, at laptop and phone width, with its images inlined (imageSrc) so they're really measured. What code can fix on a page
// is fixed: text that doesn't read is re-inked (its style), and measured again. Headlines never end on one word (template.ts).
export async function qaPage(data: any, render: (d: any) => string, o: { screenshot?: boolean } = {}): Promise<{ data: any; first: QaResult; final: QaResult; fixed: string[] }> {
  const first = await runQa(render(data), "page", data, { ...o, phone: true });
  if (!first.ran) return { data, first, final: first, fixed: [] };
  const fixed: string[] = [];
  const next = JSON.parse(JSON.stringify(data));
  const st = next.style;
  if (st) {
    const text0 = st.text;
    for (const f of first.findings) {
      if (f.rule !== "contrast" || !f.color || !f.ground?.length || f.role === "label") continue;
      if (f.ground[0] === st.background && f.color === text0) {
        const ink = inkFor(st.text, st.background, f.need ?? 4.5, f.alpha ?? 1);
        if (ink !== st.text) {
          st.text = ink;
          fixed.push("the text is re-inked so it reads on the paper");
        }
      }
    }
  }
  if (!fixed.length) return { data, first, final: first, fixed };
  const final = await runQa(render(next), "page", next, { ...o, phone: true });
  return { data: next, first, final, fixed: [...new Set(fixed)] };
}
