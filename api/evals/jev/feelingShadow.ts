// Model-free checks for Jev's shadow feeling read (services/jevShadow.ts): the
// feeling questions are asked in one request, the row is logged next to the
// Sonnet read with no message text, nothing reaches the reply, and a Jev that
// fails or hangs changes nothing for the member. Jev is a stub; no network,
// and the database is a stub that records inserts.
//
//   npx tsx evals/jev/feelingShadow.ts
import "../testEnv.js";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const { default: pool } = await import("../../src/db/db.js");
const { setJevGatewayForTests } = await import("../../src/services/jevGateway.js");
const S = await import("../../src/services/jevShadow.js");

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(20);

// Every insert, as written.
const rows: { sql: string; params: any[] }[] = [];
(pool as any).query = async (sql: string, params: any[] = []) => {
  rows.push({ sql, params });
  return { rows: [] };
};
const lastRow = () => {
  const r = rows[rows.length - 1];
  return r ? { decision: r.params[1], userId: r.params[2], outcome: r.params[3], action: r.params[4], proposal: JSON.parse(r.params[5]), raw: JSON.stringify(r.params) } : null;
};

process.env.AI_GATEWAY_API_KEY = "k";
process.env.JEV_MEMBER = "on";

const MESSAGE = "honestly exhausted, the Austin move with Priya is eating every weekend";
const CO_LAST = "How did the apartment viewing in Austin go?";
const read: any = {
  router: { call: "none", wantsRecommendation: false },
  latencyMs: 3400,
  emotion: { emotion: "exhausted", intensity: "medium", valence: "negative", about: "the Austin move with Priya", target: "life" },
  seeking: null,
  moment: { mode: "sharing", topic: "moving to Austin with Priya", pushback: "not the viewing, the move itself", lesson: "ask about the move", dots: [] },
  feedback: [],
  aboutSent: null,
  aboutCo: false,
  ack: null,
  coverage: null,
};
const FEELING_KEYS = ["hopeful", "drained", "playful", "serious", "wants_heard", "wants_advice", "complete"];
const ROUTING_KEYS = ["small_talk", "logistics", "sharing", "reacting", "feedback", "pushback", "wants_search", "wants_call"];

// ---------------------------------------------------------------- the questions, in one request
{
  const calls: { state: any; questions: Record<string, any> }[] = [];
  setJevGatewayForTests(async (state, questions) => {
    calls.push({ state, questions });
    return { hopeful: 0.04, drained: 0.9312, playful: 0.03, serious: 0.71, wants_heard: 0.82, wants_advice: 0.12, complete: 0.05 };
  });
  rows.length = 0;
  const p = S.startJevShadow(MESSAGE, CO_LAST, false);
  check("Jev is asked when member text is allowed", p !== null);
  const ret = S.logJevShadow("u1", p, read);
  check("logging returns at once (nothing to await on the reply path)", ret === undefined && rows.length === 0);
  await settle();
  check("one Jev request per text", calls.length === 1);
  const q = calls[0]?.questions ?? {};
  check("the feeling questions are asked, every one a yes/no probability", JSON.stringify(Object.keys(q)) === JSON.stringify(FEELING_KEYS) && Object.values(q).every((x: any) => x.type === "boolean" && typeof x.instructions === "string" && x.criteria?.true && x.criteria?.false));
  check("no routing question is asked any more (wants_call included)", ROUTING_KEYS.every((k) => !(k in q)));
  check("Jev sees the same state as before, nothing more", JSON.stringify(Object.keys(calls[0]?.state ?? {}).sort()) === JSON.stringify(["co_last_message", "latest_message", "replied_inline_to_co"]));

  const row = lastRow();
  check("one row, logged as jev.shadow.feeling", rows.length === 1 && row?.decision === "jev.shadow.feeling" && row.userId === "u1" && row.outcome === "act" && row.action === "read");
  check("Jev's side: a rounded probability per question", JSON.stringify(Object.keys(row?.proposal.jev ?? {})) === JSON.stringify(FEELING_KEYS) && row?.proposal.jev.drained === 0.931);
  check("Sonnet's side next to it: mode, pushback, seeking, and the emotion read", JSON.stringify(row?.proposal.sonnet) === JSON.stringify({ mode: "sharing", pushback: true, seeking: null, emotion: { word: "exhausted", valence: "negative", intensity: "medium", target: "life" } }));
  check("timings and the question version are kept", row?.proposal.v === S.JEV_FEELING_VERSION && typeof row?.proposal.jevMs === "number" && row?.proposal.sonnetMs === 3400);
  check("no message text in the row: not the text, Cue's last line, the read's topic, pushback, or what the feeling is about", !!row && !["exhausted, the", "Austin", "Priya", "apartment", "not the viewing", "ask about the move", "weekend"].some((w) => row.raw.includes(w)));
}

