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
// services/capabilities.ts, or in an extension's own list (Mo's is
// mo/abilities.ts), so every extension gets the same guards.
import { z } from "zod";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { abilityForTool, type Ability } from "../services/capabilities.js";
import { isSwitchedOff } from "../services/abilitySwitches.js";
import { recordToolAction } from "../services/coFacts.js";

// Replies and bookkeeping aren't choices worth logging one by one.
const UNGUARDED = new Set(["sendReply", "markTopicAsked"]);

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Their yes has to be in what they sent this turn, not made up.
export function yesIsTheirs(theirYes: unknown, message: string): boolean {
  const y = norm(theirYes);
  return y.length >= 2 && norm(message).includes(y);
}

type GuardCtx = {
  userId: string;
  resolvedContent: string;
  dryRun: boolean;
  notDone: (what: string) => void;
  // Whose abilities these tools are. Co's registry by default.
  abilityFor?: (tool: string) => Ability | undefined;
};

export type Receipt = "done" | "not_done" | "off" | "limited" | "needs_yes";

export function guardTools<T extends Record<string, any>>(tools: T, ctx: GuardCtx): T {
  const usedThisTurn = new Map<string, number>();
  const retried = new Set<string>();
  for (const [name, t] of Object.entries(tools)) {
    if (UNGUARDED.has(name)) continue;
    const ability = (ctx.abilityFor ?? abilityForTool)(name);
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
      const refuse = async (receipt: Receipt, receiptText: string, tell: string) => {
        ctx.notDone(receiptText);
        await log(receipt);
        return { ok: false, error: tell };
      };

      if (await isSwitchedOff(ability.id)) {
        return refuse("off", `${ability.id.replace(/_/g, " ")} is switched off right now, so it wasn't done.`, "This is switched off right now. Tell them plainly it isn't available at the moment.");
      }
      const used = usedThisTurn.get(name) ?? 0;
      if (limits.perTurn && used >= limits.perTurn) {
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
      if (ability.confirm && !yesIsTheirs(input?.theirYes, ctx.resolvedContent)) {
        return refuse("needs_yes", `${name} wasn't run yet: it needs their clear yes first.`, "Not done: this needs their own yes in this message first. Propose it and ask them.");
      }

      usedThisTurn.set(name, used + 1);
      const result = await run(input, options);
      const failed = !!result && typeof result === "object" && result.ok === false;
      // A refused attempt doesn't use up the turn's allowance, once: the tool's own refusal says "fix these and try again once"
      // (2026-10-08 call test: a document refused for one unbacked line was then refused again as "already done this turn").
      if (failed && !retried.has(name)) { retried.add(name); usedThisTurn.set(name, used); }
      if (failed) ctx.notDone(`${name} didn't go through${result.error ? `: ${String(result.error).slice(0, 160)}` : "."}`);
      await log(failed ? "not_done" : "done", failed ? { error: String(result.error ?? "").slice(0, 200) } : {});
      // Co's record of what it did for them (services/coFacts.ts). Only
      // Co's own tools: an extension's team tools act for the team.
      if (!failed && !ctx.dryRun && !ctx.abilityFor) await recordToolAction(ctx.userId, name, input);
      return result;
    };
  }
  return tools;
}
