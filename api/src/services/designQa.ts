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
import { contrast } from "./coPages/style.js";

export type QaMedium = "deck" | "page" | "doc";
export type QaFinding = { rule: "type_scale" | "spacing" | "contrast" | "overflow" | "orphan" | "image" | "one_idea" | "scannability" | "print_type" | "page_break" | "render"; where: string; detail: string; fix: "auto" | "co" | "none"; slide?: number };
export type QaResult = { ran: boolean; findings: QaFinding[]; screenshot: Buffer | null; measured: number };

type TextM = { role: string; size: number; color: string; ground: string[]; slide: number | null; rect: [number, number, number, number]; frame: [number, number, number, number] | null; orphan: boolean; chars: number; words: number };
type ImgM = { natural: [number, number]; shown: [number, number]; slide: number | null; logo: boolean; edge: boolean };
type FrameM = { slide: number | null; overflow: boolean; layout: string | null };
type HeadM = { top: number; text: string };
export type Measure = { texts: TextM[]; imgs: ImgM[]; frames: FrameM[]; heads: HeadM[]; pageHeight: number; fontsLoaded: boolean };

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
  const textEls = [...document.querySelectorAll(medium === "deck" ? "[data-qa-text]" : "h1, h2, h3, p, li, dd, .ln, .lnote")].filter((el) => (el.textContent ?? "").trim());
  const texts: TextM[] = textEls.map((el) => {
    const cs = getComputedStyle(el);
    const role = el.getAttribute("data-qa-text") ?? (/^H[1-3]$/.test(el.tagName) ? el.tagName.toLowerCase() : "body");
    const f = frameOf(el);
    const words = (el.textContent ?? "").trim().split(/\s+/).length;
    return { role, size: parseFloat(cs.fontSize), color: rgb(cs.color), ground: groundOf(el), slide: slideOf(el), rect: rectOf(el), frame: f ? rectOf(f) : null, orphan: /^h[12]$/.test(role) ? orphanOf(el) : false, chars: (el.textContent ?? "").length, words };
  });
  const imgs: ImgM[] = [...document.querySelectorAll("img")].map((im) => {
    const r = im.getBoundingClientRect();
    const f = frameOf(im);
    const fr = f?.getBoundingClientRect();
    const edge = !!fr && (r.left - fr.left < 2 || fr.right - r.right < 2 || r.top - fr.top < 2 || fr.bottom - r.bottom < 2);
    // The size it's drawn at: object-fit contain draws inside the box.
    const fit = getComputedStyle(im).objectFit;
    const nw = im.naturalWidth || 1, nh = im.naturalHeight || 1;
    const k = fit === "contain" || fit === "scale-down" ? Math.min(r.width / nw, r.height / nh) : fit === "cover" ? Math.max(r.width / nw, r.height / nh) : r.width / nw;
    return { natural: [nw, nh], shown: [nw * k, nh * k], slide: slideOf(im), logo: /\blogo\b/.test(im.className), edge: edge && /\blogo\b/.test(im.className) };
  });
  const frameM: FrameM[] = frames.map((f) => {
    const fr = f.getBoundingClientRect();
    const over = [...f.querySelectorAll("[data-qa-text]")].some((t) => {
      const r = t.getBoundingClientRect();
      return r.bottom > fr.bottom + 1 || r.right > fr.right + 1;
    });
    const n = f.getAttribute("data-qa-slide");
    return { slide: n ? Number(n) : 1, overflow: over || (f as HTMLElement).scrollHeight > (f as HTMLElement).clientHeight + 2, layout: f.getAttribute("data-qa-layout") };
  });
  const heads = [...document.querySelectorAll("h2, h3")].map((h) => ({ top: h.getBoundingClientRect().top + scrollY, text: (h.textContent ?? "").slice(0, 60) }));
  const fontsLoaded = [...(document as any).fonts].some((f: any) => f.status === "loaded");
  return { texts, imgs, frames: frameM, heads, pageHeight: document.documentElement.scrollHeight, fontsLoaded };
}

