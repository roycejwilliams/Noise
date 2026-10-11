// A Co page: GET /d/:id renders one page from its stored data (services/coPages). Private by its link: anyone with the link can view,
// nothing lists pages, search engines are told not to index or follow, nothing is cached, no referrer leaves (the id is the key, so it
// must never reach an image host or a linked site), and an unknown, malformed, expired or taken-down id is the same plain 404.
// Nothing here writes. Mounted by api/src/server.ts and co-test/src/server.ts behind the public-page rate limit.
import { Router } from "express";
import { coPageBase, loadCoPage, type StoredCoPage } from "../services/coPages/store.js";
import { notFoundPage, renderCoPage } from "../services/coPages/template.js";

export const CO_PAGE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // No scripts at all; styles inline and from the two font hosts; images over https (a section's own og:image).
  "Content-Security-Policy":
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com; font-src https://fonts.gstatic.com https://cdn.fontshare.com; img-src https:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};

export function createCoPageRouter(o: { load?: (id: string) => Promise<StoredCoPage | null>; zone?: string } = {}): Router {
  const load = o.load ?? loadCoPage;
  const router = Router();
  router.get("/:id", async (req, res) => {
    res.set(CO_PAGE_HEADERS);
    const page = await load(String(req.params.id ?? "")).catch((err: any) => {
      console.error("co page: load failed:", err?.message ?? err);
      return null;
    });
    if (!page) return res.status(404).type("html").send(notFoundPage());
    const base = coPageBase();
    // The preview image is the page's own cover (from something on the page), or none.
    const html = renderCoPage(page, { url: base ? `${base}/d/${page.id}` : null, ogImageUrl: page.data.cover?.url ?? null, zone: o.zone ?? "America/Los_Angeles" });
    return res.status(200).type("html").send(html);
  });
  return router;
}
