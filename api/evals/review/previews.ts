// A page or deck's link card is its real first screen (Royce, 2026-10-28, option C): no separate picture goes with the text; the
// link's own card (og:image) shows the artifact as it shipped, kept with it on this server, never uploaded anywhere, and gone wherever
// its content goes. Layer 1, zero tokens: the database is a recording stub, the route runs on localhost with stubbed loaders, and
// the QA render uses local Chrome when it's there (the shot's size is checked only when it ran).
//   npx tsx evals/review/previews.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.API_URL = "https://co.example";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import express from "express";
const S = await import("../../src/services/coPages/store.js");
const LP = await import("../../src/services/coPages/linkPreview.js");
const R = await import("../../src/routes/coPage.js");
const Q = await import("../../src/services/designQa.js");
const P = await import("../../src/agent/pageTools.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const pngDims = (b: Buffer | null | undefined) => (b && b.length > 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null);
const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fakePng = (s: string) => Buffer.concat([MAGIC, Buffer.from(s)]);

// Every outside call made while this file runs (the layer 1 guard refuses them too; this says which, and fails here first).
const outside: string[] = [];
const guarded = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  try { if (!/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(new URL(url).host)) outside.push(url); } catch {}
  return guarded(input, init);
}) as typeof fetch;

const input = {
  title: "Saturday in the Mission",
  context: "Saturday, Oct 24, Mission District, for Jordan",
  sections: [
    { heading: "Where to eat", blocks: [{ type: "comparison" as const, options: [
      { name: "Alder and Ash", facts: [{ label: "Price", value: "About $85 a person" }], note: null, url: null },
      { name: "Mesa Verde", facts: [{ label: "Price", value: "About $60 a person" }], note: null, url: null },
    ] }] },
  ],
  sources: [],
};
const source = { theirs: "Jordan: a Saturday night in the Mission, dinner somewhere good. Oct 24 works.", read: "Alder and Ash, Mission District. Dinner about $85 a person. Mesa Verde, Mission. Dinner about $60 a person." };
const pageData = (S.checkPage(P.pageDataFrom(input as any), source) as any).data;
const deckData: any = { kind: "deck", style: { mood: "minimal", background: "#FFFFFF", text: "#111111", accent: "#7A1F2B", type: "serif" }, title: "Noise: the room that remembers", subtitle: "Seed round", slides: [{ headline: "Cue knows everyone in the room", bullets: ["Matches people inside the room", "Follows through after"] }, { headline: "Double opt-in, every time", bullets: ["Both say yes first", "One email after both agree"] }] };
const deckOk = S.parseCoArtifact(deckData);
check("fixtures: the page and the deck pass the schema", !!pageData && deckOk.ok, deckOk);

// ---------------------------------------------------------------- the shot: the first screen, at the card's size, never the phone's
{
  check("card sizes: a deck's first slide whole (1280x720), a page's top cut to 1.91:1 (1280x672)", Q.CARD_SHOT.deck.width === 1280 && Q.CARD_SHOT.deck.height === 720 && Q.CARD_SHOT.page.width === 1280 && Q.CARD_SHOT.page.height === 672);
  const { renderCoPage } = await import("../../src/services/coPages/template.js");
  const pq = await Q.qaPage(pageData, (d) => renderCoPage({ id: "q".repeat(24), data: d, version: 1, updatedAt: new Date() }, { url: null, ogImageUrl: null }), { screenshot: true, view: true });
  const dq = deckOk.ok ? await Q.qaDeck(deckOk.data, new Map(), { screenshot: true, view: true }) : null;
  if (pq.final.ran) check("a page's shot is its top at 1280x672, and the phone pass takes none", JSON.stringify(pngDims(pq.final.screenshot)) === JSON.stringify({ w: 1280, h: 672 }) && !pq.final.phone, pngDims(pq.final.screenshot));
  else console.log("note: Chrome didn't run here, so the page shot's size wasn't checked");
  if (dq?.final.ran) check("a deck's shot is its first slide at 1280x720", JSON.stringify(pngDims(dq.final.screenshot)) === JSON.stringify({ w: 1280, h: 720 }), pngDims(dq.final.screenshot));
  if (pq.final.ran) check("a stored shot passes the store's own gate (a PNG under the cap)", S.previewShotOf(pq.final.screenshot) !== null && (pq.final.screenshot?.length ?? 0) < S.PREVIEW_SHOT_MAX_BYTES);
  check("the gate stores nothing that isn't a PNG, is empty or is over the cap", S.previewShotOf(null) === null && S.previewShotOf(Buffer.alloc(0)) === null && S.previewShotOf(Buffer.from("GIF89a....")) === null && S.previewShotOf(Buffer.concat([MAGIC, Buffer.alloc(S.PREVIEW_SHOT_MAX_BYTES)])) === null && S.previewShotOf(fakePng("x")) !== null);
}

