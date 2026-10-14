// Golden cases for the rename (Royce, 2026-10-14: "Rename the agent to Cue and the company to Noise"). Numbered from 50 (the taper
// work uses the 40s). One real reply turn each for the openers, the same way cases/checkins.ts runs one (no database, nothing
// sent); the announcement through the real send-time ledger with a fake store; the sweep over real replies and what the code
// renders; the dashboard from its own files. Invented members only (Jordan, Noor, Ellis).
import "../../lib/requireMeter.js";
import path from "node:path";
import fs from "node:fs";
import type { GoldenCase } from "../types.js";
import { result } from "../types.js";
import { DAY, NONE, THREAD_BEFORE, judge, observed, reply, voiceMisses } from "./checkins.js";
import { oldNameHits, oldNamesIn } from "../../lib/nameScan.js";
import { installFakeLedger } from "../../lib/fakeLedger.js";

const repo = path.join(new URL("../../../", import.meta.url).pathname, "..");
// Mistaking who "co" is, or turning them away over the name.
const CONFUSED = /\bwho(?:'s| is)\s+(?:co|cue)\b|\bwrong (?:number|person)\b|\bi'?m not (?:co|cue)\b|\bdid you mean\b/i;

export const CASES: GoldenCase[] = [
  {
    n: 50,
    id: "hey-cue",
    title: "\"Hey cue\": answered as Cue, the one they addressed",
    status: { live: true },
    from: "Royce, 2026-10-14, rename golden case (1): a member opens with \"hey cue\" and is answered as Cue",
    run: async () => {
      const r = await reply({ firstName: "Jordan", now: DAY, exchange: THREAD_BEFORE, searching: NONE, message: "Hey cue" });
      const misses = voiceMisses(r.text);
      if (CONFUSED.test(r.text)) misses.push("confused about who they addressed");
      const j = await judge(r.text, "The companion's name is Cue. The member texted \"Hey cue\". Nothing is running and nothing is waiting on them.", "Does the text answer them warmly as the one they addressed, without calling itself by any name other than Cue and without questioning the name? Answer yes only if all of that holds.");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return result(misses, observed(r));
    },
  },
  {
    n: 51,
    id: "hey-co-alias",
    title: "\"Hey co\" during the grace period: still answered, as Cue",
    status: { live: true },
    from: "Royce, 2026-10-14, rename golden case (2): \"keep answering to 'hey co' as an alias for a grace period\"",
    run: async () => {
      // The pinned clock (Oct 13, 2026) is inside the alias (services/agentName.ts CO_ALIAS_UNTIL, 2027-01-31).
      const { coAliasActive } = await import("../../../src/services/agentName.js");
      const r = await reply({ firstName: "Noor", now: DAY, exchange: THREAD_BEFORE, searching: NONE, message: "Hey co" });
      const misses = voiceMisses(r.text);
      if (!coAliasActive(DAY)) misses.push("the case's clock is outside the alias");
      if (CONFUSED.test(r.text)) misses.push("confused about who they addressed");
      const j = await judge(r.text, "The companion is called Cue; until recently it was called Co, and members may still say \"co\" out of habit. The member texted \"Hey co\". Nothing is running and nothing is waiting on them.", "Does the text answer them warmly as the one they addressed (no confusion about who they meant, no lecture about the name), and if it names itself at all, only as Cue? A light mention of the new name is fine. Answer yes only if all of that holds.");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return result(misses, observed(r));
    },
  },
  {
    n: 52,
    id: "rename-once",
    title: "\"I'm going by Cue now\" reaches each member exactly once: alone, riding in another text, or two sends at once",
    status: { live: true },
    from: "Royce, 2026-10-14, rename golden case (3): \"a single light 'I'm going by Cue now' message per member, tracked so it never sends twice\"",
    run: async () => {
      const P = await import("../../../src/harness/proactive.js");
      const { proactiveRegistry } = await import("../../../src/harness/proactiveRegistry.js");
      const NC = await import("../../../src/services/nameChange.js");
      const A = await import("../../../src/services/askRetire.js");
      const { carryLaneNotes } = await import("../../../src/services/laneMoves.js");
      const { default: pool } = await import("../../../src/db/db.js");
      const { default: sendblue } = await import("../../../src/services/sendblue.js");
      const f = installFakeLedger(pool, sendblue);
      const misses: string[] = [];
      try {
        const person = (firstName: string, phone: string) => ({ userId: `u-${firstName.toLowerCase()}`, firstName, phoneNumber: phone, city: "San Francisco", timezone: "America/Los_Angeles" });
        const cand = (id: string, userId: string, type: string, targetKey: string): any => ({ id, userId, type, targetKey, topicKey: targetKey, summary: "", priority: 1, dueAt: new Date(DAY.getTime() - 60_000), expiresAt: NC.NAME_CHANGE_EXPIRES, payload: {}, attempts: 0, createdAt: DAY });
        const told = (phone: string) => f.ledger.outbox.filter((m) => m.to === phone && NC.carriesNameChange(m.content)).length;
        const ride = (lines: string[]) => A.rideAlong(lines, NC.NAME_CHANGE_RIDE, (d, p) => carryLaneNotes(d, p));

        // The text itself, as the dispatch drafts it.
        const jordan = person("Jordan", "+14155550101");
        const drafted: any = await proactiveRegistry.name_change.draft(cand("n-j", jordan.userId, "name_change", NC.NAME_CHANGE_KEY), jordan);
        if (!("messages" in drafted) || drafted.messages.join(" ") !== NC.NAME_CHANGE_TEXT) misses.push(`the draft isn't the notice: ${JSON.stringify(drafted)}`);
        else if (P.checkDraft(drafted.text, drafted.rules).some((c) => !c.pass)) misses.push("the notice fails the proactive draft checks");
        // Jordan: alone, dispatched twice.
        await P.sendWithLedgerForTests(cand("n-j", jordan.userId, "name_change", NC.NAME_CHANGE_KEY), jordan, [NC.NAME_CHANGE_TEXT]);
        await P.sendWithLedgerForTests(cand("n-j", jordan.userId, "name_change", NC.NAME_CHANGE_KEY), jordan, [NC.NAME_CHANGE_TEXT]);
        if (told(jordan.phoneNumber) !== 1) misses.push(`Jordan (alone, twice) was told ${told(jordan.phoneNumber)} times`);
        // Noor: it rides in her check-in, then its own send comes up.
        const noor = person("Noor", "+14155550102");
        const without = ["How did the pitch land with the second fund?"];
        await P.sendWithLedgerForTests(cand("c-n", noor.userId, "companion", "companion:week"), noor, ride(without), {}, [], { candidate: cand("n-n", noor.userId, "name_change", NC.NAME_CHANGE_KEY), without });
        await P.sendWithLedgerForTests(cand("n-n", noor.userId, "name_change", NC.NAME_CHANGE_KEY), noor, [NC.NAME_CHANGE_TEXT]);
        if (told(noor.phoneNumber) !== 1) misses.push(`Noor (riding, then alone) was told ${told(noor.phoneNumber)} times`);
        if (f.ledger.outbox.filter((m) => m.to === noor.phoneNumber).length !== 1) misses.push("Noor got a second text for the notice");
        // Ellis: both at once.
        const ellis = person("Ellis", "+14155550103");
        const w2 = ["Thinking of you before Thursday's demo."];
        await Promise.all([
          P.sendWithLedgerForTests(cand("c-e", ellis.userId, "companion", "companion:week"), ellis, ride(w2), {}, [], { candidate: cand("n-e", ellis.userId, "name_change", NC.NAME_CHANGE_KEY), without: w2 }),
          P.sendWithLedgerForTests(cand("n-e", ellis.userId, "name_change", NC.NAME_CHANGE_KEY), ellis, [NC.NAME_CHANGE_TEXT]),
        ]);
        if (told(ellis.phoneNumber) !== 1) misses.push(`Ellis (two sends at once) was told ${told(ellis.phoneNumber)} times`);
        if (f.ledger.sends.filter((s) => s.target_key === NC.NAME_CHANGE_KEY).length !== 3) misses.push("not one ledger row per member");
      } finally {
        f.restore();
      }
      return result(misses, f.ledger.outbox.map((m) => `${m.to.slice(-4)}: ${m.content}`).join(" | "));
    },
  },
  {
    n: 53,
    id: "member-sweep",
    title: "No Co, Mo or CoPatible anywhere a member can see: real replies, rendered texts and pages, and every string in the code",
    status: { live: true },
    from: "Royce, 2026-10-14, rename golden case (4): \"a member-facing sweep finds no 'Co', 'Mo', or 'CoPatible' anywhere a member can see\"",
    run: async () => {
      const misses: string[] = [];
      // Real replies, where a model could reach for the old name.
      const who = await reply({ firstName: "Ellis", now: DAY, exchange: THREAD_BEFORE, searching: NONE, message: "Wait, who are you exactly?" });
      const can = await reply({ firstName: "Jordan", now: DAY, exchange: THREAD_BEFORE, searching: NONE, message: "What can you do for me?" });
      for (const [label, r] of [["who are you", who], ["what can you do", can]] as const) {
        if (!r.text.trim() || /^ERROR /.test(r.text)) misses.push(`${label}: no reply`);
        const old = oldNamesIn(r.text);
        if (old.length) misses.push(`${label}: says ${old.join(", ")}`);
      }
      if (!/\bCue\b/.test(who.text)) misses.push("who are you: doesn't say its name is Cue");
      // What the code renders for a member.
      const OL = await import("../../../src/services/onboardingLines.js");
      const { buildCoVCard } = await import("../../../src/utils/vcard.js");
      const NC = await import("../../../src/services/nameChange.js");
      const INV = await import("../../../src/services/invites.js");
      const ED = await import("../../../src/services/emailDesign.js");
      const LP = await import("../../../src/services/coPages/linkPreview.js");
      const rendered: [string, string][] = [
        ["first text", OL.GATE_ASK.join(" ")],
        ["contact card", buildCoVCard("+14155550100")],
        ["name notice", `${NC.NAME_CHANGE_TEXT} ${NC.NAME_CHANGE_RIDE}`],
        ["invite text", INV.inviteGreeting("Noor", "ABCD1234")],
        ["email", ED.galleryEmail({ preview: "p", eyebrow: "e", headline: "h", body: ["b"], close: "c" }).replace(/<[^>]+>/g, " ")],
        ["link preview", (LP.genericHead(null) + LP.coMarkHtml()).replace(/<[^>]+>/g, " ") + LP.genericHead(null).match(/content="[^"]*"/g)?.join(" ")],
      ];
      for (const [label, text] of rendered) if (oldNamesIn(text).length) misses.push(`${label}: says ${oldNamesIn(text).join(", ")}`);
      // Every string in the code, the dashboard and the prompts (evals/lib/nameScan.ts, justified exceptions only).
      const hits = oldNameHits(repo);
      if (hits.length) misses.push(`in the code: ${hits.slice(0, 5).join(" | ")}`);
      return result(misses, `who: ${who.text} || can: ${can.text}`);
    },
  },
  {
    n: 54,
    id: "dashboard-names",
    title: "The co-test dashboard shows Cue and Noise, never Co",
    status: { live: true },
    from: "Royce, 2026-10-14, rename golden case (5): \"the dashboard shows Cue and Noise\"",
    run: async () => {
      const misses: string[] = [];
      const pub = path.join(repo, "co-test/public");
      for (const f of fs.readdirSync(pub).filter((x) => x.endsWith(".html"))) {
        const html = fs.readFileSync(path.join(pub, f), "utf8");
        const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
        if (!/\bCue\b/.test(title)) misses.push(`${f}: the title doesn't say Cue (${title})`);
        const text = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ");
        if (oldNamesIn(text).length) misses.push(`${f}: shows ${oldNamesIn(text).join(", ")}`);
      }
      const sidebar = fs.readFileSync(path.join(repo, "co-test/src/client/sidebar.ts"), "utf8");
      if (!/<span>Cue \(test\) · Noise<\/span>/.test(sidebar)) misses.push("the sidebar brand doesn't show Cue and Noise");
      const login = fs.readFileSync(path.join(pub, "login.js"), "utf8");
      if (!/Hi Cue! \(test site code/.test(login) || /Hi Co!/.test(login)) misses.push("the sign-in text still greets Co");
      const hits = oldNameHits(repo).filter((h) => h.startsWith("co-test/"));
      if (hits.length) misses.push(`dashboard code: ${hits.join(" | ")}`);
      return result(misses, "co-test/public pages and the sidebar");
    },
  },
];
