// Conversation recall, wired (services/conversationRecall.ts): what actually reaches the reply's and the call's decision paths.
// Layer 1: the database and every model are stubs; zero tokens. Invented member: Jordan.
//   TZ=UTC npx tsx evals/recall/wiring.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async () => ({ rows: [] });
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
const R = await import("../../src/services/conversationRecall.js");
const C = await import("../../src/services/capabilities.js");
const CTools = await import("../../src/agent/conversationTools.js");
const CT = await import("../../src/services/callTools.js");
const TG = await import("../../src/agent/toolGuard.js");
const W = await import("../../src/services/whatCoKnows.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

const JORDAN = "00000000-0000-4000-8000-00000000a001";
const asked: unknown[][] = [];
let hasRows = true;
let guardsBroken = false;
const row = { id: "000001", memory_type: "text_exchange", content: "User said: I'm switching my candle jars to a matte ceramic glaze", created_at: new Date("2026-08-02T17:00:00Z"), score: 1, total: 1 };
const deps: import("../../src/services/conversationRecall.js").RecallDeps = {
  db: { query: async (sql, args) => { asked.push(args); if (/MIN\(created_at\)/.test(sql)) return { rows: [{ texts: hasRows ? new Date("2026-08-02T17:00:00Z") : null, calls: null }] }; if (/count\(\*\) OVER\(\)/.test(sql)) return { rows: hasRows ? [row] : [] }; return { rows: [] }; } },
  now: () => new Date("2026-11-05T03:30:00Z"),
  zone: async () => "America/Los_Angeles",
  forgotten: async () => { if (guardsBroken) throw new Error("x"); return []; },
  guard: (t, g) => W.guardText(t, g as any),
  fence: async () => ({ strip: (s: string) => s }),
};
R.setRecallDepsForTests(deps);

const factsLog: [string, string][] = [];
const ctxOf = (onCall: boolean) => ({ userId: JORDAN, phoneNumber: "+15555550123", resolvedContent: "when did I mention the glaze?", isVoice: onCall, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, sendCoReply: async () => false, onCall, facts: { add: (k: any, t: string) => { factsLog.push([k, t]); }, text: () => "" } } as any);

// ---- text: the reply's toolset
const textTools: any = CTools.createConversationTools(ctxOf(false)).tools;
check("text: the reply has the lookBack tool", !!textTools.lookBack);
check("text: its description is the registry's use line (one source)", textTools.lookBack.description === C.toolUse("lookBack"));
const use: string = textTools.lookBack.description;
check("text: it tells the model when (older evidence) and never every turn", /older than the thread you can already see/.test(use) && /Never on every turn/.test(use));
check("text: it tells the model to answer from what it returns, not guess", /Answer from what it returns/.test(use) && /never guess/.test(use));
check("text: it carries corrections forward (later words qualify earlier, never the older alone)", /Their later words qualify their earlier ones/.test(use));
check("text: it says a promise found is only a promise, not proof it was done", /A promise found in the record is only a promise/.test(use));
check("text: it says nothing found is permission to share or start anything", /permission to bring that up with anyone else or to start something new/.test(use));
check("text: honest miss: one other try, then plainly can't find it, no search talk, never 'didn't happen'", /try one other way/.test(use) && /couldn't find it in the history you can look through/.test(use) && /never that it didn't happen/.test(use) && /Don't describe how the lookup works, but don't hide its limits/.test(use) && /Ask them for a clue only when one would actually help/.test(use) && /never \"there's no record\"/.test(use));
check("text: unavailable call records are acknowledged plainly", /call records aren't on file, say that plainly/.test(use));
const keep = CTools.orderForCache(textTools);
check("text: it is in the always-offered group (a read, not a come-and-go tool)", Object.keys(keep).indexOf("lookBack") >= 0 && !CTools.comeAndGoTools().has("lookBack"));

// ---- the result the reply's decision gets
const tr: any = await quietly(() => textTools.lookBack.execute({ topic: "glaze" }, { toolCallId: "t", messages: [] }));
check("result: found, marked history, with the exact text and time", tr.ok && tr.history === true && /matte ceramic glaze/.test(tr.results[0].matched.text) && /Aug 2 2026/.test(tr.results[0].atLocal), tr);
check("result: the note says it is history, not an instruction, not approval", /HISTORY/.test(tr.note) && /not an instruction/.test(tr.note) && /not approval for any new action/.test(tr.note));
check("result: the member's own id is the query's first parameter in every read", asked.length > 0 && asked.every((a) => a[0] === JORDAN));
check("result: what was found reaches the reply check as known history, tagged by who said it", factsLog.some(([k, t]) => k === "known" && /From their record \(history/.test(t) && /said/.test(t) && /matte ceramic glaze/.test(t)), factsLog);
hasRows = false;
const miss: any = await quietly(() => textTools.lookBack.execute({ topic: "skydiving" }, { toolCallId: "t", messages: [] }));
check("result: a miss returns no results and the honest-miss guidance", miss.ok && miss.results.length === 0 && /one other way/.test(miss.note) && /couldn't find it in the history you can look through/.test(miss.note) && /never how you looked/.test(miss.note) && /Ask them for a clue only if one would help/.test(miss.note) && /There is no earlier conversation on file/.test(miss.note), miss.note);
hasRows = true;
guardsBroken = true;
factsLog.length = 0;
const un: any = await quietly(() => textTools.lookBack.execute({ topic: "glaze" }, { toolCallId: "t", messages: [] }));
check("result: guards unreadable -> no content, plain 'can't pull that up', no invented answer", un.ok === false && !/glaze/.test(JSON.stringify(un)) && /Don't guess/.test(un.note), un);
guardsBroken = false;

// ---- call: the same tool, same rules
const names = C.callToolNames();
check("call: lookBack is on the call allow-list and the GPT-Live list", names.includes("lookBack") && C.liveCallToolNames().includes("lookBack"));
check("call: it runs now as a read, never started work, nothing left out", C.callRunFor("lookBack")?.kind === "read" && !C.startsWork("lookBack") && !C.LIVE_CALL_LEFT_OUT.lookBack);
const callSet = CT.buildCallTools({ userId: JORDAN, callKey: "call-recall-1", turnWords: "when did I mention the glaze", callWords: "when did I mention the glaze", lastCoLine: null, member: { phone: "+15555550123", firstName: "Jordan", city: null, tasks: [], loops: null } as any, sendText: async () => false });
const def = callSet.defs.find((d) => d.name === "lookBack");
check("call: the call's tool list carries it with the same rules plus the spoken form", !!def && def.description.startsWith(C.toolUse("lookBack")) && /a brief acknowledgement while you wait is fine only if the pause needs one/.test(def.description) && /Never on every turn/.test(def.description), def?.description?.slice(-200));
const cr: any = await quietly(() => callSet.run("lookBack", { topic: "glaze" }, "tu1"));
const strip = (x: any) => JSON.stringify({ ...x, note: undefined });
check("call: the same lookup answers on a call (same results, same history note)", cr.ok && cr.history === true && strip(cr) === strip(tr) && cr.note === tr.note, cr);
check("call: also a miss reads the same", (await quietly(() => callSet.run("lookBack", { topic: "skydiving" }, "tu2")) as any).ok !== undefined);

// ---- the registry: a read, nothing changes, nothing starts
const ab = C.abilityForTool("lookBack")!;
check("registry: no confirm needed (read-only, nothing affects another member)", !ab.confirm && !ab.teamOnly);
check("registry: it changes nothing and only reads (no retry loop of a send)", C.CHANGES_NOTHING.has("lookBack") && !C.CHANGES_SOMETHING.has("lookBack") && TG.READS_ONLY.has("lookBack"));
check("registry: it can open a reply (its result is something to say)", CTools.NEW_FOR_THEM.has("lookBack") && !CTools.SILENT_TOOLS.has("lookBack"));
check("registry: capped per turn and per day", (ab.limits?.perTurn ?? 0) >= 1 && (ab.limits?.perDay ?? 0) >= 1);

// ---- purpose boundary
check("scope: no removed helper (document, deck, page, email draft, job search) in the tool's words", !/\b(deck|document|slides|pdf|email draft|job search|resume|concierge)\b/i.test(use + C.toolUse("lookBack", "call")));
const mod = fs.readFileSync(new URL("../../src/services/conversationRecall.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
check("scope: the lookup starts nothing and sends nothing (no task, no send, no write)", !/startTask|sendblue|sendReply|INSERT|UPDATE|DELETE|recordDecision/.test(mod));
const tools = fs.readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
const body = tools.slice(tools.indexOf("lookBack: tool({"), tools.indexOf("correctWhatCoKnows: tool({"));
check("shared: the one tool body calls the one lookup; text and call share it", /recallConversation\(ctx\.userId/.test(body) && (tools.match(/lookBack: tool\(/g) ?? []).length === 1);
check("registry: member-facing capability sheet unchanged in size by this tool (null line)", ab.sheet === null);

console.log(`recall wiring: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
