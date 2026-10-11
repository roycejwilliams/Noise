// Co pages, the security review's findings (Royce, 2026-10-11: "fix all"). Zero tokens; the database is a recording stub.
//   H1  changing or taking down a page is the owner's only (every write matches id AND owner).
//   H2  a page holds only the owner's words and what Co read: anything else (another member) is refused before it's stored.
//   M2  a page can be taken down (content wiped, link 404) and expires after 90 days.
//   ID  144 random bits; the route is private (noindex, no-store, no referrer, no scripts) and every miss is the same 404.
//   npx tsx evals/coPages/security.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.API_URL = "https://co.example";
import http from "node:http";
import express from "express";
const S = await import("../../src/services/coPages/store.js");
const G = await import("../../src/services/coPages/grounding.js");
const R = await import("../../src/routes/coPage.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

const page = (extra: string | null = null) => ({
  title: "Saturday night in the Mission",
  context: "Saturday, Oct 24, Mission District, for Jordan",
  cover: null,
  sections: [
    { heading: "Where to eat", image: null, blocks: [
      { type: "comparison", options: [
        { name: "Alder and Ash", facts: [{ label: "Price", value: "About $85 a person" }], note: null, url: "https://alderandash.example/" },
        { name: "Mesa Verde", facts: [{ label: "Price", value: "About $60 a person" }], note: null, url: "https://mesaverde.example/" },
      ] },
      ...(extra ? [{ type: "text", text: extra }] : []),
    ] },
  ],
  sources: [],
});
const source = {
  theirs: "Jordan: I want a Saturday night in the Mission, dinner somewhere good then a drink. Oct 24 works.",
  read: "Alder and Ash, Mission District. Dinner about $85 a person. Mesa Verde, Mission. Dinner about $60 a person.",
};

// ---------------------------------------------------------------- ID strength
{
  const ids = new Set(Array.from({ length: 2000 }, () => S.newCoPageId()));
  check("ids are 24 url-safe characters (144 random bits), no repeats in 2,000", ids.size === 2000 && [...ids].every((i) => S.CO_PAGE_ID.test(i)));
  const src = (await import("node:fs")).readFileSync(new URL("../../src/services/coPages/store.ts", import.meta.url), "utf8");
  check("made with crypto randomBytes, never a counter, clock or Math.random", /randomBytes\(18\)\.toString\("base64url"\)/.test(src) && !/Math\.random|Date\.now\(\)\.toString|nextval/.test(src));
}

// ---------------------------------------------------------------- H2 grounding
{
  check("a page from their words and Co's reads passes", G.pageProblems(page() as any, source).length === 0, G.pageProblems(page() as any, source));
  const leak = S.checkPage(page("Ellis Park is coming too, newly divorced and looking to meet people."), source);
  check("another member's details (nothing they said, nothing Co read) are refused before storing", !leak.ok, leak);
  const event = S.checkPage(page("Also on Friday at 9 PM there's the Harbor Club mixer."), source);
  check("an event nothing backs is refused too", !event.ok, event);
  const schema = S.checkPage({ ...page(), title: "<b>x</b>" }, source);
  check("the schema still runs first", !schema.ok);
}

// ---------------------------------------------------------------- H1 + M2 the store, against a recording database
type Q = { sql: string; params: unknown[] };
const calls: Q[] = [];
let next: { rows: any[]; rowCount?: number } = { rows: [], rowCount: 0 };
S.useCoPageDb({ query: async (sql: string, params: unknown[] = []) => { calls.push({ sql: sql.replace(/\s+/g, " "), params }); return next; } });
{
  next = { rows: [], rowCount: 1 };
  const made = await S.createCoPage(page(), { ownerUserId: "owner-a", source });
  const ins = calls.at(-1)!;
  check("a page is made with its owner and a 90-day expiry, and its link is /d/<id>", made.ok && /^https:\/\/co\.example\/d\/[A-Za-z0-9_-]{24}$/.test((made as any).url) && /INSERT INTO co_pages \(id, owner_user_id, data, expires_at\)/.test(ins.sql) && ins.params[1] === "owner-a" && ins.params[3] === 90);
  calls.length = 0;
  const refused = await S.createCoPage(page("Ellis Park is coming too, newly divorced and looking to meet people."), { ownerUserId: "owner-a", source });
  check("a page that fails the grounding is never written", !refused.ok && calls.length === 0);
  const id = (made as any).id as string;

  next = { rows: [], rowCount: 0 };
  calls.length = 0;
  const upd = await S.updateCoPage(id, "owner-b", page(), source);
  check("H1: an update matches the id and the owner (another member's id changes nothing)", upd === null && /WHERE id = \$1 AND owner_user_id = \$2 AND taken_down_at IS NULL AND expires_at > NOW\(\)/.test(calls[0].sql) && calls[0].params[1] === "owner-b");
  calls.length = 0;
  const down = await S.takeDownCoPage(id, "owner-b");
  check("H1: a take-down matches the id and the owner", down === false && /WHERE id = \$1 AND owner_user_id = \$2/.test(calls[0].sql));
  next = { rows: [], rowCount: 1 };
  calls.length = 0;
  check("M2: the owner can take it down, and its content is wiped right away", (await S.takeDownCoPage(id, "owner-a")) === true && /SET taken_down_at = NOW\(\), data = '\{\}'::jsonb/.test(calls[0].sql));
  calls.length = 0;
  check("no owner, or a malformed id, never reaches the database", (await S.takeDownCoPage(id, "")) === false && (await S.takeDownCoPage("../x", "owner-a")) === false && (await S.updateCoPage("x", "owner-a", page(), source)) === null && calls.length === 0);
  calls.length = 0;
  await S.livePagesFor("owner-a");
  check("a member's own page list is theirs only (to find 'that page' to take down)", /WHERE owner_user_id = \$1 AND taken_down_at IS NULL AND expires_at > NOW\(\)/.test(calls[0].sql) && calls[0].params[0] === "owner-a");
  calls.length = 0;
  await S.wipeExpiredCoPages();
  check("M2: expired pages lose their content (daily job)", /SET taken_down_at = NOW\(\), data = '\{\}'::jsonb WHERE taken_down_at IS NULL AND expires_at <= NOW\(\)/.test(calls[0].sql));
  calls.length = 0;
  next = { rows: [] };
  check("the public read only finds a live, unexpired page", (await S.loadCoPage(id)) === null && /WHERE id = \$1 AND taken_down_at IS NULL AND expires_at > NOW\(\)/.test(calls[0].sql));
  const jobs = (await import("node:fs")).readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8");
  check("the expiry wipe is scheduled", /wipeExpiredCoPages\(\)/.test(jobs));
}
S.useCoPageDb(null);

// ---------------------------------------------------------------- the route
{
  const stored = { id: "A".repeat(24), data: (S.checkPage(page(), source) as any).data, version: 1, updatedAt: new Date("2026-10-11T19:00:00Z"), ownerUserId: "owner-a" };
  const app = express();
  app.use("/d", R.createCoPageRouter({ load: async (id) => (id === stored.id ? stored : null) }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const get = async (p: string) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, h: r.headers, body: await r.text() }; };
  const ok = await get(`/d/${stored.id}`);
  check("a live page renders", ok.status === 200 && /Saturday night in the Mission/.test(ok.body));
  check("private: noindex, no-store, no referrer, no framing, no scripts allowed", ok.h.get("x-robots-tag") === "noindex, nofollow" && ok.h.get("cache-control") === "private, no-store" && ok.h.get("referrer-policy") === "no-referrer" && ok.h.get("x-frame-options") === "DENY" && /script-src 'none'/.test(ok.h.get("content-security-policy") ?? ""));
  const miss = await get(`/d/${"B".repeat(24)}`);
  const bad = await get(`/d/not-an-id`);
  check("unknown and malformed ids are the same plain 404, with the same headers", miss.status === 404 && bad.status === 404 && miss.body === bad.body && miss.h.get("x-robots-tag") === "noindex, nofollow");
  const root = await get(`/d/`);
  check("nothing lists pages", root.status === 404 && !/A{24}/.test(root.body));
  server.close();
}

console.log(`co pages security: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
