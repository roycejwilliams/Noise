// Model-free checks for hosted event pages, the content layer (services/eventPages, routes/eventPage.ts, agent/eventPageTool.ts):
// the schema refuses markdown, HTML and over-long fields, ids are unguessable, every field renders escaped, unknown and archived
// pages 404, the page carries OG tags, noindex and the empty actions slot. Zero tokens, no database (the store runs on a stub):
//   npx tsx evals/eventPages/content.ts
import { readFileSync } from "fs";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.API_URL = "https://test.example.com";
const { parseEventPageData, EVENT_PAGE_LIMITS } = await import("../../src/services/eventPages/schema.js");
const S = await import("../../src/services/eventPages/store.js");
const T = await import("../../src/services/eventPages/template.js");
const { createEventPageRouter } = await import("../../src/routes/eventPage.js");
const { ABILITIES } = await import("../../src/services/capabilities.js");
const { EVENT_PAGE_INPUT, eventPageFields } = await import("../../src/agent/eventPageTool.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

const base = {
  title: "Supper at the Laurel Room",
  startsAt: "2026-10-24T19:30:00-07:00",
  endsAt: "2026-10-24T23:00:00-07:00",
  timezone: "America/Los_Angeles",
  venueName: "The Laurel Room",
  address: "1 Ferry Building, San Francisco, CA",
  schedule: [{ time: "7:30 PM", label: "Arrivals", detail: "Drinks on the terrace." }, { time: "8:15 PM", label: "Supper", detail: null }],
  whatToBring: ["A layer for the terrace"],
  notes: ["Dress is relaxed but considered."],
  hostLine: "Noor and Ellis invite you",
  imageUrl: null,
};
const with_ = (patch: Record<string, unknown>) => parseEventPageData({ ...base, ...patch });
const refused = (patch: Record<string, unknown>, label: string) => check(label, !with_(patch).ok);

// ---------- schema
const good = parseEventPageData(base);
check("a clean page passes", good.ok);
check("a minimal page passes (title, start, zone, venue)", parseEventPageData({ title: "Walk", startsAt: "2026-10-24T09:00:00Z", timezone: "America/New_York", venueName: "Prospect Park" }).ok);
const minimal = parseEventPageData({ title: "Walk", startsAt: "2026-10-24T09:00:00Z", timezone: "America/New_York", venueName: "Prospect Park" });
check("missing lists and lines come back empty and null", minimal.ok && minimal.data.schedule.length === 0 && minimal.data.notes.length === 0 && minimal.data.address === null && minimal.data.endsAt === null);
for (const k of ["title", "startsAt", "timezone", "venueName"]) {
  const { [k]: _, ...rest } = base as Record<string, unknown>;
  const r = parseEventPageData(rest);
  check(`${k} is required`, !r.ok && r.problems.some((p) => p.startsWith(`${k} is required`)));
}
refused({ title: "**Supper** at the Laurel" }, "markdown bold is refused");
refused({ title: "# Supper" }, "a markdown heading is refused");
refused({ notes: ["- dress up"] }, "a markdown bullet in a note is refused");
refused({ notes: ["See [the menu](https://x.com)"] }, "a markdown link is refused");
refused({ notes: ["Use `code`"] }, "markdown code is refused");
refused({ title: "<b>Supper</b>" }, "HTML is refused");
refused({ venueName: "Room <script>alert(1)</script>" }, "a script tag is refused");
refused({ address: "1 Main &amp; 2nd" }, "an HTML entity is refused");
refused({ notes: ["Line one\nLine two"] }, "a line break is refused (each field is one line)");
refused({ notes: ["Menu at https://example.com"] }, "a link in a text field is refused");
refused({ title: "Supper — Saturday" }, "an em dash is refused");
refused({ title: "Supper tonight!" }, "an exclamation point is refused");
refused({ title: "x".repeat(EVENT_PAGE_LIMITS.title + 1) }, "an over-long title is refused");
refused({ notes: ["y".repeat(EVENT_PAGE_LIMITS.note + 1)] }, "an over-long note is refused");
refused({ notes: Array.from({ length: EVENT_PAGE_LIMITS.notes + 1 }, (_, i) => `Note ${i}`) }, "too many notes are refused");
refused({ schedule: Array.from({ length: EVENT_PAGE_LIMITS.scheduleBlocks + 1 }, (_, i) => ({ time: `${i}`, label: "x", detail: null })) }, "too many schedule blocks are refused");
refused({ schedule: [{ time: "7 PM", label: "Arrivals", html: "<b>x</b>" }] }, "an unknown schedule field is refused");
refused({ schedule: [{ time: "7 PM", detail: "no label" }] }, "a schedule block needs a label");
refused({ body: "free prose" }, "an unknown top-level field (a prose blob) is refused");
refused({ startsAt: "2026-10-24T19:30:00" }, "a start without an offset is refused");
refused({ startsAt: "next Saturday" }, "a start in words is refused");
refused({ endsAt: "2026-10-24T18:00:00-07:00" }, "an end before the start is refused");
refused({ timezone: "Pacific Time" }, "a zone that isn't IANA is refused");
refused({ imageUrl: "http://example.com/a.png" }, "a non-https image is refused");
refused({ imageUrl: "javascript:alert(1)" }, "a script image url is refused");
refused({ title: 42 }, "a non-text title is refused");
check("not an object is refused", !parseEventPageData("Supper").ok && !parseEventPageData(null).ok && !parseEventPageData([base]).ok);
const spaced = with_({ title: "  Supper   at  the Laurel  " });
check("whitespace is trimmed and collapsed", spaced.ok && spaced.data.title === "Supper at the Laurel");
check("an ampersand in a name is fine", with_({ venueName: "Wine & Rye" }).ok);

// ---------- ids and links
const ids = Array.from({ length: 2000 }, () => S.newEventPageId());
check("ids are 24 base64url characters (144 random bits)", ids.every((id) => S.EVENT_PAGE_ID.test(id)) && Buffer.from(ids[0], "base64url").length === 18);
check("ids don't repeat", new Set(ids).size === ids.length);
check("ids aren't sequential or shaped", new Set(ids.map((i) => i.slice(0, 3))).size > 1500);
check("the link is API_URL/e/<id>", S.eventPageUrl("abc") === "https://test.example.com/e/abc");
check("no base URL means no link (it never invents one)", S.eventPageBase({} as any) === null && (() => { try { S.eventPageUrl("x", {} as any); return false; } catch { return true; } })());
check("Railway's own domain is the fallback, like planFile.ts", S.eventPageBase({ RAILWAY_PUBLIC_DOMAIN: "co.up.railway.app" } as any) === "https://co.up.railway.app");

// ---------- store on a stub (no database)
type Row = { id: string; owner_user_id: string | null; co_event_api_id: string | null; data: any; version: number; archived_at: Date | null };
const rows = new Map<string, Row>();
const sqlSeen: string[] = [];
S.useEventPageDb({
  query: async (sql: string, p: any[] = []) => {
    sqlSeen.push(sql);
    if (/^INSERT INTO event_pages/.test(sql)) { rows.set(p[0], { id: p[0], owner_user_id: p[1], co_event_api_id: p[2], data: JSON.parse(p[3]), version: 1, archived_at: null }); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE event_pages SET data/.test(sql)) { const r = rows.get(p[0]); if (!r || r.archived_at) return { rows: [], rowCount: 0 }; r.data = JSON.parse(p[1]); r.version++; return { rows: [{ version: r.version }], rowCount: 1 }; }
    if (/^UPDATE event_pages SET archived_at/.test(sql)) { const r = rows.get(p[0]); if (!r || r.archived_at) return { rows: [], rowCount: 0 }; r.archived_at = new Date(); return { rows: [], rowCount: 1 }; }
    if (/^SELECT/.test(sql)) { const r = rows.get(p[0]); return { rows: r ? [r] : [], rowCount: r ? 1 : 0 }; }
    throw new Error(`unexpected sql: ${sql}`);
  },
});
const made = await S.createEventPage(good.ok ? good.data : (null as any), { ownerUserId: "00000000-0000-0000-0000-000000000001" });
check("create returns the id and its link", S.EVENT_PAGE_ID.test(made.id) && made.url === `https://test.example.com/e/${made.id}`);
const loaded = await S.loadEventPage(made.id);
check("load returns the page, version 1, its owner, not archived", !!loaded && loaded.version === 1 && loaded.ownerUserId === "00000000-0000-0000-0000-000000000001" && loaded.archivedAt === null && loaded.data.title === base.title);
let threw = false;
try { await S.createEventPage({ ...(base as any), title: "<script>x</script>" }); } catch { threw = true; }
check("the store refuses data that didn't pass the schema", threw && rows.size === 1);
const upd = await S.updateEventPage(made.id, { ...(good as any).data, title: "Supper, moved upstairs" });
check("update bumps the version, same link", upd?.version === 2 && (await S.loadEventPage(made.id))?.data.title === "Supper, moved upstairs");
check("a malformed id never reaches the database", (await S.loadEventPage("../../etc")) === null && !sqlSeen.some((q) => q.includes("etc")));
rows.set("BADBADBADBADBADBADBADBAD", { id: "BADBADBADBADBADBADBADBAD", owner_user_id: null, co_event_api_id: null, data: { ...base, title: "<b>x</b>" }, version: 1, archived_at: null });
check("a stored row that fails the schema isn't served", (await S.loadEventPage("BADBADBADBADBADBADBADBAD")) === null);

// ---------- template
const view = { id: made.id, data: (good as any).data, version: 1 };
const html = T.renderEventPage(view, { url: made.url, ogImageUrl: "https://test.example.com/e/og.png" });
check("noindex", /<meta name="robots" content="noindex, nofollow">/.test(html));
check("og:title", html.includes(`<meta property="og:title" content="Supper at the Laurel Room">`));
check("og:description has the date and venue", /<meta property="og:description" content="Saturday, October 24, 7:30 to 11 PM PDT &middot; The Laurel Room">|<meta property="og:description" content="Saturday, October 24, 7:30 to 11 PM PDT &#183; The Laurel Room">/.test(html));
check("og:url is the page's own link", html.includes(`<meta property="og:url" content="${made.url}">`));
check("og:image falls back to the default", html.includes(`<meta property="og:image" content="https://test.example.com/e/og.png">`));
check("twitter:card present", /<meta name="twitter:card" content="summary">/.test(html));
const withImage = T.renderEventPage({ ...view, data: { ...view.data, imageUrl: "https://img.example.com/a.jpg" } }, { url: made.url, ogImageUrl: "https://test.example.com/e/og.png" });
check("the page's own image wins, as a large card", withImage.includes(`content="https://img.example.com/a.jpg"`) && withImage.includes(`content="summary_large_image"`));
check("the actions slot is marked and holds the default line", html.includes(`${T.ACTIONS_OPEN}\n<p class="co-actions-note">Members RSVP by texting Co.</p>\n${T.ACTIONS_CLOSE}`));
check("renderActions fills the slot", T.renderEventPage(view, { url: null, ogImageUrl: null, renderActions: (p) => `<b>rsvp ${p.version}</b>` }).includes(`${T.ACTIONS_OPEN}\n<b>rsvp 1</b>\n${T.ACTIONS_CLOSE}`));
check("each field is in its slot", html.includes(">Arrivals<") && html.includes(">Drinks on the terrace.<") && html.includes(">A layer for the terrace<") && html.includes(">Noor and Ellis invite you<") && html.includes(">Saturday, October 24<"));
// Escaping holds even for data that never went through the schema (the template's own line of defense).
const evil = T.renderEventPage({ id: "x", version: 1, data: { ...view.data, title: `<script>alert("x")</script>`, venueName: `"><img src=x onerror=alert(1)>`, notes: ["<iframe src=//evil>"], schedule: [{ time: "<b>", label: "</li><script>", detail: null }] } }, { url: null, ogImageUrl: null });
check("a <script> title renders inert", !/<script>alert/.test(evil) && evil.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
check("no injected tags anywhere", !/<img src=x|<iframe|<\/li><script>/.test(evil) && !/<script/i.test(evil));
check("no em dashes or exclamation points in the template's own copy", !/[—!]/.test(html.replace(/<!doctype html>/i, "").replace(/<!--[^>]*-->/g, "")));
check("no role nouns for Co in the copy", !/\b(assistant|concierge|matchmaker)\b/i.test(html));
check("mobile-first: viewport meta and a single centered card", html.includes(`<meta name="viewport" content="width=device-width, initial-scale=1">`) && /max-width:520px/.test(html));
check("no scripts in the page", !/<script/i.test(html));
check("times show in the event's own zone", T.whenLines({ startsAt: "2026-10-25T02:30:00Z", endsAt: null, timezone: "America/Los_Angeles" }).time === "7:30 PM PDT");
check("an event past midnight names the end day", /to Sunday 1 AM/.test(T.whenLines({ startsAt: "2026-10-24T21:00:00-07:00", endsAt: "2026-10-25T01:00:00-07:00", timezone: "America/Los_Angeles" }).time));

// ---------- route (the router called directly, no server, no database)
const router = createEventPageRouter({ load: S.loadEventPage });
const get = (url: string) =>
  new Promise<{ code: number; body: string; headers: Record<string, string> }>((resolve, reject) => {
    const res: any = { statusCode: 200, headers: {} as Record<string, string> };
    res.set = (k: any, v?: any) => { if (typeof k === "string") res.headers[k] = v; else Object.assign(res.headers, k); return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.type = () => res;
    res.send = (b: any) => resolve({ code: res.statusCode, body: String(b), headers: res.headers });
    (router as any)({ method: "GET", url, headers: {}, originalUrl: url }, res, (err?: any) => (err ? reject(err) : resolve({ code: 404, body: "fell through", headers: res.headers })));
  });
const ok = await get(`/${made.id}`);
check("a live page answers 200 with the page", ok.code === 200 && ok.body.includes("Supper, moved upstairs"));
check("the response says noindex and no-store", ok.headers["X-Robots-Tag"] === "noindex, nofollow" && /no-store/.test(ok.headers["Cache-Control"] ?? ""));
const unknown = await get(`/${S.newEventPageId()}`);
check("an unknown id is a 404", unknown.code === 404 && !unknown.body.includes("Supper"));
check("a malformed id is a 404", (await get("/not-a-page")).code === 404);
await S.archiveEventPage(made.id);
const archived = await get(`/${made.id}`);
check("an archived page is a 404", archived.code === 404 && !archived.body.includes("Supper"));
check("an archived page can't be updated", (await S.updateEventPage(made.id, (good as any).data)) === null);
check("there is no index route (nothing lists pages)", (await get("/")).body === "fell through");
const og = await get("/og.png");
check("the default preview image is served", og.code === 200 && og.headers["Content-Type"] === "image/png");
S.useEventPageDb(null);

// ---------- wiring and the tool
const ability = ABILITIES.find((a) => a.id === "event_page");
check("the tool is registered, team only, on their yes", ability?.tool === "makeEventPage" && ability.teamOnly === true && ability.confirm === "their_yes");
check("the tool takes fields, never html or a body", !Object.keys(EVENT_PAGE_INPUT.shape).some((k) => /html|body|markdown|content/i.test(k)) && Object.keys(EVENT_PAGE_INPUT.shape).sort().join() === Object.keys(base).sort().join());
check("guard extras never reach the page", Object.keys(eventPageFields({ ...base, why: "x", theirYes: "yes" })).sort().join() === Object.keys(base).sort().join());
check("both servers mount /e", /app\.use\("\/e", createEventPageRouter\(\)\)/.test(read("src/server.ts")) && /app\.use\("\/e", createEventPageRouter\(\)\)/.test(readFileSync(new URL("../../../co-test/src/server.ts", import.meta.url), "utf8")));
check("the table is in the migrations", /CREATE TABLE IF NOT EXISTS event_pages \(\s*id TEXT PRIMARY KEY/.test(read("src/db/migrations.ts")) && /archived_at TIMESTAMPTZ NULL/.test(read("src/db/migrations.ts")));

console.log(`event pages content: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
