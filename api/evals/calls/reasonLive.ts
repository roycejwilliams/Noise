// Live spot-check (Layer 2, metered, a few cents at most): does an outbound opening written from a call reason open on the
// member's moment and not on Co's homework, when the context also holds a deliverable Co sent? Three lines, Haiku.
//   npm run -s eval:live -- evals/calls/reasonLive.ts
import "../lib/requireMeter.js";
import "dotenv/config";
const { openingPrompt, openingSource, openingVerdict } = await import("../../src/services/callOpening.js");
const R = await import("../../src/services/callReason.js");
const { MODELS } = await import("../../src/models.js");
const Anthropic = (await import("@anthropic-ai/sdk")).default;

const summary =
  "Where things stand now: Cue sent Jordan the post-event branding plan PDF this morning.\n\n" +
  "What you know about them right now:\nJordan is a founder in San Francisco building a climate data startup. They pitch at the Bay Climate demo day on Thursday and said they were nervous about the Q&A. " +
  "They like small dinners more than big mixers. ".repeat(6);
const reason = R.callReasonFor({
  now: new Date("2026-10-06T18:00:00Z"), zone: "America/Los_Angeles", kind: "checkin_cadence", nudges: [], claims: [], milestones: [], plans: [], recentReasonKeys: [],
  coWork: ["Post-event branding plan"],
  threads: [{ id: "t1", text: "pitching at the Bay Climate demo day", openedQuote: "I pitch at the Bay Climate demo day Thursday, nervous about Q&A", openedAt: "2026-10-03T17:00:00Z", status: "open", feeling: "nervous", dueDate: "2026-10-08", nextStep: "check_in", kind: "thread", closedQuote: null, lastTouchedAt: "2026-10-03T17:00:00Z" }],
}).reason;
if (!reason) throw new Error("expected a reason");
const source = openingSource(summary, "outbound", reason);
const prompt = openingPrompt({ firstName: "Jordan", direction: "outbound", summary: source, reason });
const client = new Anthropic();
let ok = 0;
for (let i = 0; i < 3; i++) {
  const r: any = await client.messages.create({ model: MODELS.haiku, max_tokens: 120, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] } as any);
  const line = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  const v = openingVerdict(line, source, "Jordan");
  const onMoment = /demo day|pitch|bay climate/i.test(line);
  const homework = /pdf|branding plan|landed|sent/i.test(line);
  if (v.ok && onMoment && !homework) ok++;
  console.log(`${v.ok ? "ok " : "BAD"} moment=${onMoment} homework=${homework} :: ${line}${v.ok ? "" : ` (${v.why})`}`);
}
console.log(`reason opening live: ${ok}/3 passed`);
