// Guards around every tool Co chooses (Royce, 2026-09-25). Co decides what
// to do; this holds the lines that stay hard, the same way for every tool:
//   - a switch per ability, to turn one off without a deploy
//     (services/abilitySwitches.ts)
//   - limits per turn, per day, and never twice for the same person, so
//     choosing freely never means choosing the same thing repeatedly
//   - the member's own yes, in this message, before anything that affects
//     another member, costs money, or can't be undone
//   - a receipt and a decision log for every call: which tool, why, and
//     what actually happened, so the morning review can flag bad judgment
//     and the hourly monitor can spot drift (harness/monitor.ts)
// Limits and confirmation come from each ability's entry in
// services/capabilities.ts, so every tool gets the same guards.
import { z } from "zod";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { abilityForTool } from "../services/capabilities.js";
import { isSwitchedOff } from "../services/abilitySwitches.js";
import { recordToolAction } from "../services/coFacts.js";
import { logKind } from "../services/whatCoKnows.js";
import { guestName } from "../services/guestName.js";

// Replies and bookkeeping aren't choices worth logging one by one.
const UNGUARDED = new Set(["sendReply", "markTopicAsked"]);

import { confirmYes, QUOTE_RETRY, yesIsTheirs } from "../services/theirYes.js";

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Their yes (services/theirYes.ts, 2026-10-13): the quoted words are in what they sent this turn (code), and a short read says it's a
// yes to this offer (Haiku, only when a tool that needs it is called). One check for every tool that needs it.
export { yesIsTheirs };

type GuardCtx = {
  userId: string;
  resolvedContent: string;
  dryRun: boolean;
  notDone: (what: string) => void;
  // The exchange before their message (services/theirYes.ts exchangeText): where the offer their yes answers is. A thread's log or a
  // call's turns, built by the caller.
  recentExchange?: string | null;
};

// asked_back: the tool did nothing yet and asked a question back (requestEventIntro's "what's their last name?"). Logged, never
// counted as done: not toward perDay or oncePerPerson, not in the lasting record (2026-10-28, Royce: "a last-name answer should
// continue the existing intro"; the first-name call used to count as the request and the answer was refused as "already requested").
export type Receipt = "done" | "not_done" | "off" | "limited" | "needs_yes" | "asked_back";

// Pure: who oncePerPerson means, read exactly as the guest-list lookup reads a name (services/guestName.ts, shared with
// resolveNamedEventGuest): the first word of personName, then lastName when given or else the rest of personName. So "Sarah" + "Kim"
// and "Sarah Kim" are one person and two Sarahs are two (2026-10-28: the key was personName alone, so the last-name answer read as
// a repeat of "Sarah", and any Sarah blocked every other). Its own folding once split "Mary-Kate" from "Mary-Kate Olsen" and joined
// Mary-Kate to Mary-Ann (review of #294). "" when no name was given.
export function personKey(input: any): string {
  const { first, last } = guestName(input?.personName, input?.lastName);
  if (!first) return "";
  return last ? `${first} ${last}` : first;
}

// Pure: the receipt for a correctWhatCoKnows call that removes anything: how many changes of each action and the kinds of the refs
// (whatCoKnows.ts logKind), nothing else. Null for any other tool or a call with no removal (logged as before).
export function removalReceipt(name: string, input: any): { removal: true; changes: { remove: number; correct: number }; kinds: string[] } | null {
  if (name !== "correctWhatCoKnows") return null;
  const changes: any[] = Array.isArray(input?.changes) ? input.changes : [];
  if (!changes.some((c) => c?.action === "remove")) return null;
  const refs = changes.flatMap((c) => (Array.isArray(c?.refs) ? c.refs : []));
  return { removal: true, changes: { remove: changes.filter((c) => c?.action === "remove").length, correct: changes.filter((c) => c?.action === "correct").length }, kinds: [...new Set(refs.map((r: unknown) => logKind(String(r))))].slice(0, 10) };
}

// Pure: the receipt for a voiceRead call (services/voiceReadConsent.ts): which answer the model read, never their words or message, so
// a yes taken back leaves no copy of what they said in the decision log. Null for any other tool.
export function voiceReadReceipt(name: string, input: any): { answer: string } | null {
  if (name !== "voiceRead") return null;
  return { answer: ["yes", "no", "stop", "explain"].includes(input?.answer) ? input.answer : "other" };
}

