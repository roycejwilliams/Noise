// The rename sweep, layer 1 (Royce, 2026-10-14: "a member-facing sweep finds no 'Co', 'Mo', or 'CoPatible' anywhere a member can
// see"). Two halves: every string a member could see or a model reads, in the code, the dashboard and the prompt files (evals/lib/
// nameScan.ts, with its justified allowlist), and what the code actually renders for a member: the onboarding lines, the contact
// card, the name notice, the invite text, the emails, a document's file name, the call agent's name and opening. Zero tokens.
//
//   npx tsx evals/capabilities/nameSweep.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import path from "node:path";
import { oldNameHits, oldNamesIn, staleAllowances } from "../lib/nameScan.js";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 1500)}`}`);
  }
};
const repo = path.join(new URL("../../", import.meta.url).pathname, "..");

const hits = oldNameHits(repo);
check("no string in the code, the dashboard or the prompts says Co, Mo or CoPatible (justified exceptions aside)", hits.length === 0, hits);
const stale = staleAllowances(repo);
check("every exception is still in use (a stale one is removed, so the list never outlives its reason)", stale.length === 0, stale);
check("the sweep sees through the allowlist: a stray old name next to an allowed one is still caught", oldNamesIn("Co replied: hi, it's Co").length === 2 && oldNamesIn("Co-working space").length === 0 && oldNamesIn("company, co-founder, Costco, Coachella, Mono").length === 0);

// What a member actually gets, rendered by the code.
const OL = await import("../../src/services/onboardingLines.js");
const lines = [...OL.GATE_ASK, ...OL.WRONG_CODE, ...OL.WELCOME, ...OL.HOW_IT_WORKS, ...OL.CARD, ...OL.NAME_EMAIL, ...OL.WELCOME_INVITED, ...OL.INVITE_JOINED].map((l) => OL.pickLine([l], { firstName: "Jordan", inviter: "Noor" } as any));
check("onboarding: every line is free of the old names, and the first text says Cue", lines.every((l) => !oldNamesIn(l).length) && OL.GATE_ASK.every((l) => /\bCue\b/.test(l)), lines.filter((l) => oldNamesIn(l).length));
const { buildCoVCard } = await import("../../src/utils/vcard.js");
const card = buildCoVCard("+14155550100");
check("the contact card is Cue", /FN:Cue\b/.test(card) && !oldNamesIn(card).length, card);
const NC = await import("../../src/services/nameChange.js");
check("the name notice says Cue, never the old name", !oldNamesIn(NC.NAME_CHANGE_TEXT).length && !oldNamesIn(NC.NAME_CHANGE_RIDE).length && /Cue/.test(NC.NAME_CHANGE_TEXT));
const INV = await import("../../src/services/invites.js");
const greeting = INV.inviteGreeting("Noor", "ABCD1234");
check("an invite's prefilled text greets Cue", /\bCue\b/.test(greeting) && !oldNamesIn(greeting).length, greeting);
const ED = await import("../../src/services/emailDesign.js");
const mails = [
  ED.quietEmail({ preview: "p", headline: "Your code", code: "123456", note: "n" }),
  ED.letterpressEmail({ preview: "p", headline: "h", lead: "l", steps: ["a"], cta: { label: "Text Cue", href: "sms:+1" } }),
  ED.galleryEmail({ preview: "p", eyebrow: "e", headline: "h", body: ["b"], close: "c" }),
];
check("the code's emails sign as Cue, never Co", mails.every((m) => !oldNamesIn(m.replace(/<[^>]+>/g, " ")).length), mails.map((m) => oldNamesIn(m.replace(/<[^>]+>/g, " "))));
const E = await import("../../src/services/elevenLabsCalls.js");
const fs = await import("node:fs");
const prompt = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const agent: any = E.buildAgentConfig({ name: "Cue (dev)", prompt, voiceId: "v", apiUrl: "https://example.com" });
check("the call agent's stored opening line says nothing of the old names", !oldNamesIn(String(agent.conversation_config.agent.first_message)).length, agent.conversation_config.agent.first_message);
check("the call agent's voicemail and goodbye lines are clean", !oldNamesIn(JSON.stringify(agent.conversation_config.agent.prompt.tools) + agent.conversation_config.agent.max_conversation_duration_message).length);
const push = fs.readFileSync(new URL("../../src/scripts/pushElevenLabsAgent.ts", import.meta.url), "utf8");
check("the call agent is pushed under the name Cue", /name: `Cue \(\$\{new URL\(apiUrl\)\.hostname\}\)`/.test(push));

console.log(`name sweep: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
