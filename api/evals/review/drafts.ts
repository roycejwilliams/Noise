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

// Review of #286: what it must not refuse, and what it still must.
{
  const now = new Date("2026-10-27T18:00:00Z"); // a Tuesday; Saturday is Oct 31, Nov 1 is a Sunday
  const Z = "America/Los_Angeles";
  const gaps = (draft: string, backing: string) => LT.draftFactGaps(draft, backing, now, Z);
  const me = "Jordan Lee +14155550123 jordan92@example.com";
  check("their own phone and email in the sign-off are theirs", gaps("Thanks, Jordan Lee, 415-555-0123, jordan92@example.com", `table for 8 ${me}`).length === 0, gaps("Thanks, Jordan Lee, 415-555-0123, jordan92@example.com", `table for 8 ${me}`));
  check("'7pm' they said, drafted as '7:00 PM', is the same time", gaps("Could we come at 7:00 PM?", "dinner at 7pm").length === 0);
  check("a year is never a claim", gaps("for October 2026", "dinner in october").length === 0);
  check("'this Saturday' made exact is checked: the right date passes", gaps("on Saturday, October 31", "this saturday").length === 0, gaps("on Saturday, October 31", "this saturday"));
  check("... and a date whose weekday is wrong is held", gaps("on Saturday, November 1", "this saturday").join() === "1", gaps("on Saturday, November 1", "this saturday"));
  check("a time they never gave is held, said as written, no '00' noise", JSON.stringify(gaps("at 8:30 PM for 8", "8 of us at 7:30")) === JSON.stringify(["8:30 PM"]), gaps("at 8:30 PM for 8", "8 of us at 7:30"));
}

console.log(`drafts: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
