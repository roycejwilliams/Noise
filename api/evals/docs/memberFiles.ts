// Document intake on the four rules (services/memberFiles.ts, the writeFromFile and deleteMyFiles tools, routes/sendblue.ts intake).
// Model-free: a fake database, the drafting model and the sending stood in for.   npx tsx evals/docs/memberFiles.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY = "unused-in-tests";
import fs from "node:fs";
import path from "node:path";
const { default: pool } = await import("../../src/db/db.js");
const F = await import("../../src/services/memberFiles.js");
const LT = await import("../../src/agent/loopTools.js");
const Cap = await import("../../src/services/capabilities.js");
const srcDir = new URL("../../src/", import.meta.url).pathname;
const src = (p: string) => fs.readFileSync(path.join(srcDir, p), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

type Handler = [RegExp, (sql: string, p: any[]) => any];
const log: { sql: string; p: any[] }[] = [];
let handlers: Handler[] = [];
(pool as any).query = async (sql: string, p: any[] = []) => {
  log.push({ sql, p });
  for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, p);
  return { rows: [], rowCount: 0 };
};
const reset = (h: Handler[]) => { log.length = 0; handlers = h; };
const ran = (re: RegExp) => log.some((l) => re.test(l.sql));
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 32)]);
const FILE_TEXT = "Harbor Hall venue terms. Capacity 120 standing. Load-in from 5pm. Bar minimum of 4000 dollars on Friday nights. Contact for the venue is their events lead.";

