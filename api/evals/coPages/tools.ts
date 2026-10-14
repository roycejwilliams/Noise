// Co pages as Co's tools (Royce, 2026-10-11 document rules). Zero tokens; the database is a recording stub, no network.
//   Rule 1: Co picks the format (the capability text says when a page, a text, a PDF or a Google Doc) and never asks.
//   Rule 2: a page goes as ONE text: the line saying what Co made, plus the link; nothing about its contents.
//   Rule 3: a change keeps the page and link; the text is "Updated the page: <what changed>".
//   Take-down: the member's own page only, by its title.
//   npx tsx evals/coPages/tools.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.API_URL = "https://co.example";
import fs from "node:fs";
const P = await import("../../src/agent/pageTools.js");
const S = await import("../../src/services/coPages/store.js");
const Sch = await import("../../src/services/coPages/schema.js");
const Cap = await import("../../src/services/capabilities.js");
const CT = await import("../../src/services/callTools.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

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
check("the tool's input becomes a page the schema accepts", Sch.parseCoPageData(P.pageDataFrom(input as any)).ok, Sch.parseCoPageData(P.pageDataFrom(input as any)));

// ---------------------------------------------------------------- which page they mean
{
  const pages = [{ id: "a", title: "Saturday in the Mission" }, { id: "b", title: "Venue options for the launch" }, { id: "c", title: "Venue options for the dinner" }];
  check("found by a word of its title", (P.pickPage(pages, "the mission page") as any)?.id === "a");
  check("two that fit equally are asked about", P.pickPage(pages, "venue options") === "ambiguous");
  check("none that fits is none", P.pickPage(pages, "the brunch page") === null && P.pickPage([], "anything") === null);
  check("'the page' with one page is that page", (P.pickPage([pages[0]], "the page") as any)?.id === "a");
  check("review of #148: 'take that page down' with one page is that page", (P.pickPage([pages[0]], "take that page down") as any)?.id === "a");
  check("review of #148: 'take that page down' or 'delete it' with two pages is asked about, never the newest", P.pickPage(pages, "take that page down") === "ambiguous" && P.pickPage(pages, "delete it") === "ambiguous");
}

// ---------------------------------------------------------------- the tools, end to end on a recording database
const calls: { sql: string; params: unknown[] }[] = [];
let next: any = { rows: [], rowCount: 1 };
S.useCoPageDb({ query: async (sql: string, params: unknown[] = []) => { calls.push({ sql: sql.replace(/\s+/g, " "), params }); return typeof next === "function" ? next(sql) : next; } });
const said: string[] = [];
const notDone: string[] = [];
const facts: string[] = [];
const ctx: any = { userId: "owner-a", dryRun: false, facts: { add: (_k: string, t: string) => facts.push(t) } };
const tools: any = P.pageTools(ctx, { say: async (t) => { said.push(t); return true; }, notDone: (w) => notDone.push(w), source: async () => source });
{
  const r = await tools.makePage.execute({ ...input, line: "Here's Saturday in the Mission, two dinners side by side." }, {});
  const ins = calls.find((c) => /INSERT INTO co_pages/.test(c.sql));
  check("rule 2: one text, the line and the link, nothing about its contents", r.ok && said.length === 1 && /^Here's Saturday in the Mission, two dinners side by side\.\nhttps:\/\/co\.example\/d\/[A-Za-z0-9_-]{24}$/.test(said[0]) && !/Alder|Mesa|\$85/.test(said[0]), { r, said });
  check("stored as theirs (owner); Cue is told that one text is the whole delivery (review of #148: no second text)", ins?.params[1] === "owner-a" && /send nothing more about it, no summary, no second text/.test(r.note));
  said.length = 0;
  const bad = await tools.makePage.execute({ ...input, sections: [{ heading: "Also", blocks: [{ type: "text", text: "Ellis Park is coming too, newly divorced and looking to meet people." }] }], line: "Here it is." }, {});
  check("rule 6: a page that fails the grounding isn't made, and Cue is told to give the points in a text", !bad.ok && said.length === 0 && /give them the points in a text/.test(bad.error) && notDone.length === 1, bad);
}
{
  said.length = 0;
  next = (sql: string) => (/SELECT id, data->>'title'/.test(sql) ? { rows: [{ id: "A".repeat(24), title: "Saturday in the Mission", updated_at: new Date() }] } : /UPDATE co_pages SET data/.test(sql) ? { rows: [{ version: 2 }] } : { rows: [], rowCount: 1 });
  const r = await tools.updatePage.execute({ ...input, page: "the Mission page", changed: "swapped Friday dinner for Saturday at Mesa Verde" }, {});
  const upd = calls.find((c) => /UPDATE co_pages SET data/.test(c.sql));
  check("rule 3: the same page (its id, their ownership) and 'Updated the page: what changed', no link, no contents", r.ok && upd?.params[0] === "A".repeat(24) && upd?.params[1] === "owner-a" && said.length === 1 && said[0] === "Updated the page: swapped Friday dinner for Saturday at Mesa Verde.", { r, said });
  const quiet: any = P.pageTools(ctx, { say: async () => false, notDone: () => {}, source: async () => source });
  const unsent = await quiet.updatePage.execute({ ...input, page: "mission", changed: "moved it to 8" }, {});
  check("review of #148: an 'updated' line that didn't send isn't counted as told; Cue says it in its reply", unsent.ok && /didn't send: say in your reply/.test(unsent.note) && facts.some((f) => /but the text saying so didn't send/.test(f)), unsent);
  const down = await tools.takeDownPage.execute({ page: "mission" }, {});
  const td = calls.find((c) => /SET taken_down_at = NOW\(\), data = '\{\}'::jsonb/.test(c.sql));
  check("take-down: their own page only, content wiped", down.ok && td?.params[0] === "A".repeat(24) && td?.params[1] === "owner-a");
  const none = await tools.takeDownPage.execute({ page: "brunch" }, {});
  check("a page they don't have is never guessed", !none.ok);
}
S.useCoPageDb(null);

// ---------------------------------------------------------------- review of #148: images kept, and never a long wait
{
  const img = { url: "https://alder.example/hero.jpg", alt: "Alder and Ash, from its own page", sourceUrl: "https://alder.example/" };
  const before = { title: "T", context: "C", cover: null, sources: [], sections: [{ heading: "Where to eat", image: img, blocks: [{ type: "links", items: [{ name: "Alder and Ash", note: null, url: "https://alder.example/", group: null }] }] }] };
  const after = { ...before, sections: [{ ...before.sections[0], image: null, blocks: [{ type: "links", items: [{ name: "Alder and Ash", note: "Now Saturday.", url: "https://alder.example/", group: null }] }] }] };
  const kept = await P.withImages(after, before, 500, async (d: any) => ({ data: d }));
  check("an edit keeps the image a section had, while it still links that place", kept.sections[0].image?.url === img.url);
  const moved = { ...after, sections: [{ ...after.sections[0], blocks: [{ type: "links", items: [{ name: "Mesa Verde", note: null, url: "https://mesa.example/", group: null }] }] }] };
  check("…and drops it when the section no longer links its source", (await P.withImages(moved, before, 500, async (d: any) => ({ data: d }))).sections[0].image === null);
  const t0 = Date.now();
  const slow = await P.withImages(after, null, 60, () => new Promise(() => {}));
  check("a slow image read never holds the page past the deadline: it goes without images", Date.now() - t0 < 1000 && slow.sections[0].image === null, Date.now() - t0);
}

// ---------------------------------------------------------------- rule 1 and the wiring
{
  const make: any = Cap.ABILITIES.find((a: any) => a.tool === "makePage");
  check("rule 1: Cue picks the format and never asks; text, page, PDF, Google Doc each have their case", !!make && /never ask \\"a page or a PDF\?\\"|never ask "a page or a PDF\?"/.test(make.use) && /one fact or a short answer is a text/.test(make.use) && /a file to download, print or attach is a PDF/.test(make.use) && /a Google Doc only when they ask for one/.test(make.use), make?.use);
  check("rule 2 in Cue's own guidance: ONE text, nothing about the contents", /ONE text, your line saying what you made plus its link, and nothing about its contents in the chat/.test(make.use));
  check("update and take-down are registered, bounded", ["updatePage", "takeDownPage"].every((t) => Cap.ABILITIES.some((a: any) => a.tool === t && a.limits)));
  check("on calls too", ["makePage", "updatePage", "takeDownPage"].every((t) => (CT.CALL_TOOL_NAMES as readonly string[]).includes(t)));
  const lt = fs.readFileSync(new URL("../../src/agent/loopTools.ts", import.meta.url), "utf8");
  check("grounded on the same source as a document: their words and what Cue read this turn", /const pages = pageTools\(ctx, \{ say, notDone, source: pageSource \}\);/.test(lt) && /\.\.\.pages,/.test(lt));
  const ct = fs.readFileSync(new URL("../../../co-test/src/server.ts", import.meta.url), "utf8");
  check("served on co-test at /d, behind the public-page rate limit", /app\.use\("\/d", createCoPageRouter\(\)\);/.test(ct) && /"\/mo\/unsubscribe", "\/d"\], limiter\)/.test(ct));
}

console.log(`co page tools: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