// Pure: the findings from a measure, per medium. Type limits are in CSS px at the size QA renders at (decks 1280 wide).
export function qaFindings(m: Measure, medium: QaMedium, o: { printPageHeightPx?: number } = {}): QaFinding[] {
  const out: QaFinding[] = [];
  const where = (t: { slide: number | null }) => (t.slide ? `slide ${t.slide}` : "the page");
  // Overflow.
  for (const f of m.frames) if (f.overflow) out.push({ rule: "overflow", where: `slide ${f.slide}`, detail: "text runs past the slide", fix: "auto", slide: f.slide ?? undefined });
  // Contrast: on every stop of its ground.
  for (const t of m.texts) {
    const worst = Math.min(...t.ground.map((g) => contrast(t.color, g)));
    const need = t.size >= 24 ? 3 : 4.5;
    if (worst < need) out.push({ rule: "contrast", where: where(t), detail: `${t.role} ${t.color} on ${t.ground.join(" to ")} is ${worst.toFixed(1)}:1 (needs ${need}:1)`, fix: "auto", slide: t.slide ?? undefined });
  }
  // Orphans.
  for (const t of m.texts) if (t.orphan) out.push({ rule: "orphan", where: where(t), detail: `the ${t.role} ends on one word alone`, fix: "auto", slide: t.slide ?? undefined });
  // Spacing: text inside a 3.5% safe margin of its frame.
  for (const t of m.texts) {
    if (!t.frame) continue;
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
  const minBody = medium === "deck" ? 18 : medium === "page" ? 14 : 13.3;
  for (const [, ts] of bySlide) {
    const head = Math.max(0, ...ts.filter((t) => /^h[12]$/.test(t.role)).map((t) => t.size));
    const bodies = ts.filter((t) => t.role === "body").map((t) => t.size);
    const body = bodies.length ? Math.max(...bodies) : 0;
    const ratio = medium === "deck" ? 1.6 : 1.25;
    if (head && body && head / body < ratio) out.push({ rule: "type_scale", where: where(ts[0]), detail: `headline ${head.toFixed(0)}px over body ${body.toFixed(0)}px is a flat scale (${(head / body).toFixed(2)}x, wants ${ratio}x)`, fix: "auto", slide: ts[0].slide ?? undefined });
    for (const b of bodies) if (b < minBody) {
      out.push({ rule: medium === "doc" ? "print_type" : "type_scale", where: where(ts[0]), detail: `body type at ${b.toFixed(1)}px is under ${minBody}px`, fix: "auto", slide: ts[0].slide ?? undefined });
      break;
    }
  }
  const sizes = new Set(m.texts.map((t) => Math.round(t.size)));
  if (sizes.size > 8) out.push({ rule: "type_scale", where: "the whole thing", detail: `${sizes.size} type sizes in play; a scale wants five or six`, fix: "none" });
  // Images.
  for (const im of m.imgs) {
    const up = Math.max(im.shown[0] / im.natural[0], im.shown[1] / im.natural[1]);
    if (up > 1.35) out.push({ rule: "image", where: where(im), detail: `an image shown at ${up.toFixed(1)}x its own pixels (${im.natural[0]}x${im.natural[1]}) will look soft`, fix: "auto", slide: im.slide ?? undefined });
    if (im.edge) out.push({ rule: "image", where: where(im), detail: "the logo touches the edge of its frame", fix: "auto", slide: im.slide ?? undefined });
  }
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
    if (ph) for (const h of m.heads) {
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

const VIEW: Record<QaMedium, { width: number; height: number }> = { deck: { width: 1280, height: 720 }, page: { width: 1280, height: 900 }, doc: { width: 816, height: 1056 } };

// Renders the HTML, screenshots it and measures it. Null measure when Chrome isn't there (the caller sends without QA and says so in
// its log, never that QA passed).
export async function qaRender(html: string, medium: QaMedium, o: { width?: number; screenshot?: boolean } = {}): Promise<{ measure: Measure; screenshot: Buffer | null } | null> {
  const B = await import("./browserRead.js");
  if (!B.browserReadEnabled()) return null;
  const release = await B.browserSlot();
  let context: any = null;
  try {
    const browser = await B.sharedBrowser();
    const view = { ...VIEW[medium], ...(o.width ? { width: o.width } : {}) };
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
    const doc = medium === "deck" ? html.replace("</style>", ".slide{min-height:0!important;height:720px;padding:0!important}.frame{width:1280px!important;height:720px!important;aspect-ratio:auto!important;border-radius:0!important;box-shadow:none!important}.dl{display:none}.notes{display:none}</style>") : html;
    await pg.setContent(doc, { waitUntil: "load", timeout: 15_000 });
    if (medium === "doc") await pg.emulateMedia({ media: "print" });
    await Promise.race([pg.evaluate("document.fonts && document.fonts.ready"), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
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
export async function runQa(html: string, medium: QaMedium, data: unknown, o: { screenshot?: boolean } = {}): Promise<QaResult> {
  const content = contentFindings(medium, data);
  const r = await qaRender(html, medium, o);
  if (!r) return { ran: false, findings: content, screenshot: null, measured: 0 };
  const findings = [...content, ...qaFindings(r.measure, medium, medium === "doc" ? { printPageHeightPx: 1056 - 1.75 * 96 } : {})];
  return { ran: true, findings, screenshot: r.screenshot, measured: r.measure.texts.length + r.measure.imgs.length };
}

// Pure: the findings in a few words for a log or Co's tool result.
export function qaSummary(r: QaResult): string {
  if (!r.ran) return "Design QA couldn't render it just now (no browser), so it went unchecked.";
  if (!r.findings.length) return `Design QA passed: ${r.measured} text runs and images measured, nothing off.`;
  return `Design QA: ${r.findings.slice(0, 6).map((f) => `${f.where}: ${f.detail}`).join("; ")}.`;
}

// Pure: the fixes code makes on a deck from its findings: a slide that ran over or crowds its margin steps its type down; an image
// shown past its pixels is placed small; a logo touching its frame goes on a plate. What changed is returned in plain words.
export function applyDeckFixes(data: any, findings: QaFinding[]): { data: any; fixed: string[] } {
  const next = JSON.parse(JSON.stringify(data));
  const fixed: string[] = [];
  for (const f of findings) {
    if (f.fix !== "auto") continue;
    const sl = f.slide && f.slide >= 2 ? next.slides[f.slide - 2] : null;
    if ((f.rule === "overflow" || f.rule === "spacing" || f.rule === "orphan") && sl && sl.fit !== "tight") {
      sl.fit = "tight";
      fixed.push(`slide ${f.slide}: type stepped down a size (${f.rule})`);
    } else if (f.rule === "image" && /logo/.test(f.detail) && next.logo) {
      next.logoMeta = { ...(next.logoMeta ?? { ground: null, ink: null, mono: false }), fit: "plate" };
      fixed.push("the logo now sits on a plate with room around it");
    } else if (f.rule === "image" && sl?.image && sl.imageMeta?.fit !== "small") {
      sl.imageMeta = { ...(sl.imageMeta ?? { ground: null, ink: null, mono: false }), fit: "small" };
      fixed.push(`slide ${f.slide}: the image is placed small instead of stretched`);
    }
  }
  return { data: next, fixed: [...new Set(fixed)] };
}

// A deck's QA: render with its own images inlined, check, fix what code can, check once more. The findings left are what's logged.
export async function qaDeck(data: any, images: Map<string, { data: Buffer; mediaType: string }>, o: { screenshot?: boolean } = {}): Promise<{ data: any; first: QaResult; final: QaResult; fixed: string[] }> {
  const { renderDeck } = await import("./coPages/deck.js");
  const html = (d: any) => renderDeck({ id: "q".repeat(24), data: d, updatedAt: new Date() }, { url: null, showNotes: false, imageSrc: (id) => {
    const im = images.get(id);
    return im ? `data:${im.mediaType};base64,${im.data.toString("base64")}` : null;
  } });
  const first = await runQa(html(data), "deck", data, o);
  if (!first.ran) return { data, first, final: first, fixed: [] };
  const { data: fixedData, fixed } = applyDeckFixes(data, first.findings);
  if (!fixed.length) return { data, first, final: first, fixed };
  const final = await runQa(html(fixedData), "deck", fixedData, o);
  return { data: fixedData, first, final, fixed };
}