// ---- rule 1: only what they send, and only a PDF by its own bytes
check("a PDF is known by its own bytes, not its name or type", F.isPdf(PDF) && !F.isPdf(Buffer.from("<html>%PDF-</html>")) && !F.isPdf(Buffer.alloc(4)));
{
  reset([]);
  check("not a PDF: refused, nothing stored", (await F.keepFile("u1", Buffer.from("GIF89a........"), null, async () => "x")).ok === false && !ran(/INSERT INTO member_files/));
  reset([]);
  check("too large: refused before it's read", (await F.keepFile("u1", Buffer.concat([PDF, Buffer.alloc(F.FILE_LIMITS.maxBytes)]), null, async () => { throw new Error("read"); })).ok === false && !ran(/INSERT/));
  reset([[/COUNT\(\*\)::int AS n FROM member_files/, () => ({ rows: [{ n: 0 }] })], [/INSERT INTO member_files/, () => ({ rows: [{ n: 1 }] })]]);
  let read = 0;
  const k = await F.keepFile("u1", PDF, "https://cdn.sendblue.co/x/Harbor%20Hall.pdf", async () => { read++; return FILE_TEXT; });
  const ins = log.find((l) => /INSERT INTO member_files/.test(l.sql))!;
  check("a PDF they sent is read once and kept for them, numbered in their own count", k.ok && k.n === 1 && read === 1 && ins.p[0] === "u1" && /SELECT COALESCE\(MAX\(n\), 0\) \+ 1 FROM member_files WHERE user_id = \$1/.test(ins.sql) && ins.p[4] === FILE_TEXT && ins.p[1] === "Harbor Hall.pdf");
  reset([[/SELECT n, text FROM member_files WHERE user_id = \$1 AND sha256 = \$2/, () => ({ rows: [{ n: 3, text: "t" }] })]]);
  const again = await F.keepFile("u1", PDF, null, async () => { throw new Error("read twice"); });
  check("the same file again is the one on file (per member, by hash): not read or stored twice", again.ok && again.n === 3 && !again.isNew && !ran(/INSERT/) && log[0].p[0] === "u1");
  reset([[/COUNT\(\*\)::int AS n FROM member_files/, () => ({ rows: [{ n: 20 }] })]]);
  check("past 20 files Co says so rather than keep more", (await F.keepFile("u1", PDF, null, async () => "t")).ok === false && !ran(/INSERT/));
  reset([[/COUNT\(\*\)::int AS n FROM member_files/, () => ({ rows: [{ n: 0 }] })]]);
  check("a file Co couldn't read isn't kept at all", (await F.keepFile("u1", PDF, null, async () => null)).ok === false && !ran(/INSERT/));
}
{
  const sb = src("routes/sendblue.ts");
  const intake = sb.slice(sb.indexOf("files.isPdf(fileBytes)"), sb.indexOf("} else {", sb.indexOf("files.isPdf(fileBytes)")));
  check("intake: only the member's own inbound file (keepFile with their own user id, from their own message's media)", /files\.keepFile\(user\.id, fileBytes, media_url\)/.test(intake));
  check("intake: what's recorded of the turn is the file's number, never its name or a word of it", /\[sent a PDF, kept as their file #\$\{kept\.n\}\]/.test(intake) && !/title|summary|text\b/.test(intake.replace(/resolvedContent/g, "")));
  const fact = sb.slice(sb.indexOf("if (fileKept) {"), sb.indexOf("} else if (fileNotKept)"));
  check("intake: Co is told only that it's kept and its number, and not to guess what it says", /their file #\$\{fileKept\.n\}/.test(fact) && /don't know what it says/.test(fact) && !/fileText|\.text\b/.test(fact));
  check("never from a linked account: nothing reads Google Drive or Gmail into a member's files", !/googleapis|accessTokenFor|drive/i.test(src("services/memberFiles.ts").replace(/\/\/.*$/gm, "")));
}

// ---- rule 2: that member only
{
  const mf = src("services/memberFiles.ts");
  const stmts = [...mf.matchAll(/`((?:SELECT|INSERT|UPDATE|DELETE)[^`]*member_files[^`]*)`/g)].map((m) => m[1]);
  check("every statement on member_files is scoped to the member's own id ($1)", stmts.length >= 7 && stmts.every((q) => /user_id = \$1/.test(q) || /^INSERT INTO member_files \(user_id/.test(q.trim())), stmts.filter((q) => !/user_id = \$1/.test(q)));
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.ts$/.test(e.name)) files.push(f); } };
  walk(srcDir);
  const touching = files.filter((f) => /member_files/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(srcDir, f)).sort();
  check("only memberFiles.ts (and the migration) touches the table: no other reader exists to leak it", touching.join() === "db/migrations.ts,services/memberFiles.ts", touching);
  const lt = src("agent/loopTools.ts");
  const body = lt.slice(lt.indexOf("writeFromFile: tool("), lt.indexOf("deleteMyFiles: tool("));
  check("the tool reads only this member's file (ctx.userId), never an id Co supplies", /F\.fileText\(ctx\.userId, input\.file \?\? null\)/.test(body) && !/userId: z\./.test(body));
}

// ---- the tool: drafted apart from the conversation, and nothing of the file recorded
const notDone: string[] = [];
const facts: string[] = [];
const ctx: any = { userId: "u1", phoneNumber: "+15550100001", firstName: "Jordan", resolvedContent: "can you turn the venue PDF into a venue brief?", turn: { message: "" }, dryRun: false, facts: { add: (_k: string, t: string) => facts.push(t) }, sendCoReply: async () => true };
const make = () => LT.loopTools(ctx, { sent: false, sentMessages: [] }, LT.newLoopState(), (w: string) => notDone.push(w)) as any;
const filesHandlers = (rows: any[] = [{ n: 2, text: FILE_TEXT }]): Handler[] => [[/SELECT n, text FROM member_files WHERE user_id = \$1/, () => ({ rows })], [/FROM co_memories/, () => ({ rows: [{ memory_type: "text_exchange", content: "User said: I'm planning the Friday dinner at Harbor Hall for 120 people" }] })], [/SELECT first_name FROM users/, () => ({ rows: [{ first_name: "Jordan" }] })], [/INSERT INTO co_memories/, () => ({ rows: [{ id: 1 }] })]];
const sent: any[] = [];
F.fileSteps.deliver = (async (doc: any, to: any, target: any) => { sent.push({ doc, to, target }); return { ok: true, via: target, filename: "x" }; }) as any;
{
  const grounded = { title: "Harbor Hall venue brief", note: "For the Friday dinner.", kind: "venue_brief", sections: [{ heading: "The space", bullets: ["Capacity 120 standing.", "Load-in from 5pm.", "Bar minimum of 4000 dollars on Friday nights."] }], suggestions: [] };
  let draftSaw: any = null;
  F.fileSteps.draft = async (o: any) => { draftSaw = o; return grounded as any; };
  reset(filesHandlers());
  facts.length = 0; sent.length = 0;
  const t = make();
  const r = await t.writeFromFile.execute({ kind: "venue_brief", want: "a venue brief" }, {});
  const everything = JSON.stringify({ r, facts, notDone, logged: log.filter((l) => /INSERT INTO co_memories|harness_decisions|search_briefs|saveBrief/i.test(l.sql)).map((l) => l.p) });
  check("from their newest file: drafted from their file and their own words, sent to them only", r.ok && sent.length === 1 && sent[0].to.userId === "u1" && sent[0].to.phone === "+15550100001" && draftSaw.fileText === FILE_TEXT && /Harbor Hall for 120/.test(draftSaw.theirWords), { r, notDone });
  check("nothing the conversation keeps carries the file's words or the document's title (only 'their file #2')", !/Harbor|Capacity|Load-in|4000|venue brief"/.test(everything.replace(/a venue brief/g, "")) && /their file #2/.test(everything), everything.slice(0, 400));
  check("what Co is handed back says it's sent and not to describe it", /haven't seen what it says, so don't describe it/.test(r.note));

  F.fileSteps.draft = async () => ({ ...grounded, sections: [{ heading: "The space", bullets: ["Capacity 120 standing.", "The venue is the best in the Mission and sold out every weekend this year."] }] }) as any;
  reset(filesHandlers());
  sent.length = 0; notDone.length = 0;
  const bad = await make().writeFromFile.execute({ kind: "venue_brief", want: "a venue brief" }, {});
  check("rule 4: a draft with a claim not in their file or words is refused, nothing sent, and the refusal carries none of it", !bad.ok && sent.length === 0 && !/Mission|sold out/.test(JSON.stringify({ bad, notDone })));

  reset(filesHandlers([]));
  sent.length = 0;
  F.fileSteps.draft = async () => { throw new Error("should not draft"); };
  const none = await make().writeFromFile.execute({ file: 7, kind: "other", want: "a summary" }, {});
  check("a file number they don't have: nothing drafted or sent, and Co asks which", !none.ok && sent.length === 0 && /no file|have no file/i.test(none.error));
  check("the read asked for that number with their own id", log.some((l) => /AND n = \$2/.test(l.sql) && l.p[0] === "u1" && l.p[1] === 7));
}

// ---- rule 3: deletable on request, gone completely
{
  const yes = ["delete the PDF I sent you", "please remove my files", "forget the deck I sent", "can you erase my documents", "delete everything i sent", "my files, delete them"];
  const no = ["delete that event from my list", "I sent you a PDF", "remove me from the guest list", "forget about Friday"];
  check("their words asking to delete their files", yes.every((t) => F.DELETE_ASK.test(t)), yes.filter((t) => !F.DELETE_ASK.test(t)));
  check("and not other deletes or mentions", no.every((t) => !F.DELETE_ASK.test(t)), no.filter((t) => F.DELETE_ASK.test(t)));
  reset([[/DELETE FROM member_files/, () => ({ rowCount: 3 })]]);
  check("all of their files: deleted, theirs only", (await F.deleteFiles("u1")) === 3 && /DELETE FROM member_files WHERE user_id = \$1$/.test(log[0].sql.trim()) && log[0].p.join() === "u1");
  reset([[/DELETE FROM member_files/, () => ({ rowCount: 1 })]]);
  check("one file by its number: theirs only", (await F.deleteFiles("u1", 2)) === 1 && /WHERE user_id = \$1 AND n = \$2/.test(log[0].sql) && log[0].p.join() === "u1,2");
  reset([[/DELETE FROM member_files/, () => ({ rowCount: 2 })]]);
  ctx.resolvedContent = "delete the files I sent you";
  const d = await make().deleteMyFiles.execute({}, {});
  check("the tool deletes on their ask", d.ok && d.deleted === 2 && ran(/DELETE FROM member_files WHERE user_id = \$1/));
  reset([]);
  ctx.resolvedContent = "thanks, that looks good";
  const d2 = await make().deleteMyFiles.execute({}, {});
  check("the tool deletes nothing without their ask (code checks their words, not Co's say-so)", !d2.ok && !ran(/DELETE/));
  const mig = src("db/migrations.ts");
  check("gone completely: the text lives only in member_files, which goes with the member (ON DELETE CASCADE), with no embedding column", /CREATE TABLE IF NOT EXISTS member_files \([^`]*user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/.test(mig) && !/member_files[^`]*embedding/.test(mig));
  check("gone completely: every model call on a file keeps its prompts and outputs out of the trace store", (src("services/memberFiles.ts").match(/PRIVATE_TELEMETRY\("/g) ?? []).length === 2 && /recordInputs: false, recordOutputs: false/.test(src("services/memberFiles.ts")));
}

// ---- the registry
{
  const w = Cap.ABILITIES.find((a) => a.id === "write_from_file")!;
  const del = Cap.ABILITIES.find((a) => a.id === "delete_files")!;
  check("registry: a document from a file needs their own yes, once a turn, three a day", w?.tool === "writeFromFile" && w.confirm === "their_yes" && w.limits?.perTurn === 1 && w.limits?.perDay === 3);
  check("registry: Co says it doesn't discuss what a file says, and it's never used for anyone else", /doesn't read or discuss what a file says/.test(w.can) && /never used for anyone else/.test(w.can));
  check("registry: delete is there, and says gone completely", del?.tool === "deleteMyFiles" && /gone completely/.test(del.can));
}

console.log(`member files: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
