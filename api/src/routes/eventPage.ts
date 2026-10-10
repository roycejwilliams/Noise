// A hosted event page: GET /e/:id renders one page from its data (services/eventPages). Private by default: anyone with the
// link can view it, nothing lists pages, search engines are told not to index or follow, and an unknown, malformed or archived
// id is the same plain 404. Nothing here writes. Mounted by both api/src/server.ts and co-test/src/server.ts (co-test keeps its
// own copies of the public routes, like /i/:code and /readout).
//
// /e/og.png is the default link-preview image when a page has no imageUrl: Co's own wordmark (assets/coIcon.ts, the vCard photo).
import { Router } from "express";
import { CO_ICON_PNG_BASE64 } from "../assets/coIcon.js";
import { eventPageBase, loadEventPage, type StoredEventPage } from "../services/eventPages/store.js";
import { notFoundPage, renderEventPage, type RenderActions } from "../services/eventPages/template.js";

const PRIVATE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
let iconPng: Buffer | null = null;

export function defaultOgImage(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = eventPageBase(env);
  return base ? `${base}/e/og.png` : null;
}

export function createEventPageRouter(o: { load?: (id: string) => Promise<StoredEventPage | null>; renderActions?: RenderActions } = {}): Router {
  const load = o.load ?? loadEventPage;
  const router = Router();
  router.get("/og.png", (_req, res) => {
    iconPng ??= Buffer.from(CO_ICON_PNG_BASE64, "base64");
    res.set({ "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    res.send(iconPng);
  });
  router.get("/:id", async (req, res) => {
    res.set(PRIVATE);
    const id = String(req.params.id ?? "");
    const page = await load(id).catch((err: any) => {
      console.error("event page: load failed:", err?.message ?? err);
      return null;
    });
    if (!page || page.archivedAt) return res.status(404).type("html").send(notFoundPage());
    const base = eventPageBase();
    const html = renderEventPage(page, { url: base ? `${base}/e/${page.id}` : null, ogImageUrl: defaultOgImage(), renderActions: o.renderActions });
    return res.status(200).type("html").send(html);
  });
  return router;
}
