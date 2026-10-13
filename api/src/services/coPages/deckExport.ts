// A deck as a file (Royce, 2026-10-11, PR 4): "PDF first (print stylesheet from the web deck), then PPTX. Both generated from the
// same structured deck data, downloadable from the deck page."
//   - PDF: the web deck's own renderer in print mode (one 16:9 page per slide, edge to edge), turned into a PDF by the headless
//     browser Co already uses for documents (browserRead.ts renderPdf). The member's images are inlined, since that browser loads
//     nothing but fonts.
//   - PPTX: built from the same DeckData with pptxgenjs: a title slide, then a slide per content slide with its headline, bullets
//     and image, in the deck's colors and type; speaker notes become PowerPoint notes on their own link only.
// Made when asked for and kept briefly in memory per deck version, so a second click doesn't make it again.
import type { DeckData } from "./deck.js";

export type DeckFile = { data: Buffer; contentType: string; filename: string };
export type ExportImage = { data: Buffer; mediaType: string };

// Bounded (review of PR 4): at most 16 files and 150 MB in all, oldest out first; a file over 25 MB is sent but never kept. The key
// carries the images actually loaded, so a photo they delete is gone from the next download at once.
const CACHE_MAX = 16;
const CACHE_BYTES = 150 * 1024 * 1024;
const FILE_MAX_CACHED = 25 * 1024 * 1024;
const cache = new Map<string, { at: number; file: DeckFile }>();
const CACHE_MS = 10 * 60 * 1000;
function cached(key: string): DeckFile | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_MS) return null;
  return hit.file;
}
function remember(key: string, file: DeckFile): void {
  if (file.data.length > FILE_MAX_CACHED) return;
  cache.set(key, { at: Date.now(), file });
  let total = [...cache.values()].reduce((n, e) => n + e.file.data.length, 0);
  while (cache.size > CACHE_MAX || total > CACHE_BYTES) {
    const oldest = cache.keys().next().value as string;
    total -= cache.get(oldest)?.file.data.length ?? 0;
    cache.delete(oldest);
  }
}
// Requests for the same file while it's being made share that one render (review of PR 4: a burst of clicks queued every render on
// the browser Co's own reads share).
const making = new Map<string, Promise<DeckFile | null>>();
function once(key: string, make: () => Promise<DeckFile | null>): Promise<DeckFile | null> {
  const hit = cached(key);
  if (hit) return Promise.resolve(hit);
  const running = making.get(key);
  if (running) return running;
  const p = make()
    .then((f) => {
      if (f) remember(key, f);
      return f;
    })
    .finally(() => making.delete(key));
  making.set(key, p);
  return p;
}
const imagesKey = (images: Map<string, ExportImage>) => [...images.keys()].sort().join(",");

// Pure: a filename from the deck's title ("Northlight.pdf").
export function deckFilename(title: string, ext: "pdf" | "pptx"): string {
  const base = title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "deck";
  return `${base}.${ext}`;
}

export async function deckPdf(
  deck: { id: string; data: DeckData; updatedAt: Date; version: number },
  images: Map<string, ExportImage>,
  render?: (html: string, size: { width: string; height: string }) => Promise<Buffer | null>,
  art?: { src: (ref: string) => string | null; credit: (p: any) => { credit: string; creditUrl: string | null } | null },
): Promise<DeckFile | null> {
  const key = `${deck.id}:${deck.version}:pdf:${imagesKey(images)}`;
  return once(key, async () => {
    const { renderDeck } = await import("./deck.js");
    const html = renderDeck(deck, {
      url: null,
      showNotes: false,
      print: true,
      // The pictures Co found and the map tiles, inlined (the PDF's browser loads nothing else).
      artSrc: art?.src ?? (() => null),
      credit: art?.credit ?? (() => null),
      imageSrc: (id) => {
        const img = images.get(id);
        return img ? `data:${img.mediaType};base64,${img.data.toString("base64")}` : null;
      },
    });
    const pdf = await (render ?? (async (h, s) => (await import("../browserRead.js")).renderPdf(h, s)))(html, { width: "13.333in", height: "7.5in" });
    if (!pdf) return null;
    return { data: pdf, contentType: "application/pdf", filename: deckFilename(deck.data.title, "pdf") };
  });
}

