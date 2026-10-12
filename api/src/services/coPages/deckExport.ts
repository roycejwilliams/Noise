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
): Promise<DeckFile | null> {
  const key = `${deck.id}:${deck.version}:pdf:${imagesKey(images)}`;
  return once(key, async () => {
    const { renderDeck } = await import("./deck.js");
    const html = renderDeck(deck, {
      url: null,
      showNotes: false,
      print: true,
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

export async function deckPptx(deck: { id: string; data: DeckData; version: number }, images: Map<string, ExportImage>, o: { withNotes: boolean }): Promise<DeckFile | null> {
  const key = `${deck.id}:${deck.version}:pptx:${o.withNotes ? "notes" : "plain"}:${imagesKey(images)}`;
  return once(key, async () => {
    const { default: PptxGenJS } = (await import("pptxgenjs")) as any;
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in, 16:9
    pptx.title = deck.data.title;
    pptx.company = "Made by Co";
    const st = deck.data.style;
    const hex = (c: string) => c.replace(/^#/, "").toUpperCase();
    // Fonts every PowerPoint has (the web deck's Fraunces and Inter aren't installed on most machines).
    const face = st.type === "serif" ? "Georgia" : "Helvetica";
    const heavy = st.mood === "bold" || st.mood === "playful";
    const dataUrl = (id: string | null | undefined) => {
      const img = id ? images.get(id) : null;
      return img ? `data:${img.mediaType};base64,${img.data.toString("base64")}` : null;
    };
    // Title slide.
    const t = pptx.addSlide();
    // The field title layout (services/designSystem.ts): the accent as the title slide's ground (PowerPoint has no CSS gradient, so its
    // first end), the title in the ink that reads on it.
    const fieldTitle = st.titleLayout === "field" || (!st.titleLayout && (st.gradient || heavy));
    const { inkOn } = await import("./style.js");
    const titleInk = fieldTitle ? inkOn(st.gradient && st.accent2 ? [st.accent, st.accent2] : [st.accent], [st.text, st.background]) : st.text;
    t.background = { color: hex(fieldTitle ? st.accent : st.background) };
    const logo = dataUrl(deck.data.logo);
    if (logo) t.addImage({ data: logo, x: 0.9, y: 1.2, w: 1.1, h: 1.1, sizing: { type: "contain", w: 1.1, h: 1.1 } });
    else t.addShape(pptx.ShapeType.rect, { x: 0.9, y: 2.2, w: 0.7, h: 0.05, fill: { color: hex(st.accent) }, line: { color: hex(st.accent) } });
    t.addText(deck.data.title, { x: 0.9, y: 2.5, w: 11.5, h: 1.6, fontFace: face, fontSize: 48, bold: heavy, color: hex(titleInk), valign: "top" });
    t.addText(deck.data.subtitle, { x: 0.9, y: 4.1, w: 10, h: 1, fontFace: face, fontSize: 20, color: hex(titleInk), transparency: 20, valign: "top" });
    t.addText("Made by Co", { x: 0.9, y: 6.7, w: 4, h: 0.4, fontFace: face, fontSize: 10, color: hex(titleInk), transparency: 45 });
    // Content slides.
    deck.data.slides.forEach((sl, i) => {
      const s = pptx.addSlide();
      s.background = { color: hex(st.background) };
      const pic = dataUrl(sl.image);
      const textW = pic ? 6.4 : 11.5;
      s.addShape(pptx.ShapeType.rect, { x: 0.9, y: 1.3, w: 0.7, h: 0.05, fill: { color: hex(st.accent) }, line: { color: hex(st.accent) } });
      s.addText(sl.headline, { x: 0.9, y: 1.5, w: textW, h: 1.5, fontFace: face, fontSize: 32, bold: heavy, color: hex(st.text), valign: "top" });
      s.addText(
        sl.bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 }, paraSpaceAfter: 10 } })),
        { x: 0.9, y: 3.1, w: textW, h: 3.6, fontFace: face, fontSize: 18, color: hex(st.text), valign: "top" },
      );
      if (pic) s.addImage({ data: pic, x: 7.6, y: 1.3, w: 4.9, h: 4.9, sizing: { type: "contain", w: 4.9, h: 4.9 } });
      s.addText(`${i + 2} / ${deck.data.slides.length + 1}`, { x: 11.4, y: 6.8, w: 1.2, h: 0.4, fontFace: face, fontSize: 10, color: hex(st.text), transparency: 45, align: "right" });
      if (o.withNotes && sl.notes) s.addNotes(sl.notes);
    });
    const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
    return { data: Buffer.from(out), contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", filename: deckFilename(deck.data.title, "pptx") };
  });
}