// ---------------------------------------------------------------- the emotion word is a closed set
{
  const side = S.sonnetSide({ ...read, emotion: { ...read.emotion, emotion: "dreading the priya thing" } });
  check("an emotion word outside the known list is logged as 'other', never as written", side.emotion?.word === "other");
  check("no emotion read logs as null", S.sonnetSide({ ...read, emotion: null }).emotion === null);
}

// ---------------------------------------------------------------- off where member text isn't allowed
{
  let asked = 0;
  setJevGatewayForTests(async () => {
    asked++;
    return null;
  });
  process.env.JEV_MEMBER = "off";
  check("JEV_MEMBER off: Jev isn't asked", S.startJevShadow(MESSAGE, CO_LAST, false) === null && asked === 0);
  process.env.JEV_MEMBER = "on";
  check("an empty text isn't sent", S.startJevShadow("  ", CO_LAST, false) === null && asked === 0);
  rows.length = 0;
  S.logJevShadow("u1", null, read);
  S.logJevShadow("u1", S.startJevShadow(MESSAGE, CO_LAST, false), null);
  await settle();
  check("no shadow or no read: nothing logged, nothing thrown", rows.length === 0);
}

// ---------------------------------------------------------------- Jev fails or hangs: nothing changes for the member
{
  rows.length = 0;
  setJevGatewayForTests(async () => {
    throw new Error("gateway down");
  });
  let threw = false;
  try {
    S.logJevShadow("u1", S.startJevShadow(MESSAGE, CO_LAST, false), read);
    await settle();
  } catch {
    threw = true;
  }
  const r1 = lastRow();
  check("a failed Jev throws nothing and logs 'unavailable' with no answers", !threw && r1?.outcome === "skip" && r1.action === "unavailable" && r1.proposal.jev === null && r1.proposal.sonnet.mode === "sharing");

  rows.length = 0;
  setJevGatewayForTests(async () => null);
  S.logJevShadow("u1", S.startJevShadow(MESSAGE, CO_LAST, false), read);
  await settle();
  check("Jev answering nothing logs the same 'unavailable'", lastRow()?.action === "unavailable");

  rows.length = 0;
  setJevGatewayForTests(() => new Promise(() => {}));
  const t0 = Date.now();
  S.logJevShadow("u1", S.startJevShadow(MESSAGE, CO_LAST, false), read);
  const took = Date.now() - t0;
  await sleep(50);
  check("a Jev that never answers costs the turn nothing (returns at once, nothing logged yet)", took < 20 && rows.length === 0);

  (pool as any).query = async () => {
    throw new Error("db down");
  };
  setJevGatewayForTests(async () => ({ hopeful: 0.5, drained: 0.5, playful: 0.5, serious: 0.5, wants_heard: 0.5, wants_advice: 0.5, complete: 0.5 }));
  let threw2 = false;
  try {
    S.logJevShadow("u1", S.startJevShadow(MESSAGE, CO_LAST, false), read);
    await settle();
  } catch {
    threw2 = true;
  }
  check("a failed log write throws nothing", !threw2);
  setJevGatewayForTests(null);
}

// ---------------------------------------------------------------- nothing reaches a reply, prompt or decision
{
  const srcRoot = new URL("../../src/", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (f === "_archive" || f === "node_modules") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(srcRoot);
  const importers = files.filter((f) => /services\/jevShadow\.js/.test(readFileSync(f, "utf8")));
  check("only the text route uses the shadow", importers.length === 1 && importers[0].endsWith("routes/sendblue.ts"));
  const sb = readFileSync(join(srcRoot, "routes/sendblue.ts"), "utf8");
  check("the route imports only start and log", /import \{ logJevShadow, startJevShadow \} from "\.\.\/services\/jevShadow\.js";/.test(sb));
  check("the shadow promise is only started and handed to the log, never awaited or read", (sb.match(/jevShadowP/g) ?? []).length === 2 && /logJevShadow\(user\.id, jevShadowP, turnRead\);/.test(sb) && !/await jevShadowP|jevShadowP\.then|jevShadowP\)\./.test(sb));
  const js = readFileSync(join(srcRoot, "services/jevShadow.ts"), "utf8");
  check("the decision date is in the code", /review on 2026-11-12/.test(js));
  check("Jev keeps the 3s cap through the zero-retention gateway", /askJevZdr\([^\n]*JEV_FEELING_QUESTIONS, 3000\)/.test(js));
}

console.log(`jev feeling shadow: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