// ---------------------------------------------------------------- made and changed: one text, no media, the shot stored with the version
{
  const calls: { sql: string; params: unknown[] }[] = [];
  let next: any = { rows: [], rowCount: 1 };
  S.useCoPageDb({ query: async (sql: string, params: unknown[] = []) => { calls.push({ sql: sql.replace(/\s+/g, " "), params }); return typeof next === "function" ? next(sql) : next; } });
  const said: unknown[][] = [];
  const ctx: any = { userId: "owner-a", dryRun: false, facts: { add: () => {} } };
  const tools: any = P.pageTools(ctx, { say: async (...args: unknown[]) => { said.push(args); return true; }, notDone: () => {}, source: async () => source });
  const before = outside.length;
  const r = await tools.makePage.execute({ ...input, line: "Here's Saturday in the Mission, two dinners side by side." }, {});
  const ins = calls.find((c) => /INSERT INTO co_pages/.test(c.sql));
  check("made: one text, the line and the link, and say() gets no media (text and its record only)", r.ok && said.length === 1 && said[0].length === 2 && typeof said[0][0] === "string" && /\nhttps:\/\/co\.example\/d\/[A-Za-z0-9_-]{24}$/.test(String(said[0][0])), { r, said });
  const shot = ins?.params[4] as Buffer | null | undefined;
  check("made: the shot goes into the same INSERT as the page, at version 1 (or nothing when QA couldn't render)", !!ins && /preview, preview_version\) VALUES .*\$5::bytea, CASE WHEN \$5::bytea IS NULL THEN NULL ELSE 1 END/.test(ins.sql) && (shot === null || (Buffer.isBuffer(shot) && JSON.stringify(pngDims(shot)) === JSON.stringify({ w: 1280, h: 672 }))), { sql: ins?.sql, dims: pngDims(shot) });
  said.length = 0;
  next = (sql: string) => (/SELECT id, data->>'title'/.test(sql) ? { rows: [{ id: "A".repeat(24), title: "Saturday in the Mission", updated_at: new Date() }] } : /UPDATE co_pages SET data/.test(sql) ? { rows: [{ version: 2 }] } : { rows: [], rowCount: 1 });
  const u = await tools.updatePage.execute({ ...input, page: "the Mission page", changed: "swapped Friday dinner for Saturday at Mesa Verde" }, {});
  const upd = calls.find((c) => /UPDATE co_pages SET data/.test(c.sql));
  const ushot = upd?.params[6] as Buffer | null | undefined;
  check("changed: one text, no media; the new version's shot replaces the old in the same UPDATE (none when QA couldn't render)", u.ok && said.length === 1 && said[0].length === 2 && !!upd && /preview = \$7::bytea, preview_version = CASE WHEN \$7::bytea IS NULL THEN NULL ELSE version \+ 1 END/.test(upd.sql) && (ushot === null || JSON.stringify(pngDims(ushot)) === JSON.stringify({ w: 1280, h: 672 })), { sql: upd?.sql, said });
  check("nothing is uploaded anywhere: making and changing a page made no outside call", outside.length === before, outside.slice(before));
  // The store: an update with no shot clears the old one (an older version's picture never outlives it).
  calls.length = 0;
  next = { rows: [{ version: 3 }] };
  await S.updateCoPage("A".repeat(24), "owner-a", pageData, source, {});
  check("an update without a shot stores none (the old one is replaced by nothing)", calls[0]?.params[6] === null, calls[0]?.params);
  S.useCoPageDb(null);
}

