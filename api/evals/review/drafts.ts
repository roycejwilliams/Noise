// A draft that speaks for the member is checked before they see it (Royce, 2026-10-27: Cue checks its work first; the member isn't QA
// for a wrong date or headcount). Layer 1: the real draftEmail with a fake send, zero tokens.
//   npx tsx evals/review/drafts.ts
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async () => ({ rows: [] });
const LT = await import("../../src/agent/loopTools.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 300)}` : ""}`); } };
const said: string[] = [];
const ctx: any = {
  userId: "00000000-0000-4000-8000-000000000002", phoneNumber: "+15550100002", firstName: "Jordan",
  resolvedContent: "can you write the venue a note asking about the back room for 8 of us on Saturday at 7:30?", turn: { message: "" }, dryRun: true,
  facts: { add: () => {}, text: () => "" },
  sendCoReply: async (o: any) => { said.push(o.message); return true; },
};
const make = (): any => LT.loopTools(ctx, { sent: false, sentMessages: [] }, LT.newLoopState(), () => {});
const quiet = console.log;
console.log = () => {};
const good = await make().draftEmail.execute({ subject: "Back room on Saturday", body: "Hi, could we book the back room for 8 people this Saturday at 7:30? Thanks, Jordan", why: "they asked" }, { toolCallId: "a", messages: [] });
const wrong = await make().draftEmail.execute({ subject: "Back room on Saturday", body: "Hi, could we book the back room for 12 people this Saturday at 8:30? Thanks, Jordan", why: "they asked" }, { toolCallId: "b", messages: [] });
const place = await make().draftEmail.execute({ subject: "Back room", body: "Hi, we'd love the back room for 8 at 7:30, near Dolores Park if you have it.", why: "they asked" }, { toolCallId: "c", messages: [] });
console.log = quiet;
check("draft: one that keeps to their headcount and time goes", good?.ok === true, good);
check("draft: one with a headcount and time they never gave is held, naming them", wrong?.ok === false && /"12"/.test(wrong.error) && /"8:30"/.test(wrong.error), wrong);
check("draft: one that places them somewhere they never said is held", place?.ok === false && /Dolores Park/.test(place.error), place);

console.log(`drafts: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
