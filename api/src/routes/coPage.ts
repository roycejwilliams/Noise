// A Co page: GET /d/:id renders one page from its stored data (services/coPages). Private by its link: anyone with the link can view,
// nothing lists pages, search engines are told not to index or follow, nothing is cached, no referrer leaves (the id is the key, so it
// must never reach an image host or a linked site), and an unknown, malformed, expired or taken-down id is the same plain 404.
// Nothing here writes. Mounted by api/src/server.ts and co-test/src/server.ts behind the public-page rate limit.
import { Router } from "express";
import { assetIdsIn, coPageBase, loadCoPage, loadShared, noteViewed, type StoredCoPage } from "../services/coPages/store.js";
import { notFoundPage, renderCoPage } from "../services/coPages/template.js";
import { isDeckData, renderDeck, type DeckData } from "../services/coPages/deck.js";
import type { CoPageData } from "../services/coPages/schema.js";

export const CO_PAGE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // No scripts at all; styles inline and from the two font hosts; images over https (a section's own og:image).
  "Content-Security-Policy":
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com; font-src https://fonts.gstatic.com https://cdn.fontshare.com; img-src 'self' https:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};

// A member asset (services/memberAssets.ts), served only through a live artifact that places it: the artifact's own link plus /a/<id>.
// Taken down, expired, not placed there, or not the artifact owner's: the same plain 404.
export const ASSET_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// Each artifact type has its own renderer (a deck: services/coPages/deck.ts). The preview image is a page's own cover, or none. Seen
// through a share link, the page names only the share link, never the owner's own. Image paths are relative to the page's own
// address (/d/<id> or /d/v/<share>), so each resolves under the link it was opened with.
function render(page: StoredCoPage, v: { shareId?: string }, zone = "America/Los_Angeles"): string {
  const base = coPageBase();
  const path = v.shareId ? `v/${v.shareId}` : page.id;
  const url = base ? `${base}/d/${path}` : null;
  return isDeckData(page.data)
    ? renderDeck({ id: page.id, data: page.data as DeckData, updatedAt: page.updatedAt }, { url, zone, assetBase: `${v.shareId ?? page.id}/a/` })
    : renderCoPage({ ...page, data: page.data as CoPageData }, { url, ogImageUrl: (page.data as CoPageData).cover?.url ?? null, zone });
}

export function createCoPageRouter(
  o: { load?: (id: string) => Promise<StoredCoPage | null>; loadShare?: (id: string) => Promise<StoredCoPage | null>; viewed?: (id: string) => Promise<void>; zone?: string; loadAsset?: (ownerUserId: string, id: string) => Promise<{ data: Buffer; mediaType: string } | null> } = {},
): Router {
  const load = o.load ?? loadCoPage;
  const loadShare = o.loadShare ?? loadShared;
  const viewed = o.viewed ?? noteViewed;
  const loadAsset = o.loadAsset ?? (async (owner: string, id: string) => (await import("../services/memberAssets.js")).loadAssetFor(owner, id));
  const router = Router();
  const sendAsset = async (page: StoredCoPage | null, assetId: string, res: any) => {
    res.set(ASSET_HEADERS);
    const asset = page && assetIdsIn(page.data).includes(assetId) ? await loadAsset(page.ownerUserId, assetId).catch(() => null) : null;
    if (!asset) return res.status(404).type("text/plain").send("Not found");
    return res.status(200).type(asset.mediaType).send(asset.data);
  };
  // A share link (store.ts createShareLink): the same artifact, view-only, at its own revocable link. Revoked or unknown: 404.
  router.get("/v/:shareId/a/:assetId", async (req, res) => sendAsset(await loadShare(String(req.params.shareId ?? "")).catch(() => null), String(req.params.assetId ?? ""), res));
  router.get("/v/:shareId", async (req, res) => {
    res.set(CO_PAGE_HEADERS);
    const shareId = String(req.params.shareId ?? "");
    const page = await loadShare(shareId).catch(() => null);
    if (!page) return res.status(404).type("html").send(notFoundPage());
    return res.status(200).type("html").send(render(page, { shareId }, o.zone));
  });
  router.get("/:id/a/:assetId", async (req, res) => sendAsset(await load(String(req.params.id ?? "")).catch(() => null), String(req.params.assetId ?? ""), res));
  router.get("/:id", async (req, res) => {
    res.set(CO_PAGE_HEADERS);
    const page = await load(String(req.params.id ?? "")).catch((err: any) => {
      console.error("co page: load failed:", err?.message ?? err);
      return null;
    });
    if (!page) return res.status(404).type("html").send(notFoundPage());
    // Their link opened: in use (counts toward the expiry warning). Never blocks the page.
    viewed(page.id).catch(() => {});
    return res.status(200).type("html").send(render(page, {}, o.zone));
  });
  return router;
}