// ---------------------------------------------------------------- the route: the shot for the current version, the drawn card otherwise
{
  const shotBytes = { page: fakePng("page-shot"), deck: fakePng("deck-shot") };
  const card = fakePng("drawn-card");
  const live = new Map<string, any>([
    ["P".repeat(24), { id: "P".repeat(24), data: pageData, version: 2, updatedAt: new Date(), ownerUserId: "owner-a", shot: true }],
    ["D".repeat(24), { id: "D".repeat(24), data: deckOk.ok ? deckOk.data : deckData, version: 1, updatedAt: new Date(), ownerUserId: "owner-a", shot: true }],
    ["N".repeat(24), { id: "N".repeat(24), data: pageData, version: 1, updatedAt: new Date(), ownerUserId: "owner-a", shot: false }],
    ["G".repeat(24), { id: "G".repeat(24), data: pageData, version: 1, updatedAt: new Date(), ownerUserId: "owner-a", shot: true }],
  ]);
  const shots = new Map<string, { v: number; b: Buffer }>([["P".repeat(24), { v: 2, b: shotBytes.page }], ["D".repeat(24), { v: 1, b: shotBytes.deck }]]);
  const asked: [string, number][] = [];
  const app = express();
  app.use("/d", R.createCoPageRouter({
    load: async (id) => live.get(id) ?? null,
    loadShare: async (id) => (id === "S".repeat(24) ? live.get("P".repeat(24)) : null),
    loadShot: async (id, v) => { asked.push([id, v]); const s = shots.get(id); return s && s.v === v ? s.b : null; },
    ownerName: async () => "Jordan K.",
    renderPng: async () => card,
    viewed: async () => {},
  }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const get = async (p: string) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, h: r.headers, body: Buffer.from(await r.arrayBuffer()) }; };
  const meta = async (p: string) => {
    const html = (await get(p)).body.toString("utf8");
    const img = html.match(/<meta property="og:image" content="([^"]+)">/)?.[1] ?? "";
    return { path: img ? new URL(img).pathname : "", w: html.match(/og:image:width" content="(\d+)"/)?.[1], h: html.match(/og:image:height" content="(\d+)"/)?.[1] };
  };
  const mp = await meta(`/d/${"P".repeat(24)}`);
  const pImg = await get(mp.path);
  check("a page with a shot for its live version: its og:image is that shot, as a PNG the page's own size (1280x672)", pImg.status === 200 && pImg.body.equals(shotBytes.page) && pImg.h.get("content-type") === "image/png" && mp.w === "1280" && mp.h === "672" && asked.some(([id, v]) => id === "P".repeat(24) && v === 2), { status: pImg.status, mp });
  check("the shot is the content: served like the page (private, no-store), never kept by a shared cache", pImg.h.get("cache-control") === "private, no-store" && pImg.h.get("x-robots-tag") === "noindex, nofollow" && pImg.h.get("referrer-policy") === "no-referrer");
  const md = await meta(`/d/${"D".repeat(24)}`);
  const dImg = await get(md.path);
  check("a deck's og:image is its first slide (1280x720)", dImg.status === 200 && dImg.body.equals(shotBytes.deck) && md.w === "1280" && md.h === "720", md);
  const mn = await meta(`/d/${"N".repeat(24)}`);
  const nImg = await get(mn.path);
  check("no shot stored for the live version: the drawn card, unchanged (1200x630, cached a day)", nImg.status === 200 && nImg.body.equals(card) && nImg.h.get("cache-control") === "public, max-age=86400" && mn.w === "1200" && mn.h === "630", { mn, cc: nImg.h.get("cache-control") });
  const mg = await meta(`/d/${"G".repeat(24)}`);
  const gImg = await get(mg.path);
  check("a shot that went meanwhile (a placed photo deleted) falls back to the drawn card, never an error or an older shot", gImg.status === 200 && gImg.body.equals(card));
  const ms = await meta(`/d/v/${"S".repeat(24)}`);
  const sImg = await get(ms.path);
  check("a share link shows the same content, so its card is the same shot, under the share link", ms.path.startsWith(`/d/v/${"S".repeat(24)}/og/`) && sImg.status === 200 && sImg.body.equals(shotBytes.page));
  // The page changes: version 3 has no shot yet. The old address (version 2's) is a plain 404; the new one is the drawn card.
  live.set("P".repeat(24), { ...live.get("P".repeat(24)), version: 3, shot: false });
  const stale = await get(mp.path);
  const m3 = await meta(`/d/${"P".repeat(24)}`);
  check("the address changes with the version: the old one is a plain 404, never the old shot", stale.status === 404 && !stale.body.includes(shotBytes.page) && m3.path !== mp.path && (await get(m3.path)).body.equals(card));
  // Taken down or expired: the loader finds nothing, so the card route serves nothing at all.
  live.delete("D".repeat(24));
  const gone = await get(md.path);
  check("taken down or expired: the card route is a plain 404 with nothing personal", gone.status === 404 && gone.body.toString() === "Not found" && gone.h.get("cache-control") === "no-store");
  server.close();
}