export async function deckPptx(deck: { id: string; data: DeckData; version: number }, images: Map<string, ExportImage>, o: { withNotes: boolean; art?: { src: (ref: string) => string | null; credit: (p: any) => { credit: string; creditUrl: string | null } | null } }): Promise<DeckFile | null> {
  const key = `${deck.id}:${deck.version}:pptx:${o.withNotes ? "notes" : "plain"}:${imagesKey(images)}`;
  return once(key, async () => {
    const { default: PptxGenJS } = (await import("pptxgenjs")) as any;
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in, 16:9
    pptx.title = deck.data.title;
    pptx.company = "Made by Co";
    const st = deck.data.style;
    const hex = (c: string) => c.replace(/^#/, "").toUpperCase();
    // A PowerPoint file can't carry the web deck's open fonts, and a machine without them falls back to a default face (Times on a
    // Mac), so the file is set in the closest face every PowerPoint has, by kind, and says so in its properties.
    const safeFor = (kind: "serif" | "sans") => (kind === "serif" ? "Georgia" : "Arial");
    const headFace = safeFor(st.display?.kind ?? st.type);
    const bodyFace = safeFor(st.body?.kind ?? "sans");
    if (st.display || st.body) {
      const web = [...new Set([st.display?.family, st.body?.family].filter(Boolean))].join(" and ");
      const file = [...new Set([headFace, bodyFace])].join(" and ");
      pptx.subject = `Set in ${web} on the web deck; this file uses ${file}, the closest faces every PowerPoint has.`;
    }
    const heavy = st.mood === "bold" || st.mood === "playful";
    const headBold = heavy || (st.display?.kind === "sans" && st.mood !== "minimal");
    const dataUrl = (id: string | null | undefined) => {
      const img = id ? images.get(id) : null;
      return img ? `data:${img.mediaType};base64,${img.data.toString("base64")}` : null;
    };
    // The field (services/designSystem.ts): their gradient as an image (PowerPoint export has no gradient fill), else the accent
    // solid, which is the gradient's first color. Its ink reads on every stop.
    // Pictures Co found, fetched at download time with their credits (a venue photo without its credit is left out).
    const art = o.art?.src ?? (() => null);
    const credit = o.art?.credit ?? (() => null);
    const artRef = (p: any) => (p.via === "google" && !credit(p) ? null : art(p.via === "google" ? `g:${p.src}` : `u:${p.src}`));
    const coverDataFor = () => (deck.data.coverImage ? dataUrl(deck.data.coverImage) : deck.data.coverArt ? artRef(deck.data.coverArt) : null);
    const { inkOn } = await import("./style.js");
    const stops = st.gradient && st.accent2 ? [st.accent, st.accent2] : [st.accent];
    const fieldInk = inkOn(stops, [st.text, st.background]);
    const gradientImg = stops.length > 1 ? await (await import("../designRead.js")).gradientPng(stops[0], stops[1]).catch(() => null) : null;
    const onField = (s: any) => (s.background = gradientImg ? { data: gradientImg } : { color: hex(stops[0]) });
    const accOnPaper = (await import("./deck.js")).readableOn(st.accent, st.background, 3);
    // Title slide.
    const t = pptx.addSlide();
    const fieldTitle = st.titleLayout === "field" || (!st.titleLayout && (st.gradient || heavy));
    const titleInk = coverDataFor() ? "#FFFFFF" : fieldTitle ? fieldInk : st.text;
    // A cover picture (theirs, or one Co found): full bleed under a dark scrim, the title in white, its credit kept.
    const coverData = coverDataFor();
    const { creditLine } = await import("./art.js");
    if (coverData) {
      t.background = { color: "111111" };
      t.addImage({ data: coverData, x: 0, y: 0, w: 13.333, h: 7.5, sizing: { type: "cover", w: 13.333, h: 7.5 } });
      t.addShape(pptx.ShapeType.rect, { x: 0, y: 3.2, w: 13.333, h: 4.3, fill: { color: "000000", transparency: 35 }, line: { color: "000000", transparency: 100 } });
      if (deck.data.coverArt) t.addText(creditLine(deck.data.coverArt, credit(deck.data.coverArt)), { x: 7.3, y: 0.2, w: 5.8, h: 0.35, fontFace: bodyFace, fontSize: 9, color: "FFFFFF", align: "right", fill: { color: "000000", transparency: 40 } });
    } else if (fieldTitle) onField(t);
    else t.background = { color: hex(st.background) };
    // A one-ink logo on the field drops its ground, as on the web deck (where it blends); otherwise it sits as it is.
    const lm = deck.data.logoMeta;
    const logoImg = deck.data.logo ? images.get(deck.data.logo) : null;
    const knocked = fieldTitle && lm?.mono && lm.ground && logoImg ? await (await import("../designRead.js")).knockoutGround(logoImg.data, logoImg.mediaType, lm.ground).catch(() => null) : null;
    const logo = knocked ?? dataUrl(deck.data.logo);
    if (logo && logoImg) {
      // Placed at its own proportions inside a 1.8 x 1.0 in box (some viewers ignore "contain" and stretch it).
      const sz = (await import("../designRead.js")).imageSize(logoImg.data) ?? { width: 1, height: 1 };
      const k = Math.min(1.8 / sz.width, 1.0 / sz.height);
      t.addImage({ data: logo, x: 0.9, y: 0.8, w: sz.width * k, h: sz.height * k });
    }
    if (!fieldTitle) t.addShape(pptx.ShapeType.rect, { x: 0, y: 7.2, w: 13.333, h: 0.3, fill: { color: hex(stops[0]) }, line: { color: hex(stops[0]) } });
    t.addText(deck.data.title, { x: 0.9, y: 3.6, w: 11.5, h: 1.5, fontFace: headFace, fontSize: 60, bold: headBold, color: hex(titleInk), valign: "bottom" });
    t.addText(deck.data.subtitle, { x: 0.9, y: 5.2, w: 10, h: 0.9, fontFace: bodyFace, fontSize: 20, color: hex(titleInk), transparency: 10, valign: "top" });
    t.addText("Made by Co", { x: 0.9, y: 6.6, w: 4, h: 0.4, fontFace: bodyFace, fontSize: 10, color: hex(titleInk), transparency: 45 });
    // Content slides, in the web deck's layouts: statements on the field, everything else on their paper.
    const { slideLayouts } = await import("./deck.js");
    const layouts = slideLayouts(deck.data.slides, st.grammar ?? "editorial");
    const { leadOf, dishOf } = await import("./art.js");
    const A = await import("../artImagery.js");
    // A map can't be drawn from tiles in PowerPoint, so it goes in as one picture of the map (rendered from the same tiles).
    const mapPics = new Map<number, string | null>();
    for (const [i, sl] of deck.data.slides.entries()) if (layouts[i] === "map" && sl.map && o.art) mapPics.set(i, await A.mapPng(sl.map, o.art.src).catch(() => null));
    deck.data.slides.forEach((sl, i) => {
      const s = pptx.addSlide();
      const l0 = layouts[i];
      // The web deck's other layouts, set the nearest way PowerPoint can: oversized type as a statement, an asymmetric grid as points,
      // a menu's courses and a timeline as their own lines, a plate or a strip as a picture beside the points.
      const l = l0 === "oversized" || l0 === "pull" ? "statement" : l0 === "asym" ? "points" : l0;
      const field = l === "statement" && (!!st.gradient || heavy);
      const ink = field ? fieldInk : st.text;
      if (field) onField(s);
      else s.background = { color: hex(st.background) };
      const firstArt = (sl.photos ?? []).find((p) => artRef(p)) ?? null;
      const pic = dataUrl(sl.image) ?? (firstArt ? artRef(firstArt) : null) ?? (l === "map" ? mapPics.get(i) ?? null : null);
      const textW = pic ? 6.4 : 11.5;
      s.addText(String(i + 2).padStart(2, "0"), { x: 0.9, y: 0.9, w: 2, h: 0.4, fontFace: bodyFace, fontSize: 11, bold: true, charSpacing: 3, color: hex(field ? ink : accOnPaper) });
      if (l === "timeline" || l === "courses") {
        s.addText(sl.headline, { x: 0.9, y: 1.4, w: 11.5, h: 1.4, fontFace: headFace, fontSize: 34, bold: headBold, color: hex(ink), valign: "top", align: l === "courses" ? "center" : "left" });
        s.addText(
          sl.bullets.map((b) => {
            const x = l === "courses" ? dishOf(b) : leadOf(b);
            return x ? [{ text: `${x.lead}  `, options: { bold: true, color: hex(accOnPaper), breakLine: false } }, { text: x.text, options: { breakLine: true } }] : [{ text: b, options: { breakLine: true } }];
          }).flat() as any,
          { x: l === "courses" ? 2.4 : 0.9, y: 3.1, w: l === "courses" ? 8.5 : 11.5, h: 3.6, fontFace: bodyFace, fontSize: 18, color: hex(ink), valign: "top", paraSpaceAfter: 10, align: l === "courses" ? "center" : "left" },
        );
      } else if (l === "statement") {
        s.addText(sl.headline, { x: 0.9, y: 2.0, w: 10.5, h: 2.4, fontFace: headFace, fontSize: 48, bold: headBold, color: hex(ink), valign: "bottom" });
        s.addText(sl.bullets.join("\n"), { x: 0.9, y: 4.6, w: 9.5, h: 1.8, fontFace: bodyFace, fontSize: 20, color: hex(ink), valign: "top", paraSpaceAfter: 8 });
      } else if (l === "grid") {
        s.addText(sl.headline, { x: 0.9, y: 1.4, w: 10.5, h: 1.6, fontFace: headFace, fontSize: 36, bold: headBold, color: hex(ink), valign: "top" });
        const n = Math.min(4, sl.bullets.length);
        const colW = (11.5 - 0.4 * (n - 1)) / n;
        sl.bullets.slice(0, 4).forEach((b, k) => {
          const x = 0.9 + k * (colW + 0.4);
          s.addShape(pptx.ShapeType.rect, { x, y: 4.0, w: colW, h: 0.04, fill: { color: hex(accOnPaper) }, line: { color: hex(accOnPaper) } });
          s.addText(String(k + 1).padStart(2, "0"), { x, y: 4.15, w: colW, h: 0.6, fontFace: headFace, fontSize: 26, bold: headBold, color: hex(accOnPaper) });
          s.addText(b, { x, y: 4.8, w: colW, h: 1.6, fontFace: bodyFace, fontSize: 15, color: hex(ink), valign: "top" });
        });
      } else {
        s.addText(sl.headline, { x: 0.9, y: 1.4, w: pic ? textW : 5.0, h: 2.2, fontFace: headFace, fontSize: 34, bold: headBold, color: hex(ink), valign: "top" });
        s.addText(
          sl.bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 }, paraSpaceAfter: 12 } })),
          pic ? { x: 0.9, y: 3.7, w: textW, h: 3.0, fontFace: bodyFace, fontSize: 17, color: hex(ink), valign: "top" } : { x: 6.6, y: 1.4, w: 5.8, h: 5.0, fontFace: bodyFace, fontSize: 17, color: hex(ink), valign: "top" },
        );
        if (pic) s.addImage({ data: pic, x: 7.6, y: 1.3, w: 4.9, h: l === "map" ? 3.06 : 4.9, sizing: { type: "contain", w: 4.9, h: l === "map" ? 3.06 : 4.9 } });
        // Every picture Co found keeps its credit (and the map its OpenStreetMap credit) in the file too.
        const cr = l === "map" && pic ? "© OpenStreetMap contributors" : firstArt && !sl.image ? creditLine(firstArt, credit(firstArt)) : null;
        if (cr) s.addText(cr, { x: 7.6, y: l === "map" ? 4.45 : 6.25, w: 4.9, h: 0.3, fontFace: bodyFace, fontSize: 9, color: hex(ink), transparency: 30 });
      }
      s.addText(`${String(i + 2).padStart(2, "0")} / ${String(deck.data.slides.length + 1).padStart(2, "0")}`, { x: 11.2, y: 6.9, w: 1.4, h: 0.4, fontFace: bodyFace, fontSize: 10, color: hex(ink), transparency: 45, align: "right" });
      if (o.withNotes && sl.notes) s.addNotes(sl.notes);
    });
    const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
    return { data: Buffer.from(out), contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", filename: deckFilename(deck.data.title, "pptx") };
  });
}
