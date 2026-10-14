// Live check of discretion on the real reply agent (harness/discretion.ts): a
// member says yes to "want to hear who?" and the reveal gate then blocks. The
// same replies are run with the instruction the gate gave before (say so
// briefly and honestly) and the one it gives now, and every reply is held to
// the discretion checks. About $2 a run (16 reply-agent calls); nothing sent.
//   npx tsx evals/discretion/run.ts
import "../lib/requireMeter.js";
import "dotenv/config";
import { addFact, baseReplyFacts, addInstruction } from "../../src/harness/replyGrounding.js";
import { runConversationReplyAgent } from "../../src/agent/conversationReply.js";
import { capitalizeSentences } from "../../src/services/textStyle.js";
import { discretionInstruction, discretionProblems } from "../../src/harness/discretion.js";

const OLD = `\nThey said yes to hearing who it was, but that introduction isn't available anymore. Say so briefly and honestly, don't name or describe anyone, and don't promise another one.`;
const NEW = discretionInstruction("They said yes to hearing who it was, and you can't go further on that one. Don't promise another one.", { neutral: true });
const messages = ["Yes!", "Sure", "go ahead", "who is it?", "yeah tell me who", "yes please", "ok who", "definitely"];

async function reply(message: string, instruction: string) {
  const rf = baseReplyFacts();
  addFact(rf, "pending", "Cue asked them: someone in Cue's network came to mind for what they're looking for, want to hear who?");
  addInstruction(rf, instruction);
  const out = await runConversationReplyAgent(
    {
      userId: "00000000-0000-0000-0000-000000000000",
      phoneNumber: "+10000000000",
      firstName: "Sam",
      resolvedContent: message,
      isVoice: false,
      imageForVision: null,
      hasPendingOffer: true,
      recentOfferBurstActive: false,
      callAction: "none",
      isThinProfileFirstMessage: false,
      isFirstContact: false,
      missingTopic: null,
      missingTopicDescription: null,
      facts: rf,
      toneContext: "",
      seekingModeContext: "",
      styleHint: "",
      recentConversation: `Co replied: Someone in the network came to mind for what you're after. Want to hear who?\nUser said: ${message}`,
      recentMemories: "",
      contextSummary: "",
      personaPrompt: null,
      sendCoReply: async () => {},
    },
    { dryRun: true, record: false },
  );
  return { text: capitalizeSentences(out.replyText), replacedByLine: out.grounding.some((g) => g.checks.some((c) => c.name === "discretion")) };
}

// Without the approved-line requirement (the old instruction never offered them):
// apology, retraction, machinery, dead end, fragment.
const bare = (t: string) => discretionProblems(t).filter((p) => !/approved/.test(p));

for (const [label, inst] of [["BEFORE (old instruction)", OLD], ["AFTER (discretion instruction)", NEW]] as const) {
  console.log(`\n== ${label}`);
  let broken = 0, replaced = 0, own = 0;
  for (const m of messages) {
    const r = await reply(m, inst);
    const p = bare(r.text);
    if (p.length) broken++;
    if (r.replacedByLine) replaced++;
    else if (label.startsWith("AFTER") && discretionProblems(r.text).length === 0) own++;
    console.log(`  "${m}" -> ${p.length ? "BAD " : "ok  "} ${r.replacedByLine ? "[approved line used by the backstop] " : ""}${r.text.replace(/\n/g, " / ")}${p.length ? `   <- ${p.join("; ")}` : ""}`);
  }
  console.log(`  ${broken}/${messages.length} had an apology, retraction, machinery, dead end or fragment${label.startsWith("AFTER") ? `; the model chose an approved line itself ${own}/${messages.length}, the backstop stepped in ${replaced}/${messages.length}` : ""}`);
  if (label.startsWith("AFTER") && broken) process.exitCode = 1;
}