// ---------------------------------------------------------------- the address changes with the version and with the picture
{
  const base = { id: "P".repeat(24), data: pageData, version: 1 };
  const t1 = LP.previewTag({ ...base, shot: true }, "Jordan K.");
  const t2 = LP.previewTag({ ...base, version: 2, shot: true }, "Jordan K.");
  const tCard = LP.previewTag({ ...base, shot: false }, "Jordan K.");
  const before = createHash("sha256").update(JSON.stringify([base.id, 1, pageData.title, "page", pageData.style ?? null, "Jordan K."])).digest("base64url").slice(0, 16);
  check("the tag changes with the version, and between the shot and the drawn card", t1 !== t2 && t1 !== tCard && LP.PREVIEW_TAG.test(t1));
  check("a drawn card's address is what it always was (no card already crawled changes)", tCard === before && LP.previewTag(base as any, "Jordan K.") === before);
}

// ---------------------------------------------------------------- forget by default: every path that removes the content removes the shot
{
  const calls: { sql: string; params: unknown[] }[] = [];
  let next: any = { rows: [], rowCount: 1 };
  S.useCoPageDb({ query: async (sql: string, params: unknown[] = []) => { calls.push({ sql: sql.replace(/\s+/g, " "), params }); return typeof next === "function" ? next(sql) : next; } });
  await S.takeDownCoPage("A".repeat(24), "owner-a");
  check("take-down wipes the shot with the content", /SET taken_down_at = NOW\(\), data = '\{\}'::jsonb, updated_at = NOW\(\), preview = NULL, preview_version = NULL WHERE id = \$1 AND owner_user_id = \$2/.test(calls.at(-1)!.sql), calls.at(-1)?.sql);
  await S.wipeExpiredCoPages();
  check("expiry wipes the shot with the content", /UPDATE co_pages SET taken_down_at = NOW\(\), data = '\{\}'::jsonb, preview = NULL, preview_version = NULL WHERE taken_down_at IS NULL AND expires_at <= NOW\(\)/.test(calls.at(-1)!.sql));
  next = { rows: [{ id: "B".repeat(24) }] };
  await S.resetCoPageLink("A".repeat(24), "owner-a");
  const reset = calls.find((c) => /WITH old AS/.test(c.sql))!.sql;
  check("a reset wipes the old row's shot and moves it, with the content, to the fresh link", /UPDATE co_pages p SET taken_down_at = NOW\(\), data = '\{\}'::jsonb, updated_at = NOW\(\), moved_to = \$1, preview = NULL, preview_version = NULL FROM old/.test(reset) && /INSERT INTO co_pages \([^)]*preview, preview_version\) SELECT [^;]*preview, preview_version FROM down/.test(reset));
  next = { rows: [] };
  calls.length = 0;
  const none = await S.loadPreviewShot("A".repeat(24), 2);
  check("the shot is read only for the live version of a live artifact", none === null && /WHERE id = \$1 AND version = \$2 AND preview_version = \$2 AND preview IS NOT NULL AND taken_down_at IS NULL AND expires_at > NOW\(\)/.test(calls[0]?.sql ?? "") && (await S.loadPreviewShot("bad", 1)) === null);
  next = { rows: [{ id: "A".repeat(24), owner_user_id: "owner-a", data: pageData, version: 2, updated_at: new Date(), shot: true }] };
  const loaded = await S.loadCoPage("A".repeat(24));
  check("loading the page says whether a shot is stored for this version, without reading its bytes", loaded?.shot === true && /\(preview IS NOT NULL AND preview_version = version\) AS shot FROM co_pages/.test(calls.at(-1)!.sql) && !/SELECT[^]*\bpreview\b,/.test(calls.at(-1)!.sql));
  S.useCoPageDb(null);
  // Every statement in the store that wipes the content wipes the shot too (a new wipe path can't forget it).
  const store = src("services/coPages/store.ts");
  const wipes = [...store.matchAll(/data = '\{\}'::jsonb[^`]*/g)].map((m) => m[0]);
  check("every content wipe in the store also wipes the shot", wipes.length >= 3 && wipes.every((w) => /preview = NULL, preview_version = NULL/.test(w)), wipes);
  // "Delete the photos I sent you": a page or deck placing one loses its shot in the same statement.
  const A = await import("../../src/services/memberAssets.js");
  const asset: { sql: string; params: unknown[] }[] = [];
  A.useAssetDb({ query: async (sql: string, params: unknown[] = []) => { asset.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [], rowCount: 0 }; } });
  await A.deleteAssets("owner-a", [2]);
  A.useAssetDb(null);
  check("deleting a photo drops the shot of every page or deck of theirs that placed it, in one statement", asset.length === 1 && /WITH gone AS \( UPDATE member_assets SET bytes = NULL[^]*RETURNING id \), cards AS \( UPDATE co_pages p SET preview = NULL, preview_version = NULL WHERE p\.owner_user_id = \$1 AND p\.preview IS NOT NULL AND EXISTS \(SELECT 1 FROM gone WHERE p\.data::text LIKE '%' \|\| gone\.id \|\| '%'\)/.test(asset[0].sql), asset[0]?.sql);
  // The account deleted: the rows go by cascade, and the shot is a column on them; the migration only adds (never drops or rewrites).
  const mig = src("db/migrations.ts");
  check("account deletion takes every shot with it (co_pages rows cascade from users), and the migration is additive", /CREATE TABLE IF NOT EXISTS co_pages \([^]*?owner_user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/.test(mig) && /ALTER TABLE co_pages ADD COLUMN IF NOT EXISTS preview BYTEA NULL, ADD COLUMN IF NOT EXISTS preview_version INT NULL/.test(mig));
}

// ---------------------------------------------------------------- no separate picture, no upload
{
  check("no preview upload module is left", !existsSync(new URL("../../src/services/previewMedia.ts", import.meta.url)));
  const tools = src("agent/pageTools.ts") + src("agent/deckTools.ts") + src("agent/loopTools.ts");
  check("page and deck tools send no media and import no uploader", !/previewMedia|mediaUrl|media_url/.test(tools) && /const say = async \(text: string, record: string\) =>/.test(src("agent/loopTools.ts")));
  check("the send carries no media but a voice note's (no mediaUrl on the reply or in sendCoReply)", !/mediaUrl/.test(src("agent/conversationTools.ts")) && !/mediaUrl/.test(src("routes/sendblue.ts")));
  check("nothing in the shot's path talks to a file store", !/upload-file|SENDBLUE_UPLOAD|fetch\(/.test(src("services/coPages/store.ts") + src("services/coPages/linkPreview.ts")));
}

check("no outside call from any of it", outside.length === 0, outside);
console.log(`previews: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
