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

export type Receipt = "done" | "not_done" | "off" | "limited" | "needs_yes";

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
      const log = (receipt: Receipt, detail: Record<string, unknown> = {}) =>
        ctx.dryRun
          ? Promise.resolve()
          : recordDecision({
              layer: 3,
              decision: `tool.${name}`,
              userId: ctx.userId,
              outcome: receipt === "done" ? "act" : "skip",
              action: receipt,
              reason: String(input?.why ?? "").slice(0, 300),
              proposal: { ability: ability.id, message: ctx.resolvedContent.slice(0, 300), input: Object.fromEntries(Object.entries(input ?? {}).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 200) : v])), ...detail },
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
      if (!ctx.dryRun && limits.oncePerPerson) {
        const person = norm(input?.personName);
        const { rows } = person
          ? await pool
              .query(`SELECT 1 FROM harness_decisions WHERE decision = $1 AND user_id = $2 AND outcome = 'act' AND lower(proposal->'input'->>'personName') = $3 LIMIT 1`, [`tool.${name}`, ctx.userId, person])
              .catch(() => ({ rows: [] as any[] }))
          : { rows: [] as any[] };
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
      const result = await run(input, options);
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
      await log(failed ? "not_done" : "done", failed ? { error: String(result.error ?? "").slice(0, 200), ...(made ? { made } : {}) } : {});
      // Co's record of what it did for them (services/coFacts.ts).
      if ((!failed || made) && !ctx.dryRun) await recordToolAction(ctx.userId, name, input);
      return result;
    };
  }
  return tools;
}