export function guardTools<T extends Record<string, any>>(tools: T, ctx: GuardCtx): T {
  const usedThisTurn = new Map<string, number>();
  const retried = new Set<string>();
  // Runs this turn that came back refused, and whether any went through: "already ran" is not "already done" (2026-10-12: after two
  // refused documents, "Already done this turn" read as done, and Co described a document that didn't exist).
  const refusedThisTurn = new Map<string, number>();
  const doneThisTurn = new Set<string>();
  // Made but not sent (a deck, page or link whose text didn't go): it exists. The tool says so with made, and it is never counted as
  // a refusal (review of this branch: "nothing was made" after a deck that was made).
  const madeThisTurn = new Map<string, string>();
  for (const [name, t] of Object.entries(tools)) {
    if (UNGUARDED.has(name)) continue;
    const ability = abilityForTool(name);
    if (!ability || typeof t.execute !== "function") continue;
    const limits = ability.limits ?? {};

    const extra: Record<string, z.ZodTypeAny> = { why: z.string().optional().describe("One short line: why this, now.") };
    if (limits.resendIfMissing) extra.resendBecauseMissing = z.boolean().optional().describe("True only when they said the earlier one didn't arrive.");
    if (ability.confirm) extra.theirYes = z.string().describe("Their own words in THIS message saying yes to it. If they haven't said yes yet, don't call this: propose it and ask first.");
    if (t.inputSchema && typeof t.inputSchema.extend === "function") t.inputSchema = t.inputSchema.extend(extra);

    const run = t.execute;
    t.execute = async (input: any, options: any) => {
      // A removal asked through correctWhatCoKnows: the receipt holds kinds and counts only (removalReceipt), never their message,
      // their yes, the why, the refs (their hash part is made from the text) or a judge's words about it (forget-delete-spec.md §2.26).
      // A voiceRead call the same way: the answer read, never their words (voiceReadReceipt).
      const removal = removalReceipt(name, input) ?? voiceReadReceipt(name, input);
      const log = (receipt: Receipt, detail: Record<string, unknown> = {}) =>
        ctx.dryRun
          ? Promise.resolve()
          : recordDecision({
              layer: 3,
              decision: `tool.${name}`,
              userId: ctx.userId,
              outcome: receipt === "done" ? "act" : "skip",
              action: receipt,
              reason: removal ? "" : String(input?.why ?? "").slice(0, 300),
              proposal: removal
                ? { ability: ability.id, ...removal, ...(typeof detail.yesCheck === "string" ? { yesCheck: detail.yesCheck } : {}), ...("error" in detail ? { error: "not done" } : {}) }
                : { ability: ability.id, message: ctx.resolvedContent.slice(0, 300), input: Object.fromEntries(Object.entries(input ?? {}).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 200) : v])), ...detail },
            }).catch(() => {});
      const refuse = async (receipt: Receipt, receiptText: string, tell: string, detail: Record<string, unknown> = {}) => {
        ctx.notDone(receiptText);
        await log(receipt, detail);
        return { ok: false, error: tell };
      };

      if (await isSwitchedOff(ability.id)) {
        return refuse("off", `${ability.id.replace(/_/g, " ")} is switched off right now, so it wasn't done.`, "This is switched off right now. Tell them plainly it isn't available at the moment.");
      }
      const used = usedThisTurn.get(name) ?? 0;
      if (limits.perTurn && used >= limits.perTurn) {
        const refused = refusedThisTurn.get(name) ?? 0;
        const madeUnsent = madeThisTurn.get(name);
        if (madeUnsent) {
          return refuse(
            "limited",
            `${name} wasn't run again: it already made ${madeUnsent} this turn, but that didn't send.`,
            `Already done this turn: ${madeUnsent} exists, but the text with it didn't send. Don't make it again; give it in your reply.`,
          );
        }
        if (refused && !doneThisTurn.has(name)) {
          return refuse(
            "limited",
            `${name} wasn't run again: it was refused ${refused} time(s) this turn and nothing came of it. Nothing from it exists or was sent.`,
            `Nothing was made: it was refused ${refused} time(s) this turn, so nothing from it exists or was sent. Already done this turn as many times as allowed, so don't try again now. Tell them plainly it isn't done, what stopped it, and what would unblock it; never describe it as made.`,
          );
        }
        return refuse("limited", `${name} wasn't run again: it already ran ${used} time(s) this turn.`, "Already done this turn. Don't repeat it.");
      }
      if (!ctx.dryRun && limits.perDay) {
        const { rows } = await pool
          .query(`SELECT COUNT(*)::int AS n FROM harness_decisions WHERE decision = $1 AND user_id = $2 AND outcome = 'act' AND created_at > NOW() - INTERVAL '24 hours'`, [`tool.${name}`, ctx.userId])
          .catch(() => ({ rows: [{ n: 0 }] }));
        const allowed = limits.perDay + (limits.resendIfMissing && input?.resendBecauseMissing ? 1 : 0);
        if ((rows[0]?.n ?? 0) >= allowed) {
          return refuse("limited", `${name} wasn't run: it's already been done ${rows[0].n} time(s) for them today.`, "Already done for them today. Don't do it again; say so if it comes up.");
        }
      }
      // The full name, once there is one (personKey). A first name alone is never checked: nothing is done for a first name alone
      // (the tool asks for the last name before any lookup, the same for everyone), and rows logged before 2026-10-28 counted that
      // first-name step as done, so checking it would refuse the same first step forever. Rows from then on carry the key as
      // proposal.person; older ones are read the way personKey reads their input.
      const person = limits.oncePerPerson ? personKey(input) : "";
      if (!ctx.dryRun && limits.oncePerPerson && person.includes(" ")) {
        const { rows } = await pool
          .query(
            `SELECT 1 FROM harness_decisions WHERE decision = $1 AND user_id = $2 AND outcome = 'act'
               AND COALESCE(proposal->>'person', CASE WHEN COALESCE(proposal->'input'->>'lastName', '') <> ''
                 THEN split_part(lower(proposal->'input'->>'personName'), ' ', 1) || ' ' || lower(proposal->'input'->>'lastName')
                 ELSE lower(proposal->'input'->>'personName') END) = $3 LIMIT 1`,
            [`tool.${name}`, ctx.userId, person],
          )
          .catch(() => ({ rows: [] as any[] }));
        if (rows.length) return refuse("limited", `${name} wasn't run: it was already done for ${input.personName}.`, "Already requested for this person. Don't ask again.");
      }
      if (ability.confirm) {
        const yes = await confirmYes({ theirYes: input?.theirYes, message: ctx.resolvedContent, recent: ctx.recentExchange ?? null, ability: ability.can });
        if (!yes.ok) {
          const detail = { yesCheck: yes.kind, yesWhy: yes.why };
          // The quote wasn't their words: a clean retry with the right quote, never asking them again.
          if (yes.kind === "quote") return refuse("needs_yes", `${name} wasn't run yet: the quoted yes isn't in their message.`, `Not done yet. ${QUOTE_RETRY}`, detail);
          if (yes.kind === "unread") return refuse("needs_yes", `${name} wasn't run: their yes couldn't be checked just now.`, "Not done: their yes couldn't be checked just now. Say plainly it didn't go through yet; don't ask them to say it again.", detail);
          return refuse("needs_yes", `${name} wasn't run: their message isn't a yes to it.`, "Not done: their message doesn't read as a yes to this. Answer what they said; don't ask again in this reply.", detail);
        }
      }

      usedThisTurn.set(name, used + 1);
      const raw = await run(input, options);
      // askedBack (2026-10-28): the tool asked a question back and did nothing, so this call isn't a request (receipt asked_back).
      // Read here and taken off before the model sees the result, so what the model reads is exactly what it read before.
      const askedBack = !!raw && typeof raw === "object" && raw.askedBack === true;
      const result = askedBack ? (({ askedBack: _a, ...rest }) => rest)(raw) : raw;
      if (askedBack) {
        await log("asked_back");
        return result;
      }
      const failed = !!result && typeof result === "object" && result.ok === false;
      const made = failed && typeof result.made === "string" && result.made.trim() ? String(result.made) : null;
      // A refused attempt doesn't use up the turn's allowance, once: the tool's own refusal says "fix these and try again once"
      // (2026-10-08 call test: a document refused for one unbacked line was then refused again as "already done this turn").
      if (made) madeThisTurn.set(name, made);
      if (failed && !made) refusedThisTurn.set(name, (refusedThisTurn.get(name) ?? 0) + 1);
      else doneThisTurn.add(name);
      // A free retry only for a refusal: something made is never made twice.
      if (failed && !made && !retried.has(name)) { retried.add(name); usedThisTurn.set(name, used); }
      if (made) ctx.notDone(`${name} made ${made}, but the text with it didn't send.`);
      else if (failed) ctx.notDone(`${name} didn't go through${result.error ? `: ${String(result.error).slice(0, 160)}` : "."}`);
      // recordAs: a tool that did only part of what it was asked names the part that happened (shareLink: only the links that went),
      // so the lasting record never says more than the turn's facts do. It's logged too, so the every-boot backfill rebuilds from it,
      // never from the full ask (review of #284).
      const partial = !!result && typeof result === "object" && result.recordAs && typeof result.recordAs === "object" ? result.recordAs : null;
      const recordAs = partial ?? input;
      // person: the oncePerPerson key, so a later "Sarah" + "Kim" and "Sarah Kim" both find this row (2026-10-28).
      await log(failed ? "not_done" : "done", { ...(failed ? { error: String(result.error ?? "").slice(0, 200), ...(made ? { made } : {}) } : partial ? { recordAs: partial } : {}), ...(person ? { person } : {}) });
      // Co's record of what it did for them (services/coFacts.ts).
      if ((!failed || made) && !ctx.dryRun) await recordToolAction(ctx.userId, name, recordAs);
      return result;
    };
  }
  return tools;
}
