// What Cue did DURING a call and what it still owes right after it (Royce, 2026-10-29: act on the phone, and anything promised but
// not done on the call goes out the moment the call ends). Durable, so the after-call steps read it whichever process handles the
// post-call webhook, and a restart in between loses nothing:
//   call.done_on_call    a quick tool came back done on the call (services/callTools.ts): what it was, from Cue's own action
//                        labels (services/coFacts.ts toolAction, the same words co_facts keeps), and the links a send carried
//   call.owed_after_call a send that failed or didn't come back in time on the call: the links and names it was for, so the
//                        after-call step (services/callFollowThrough.ts) sends exactly those, unless the late send already landed
//   call.turn_acted      Cue's own spoken "I'll text you that" lines from a turn whose tool already did it: never re-opened as a
//                        promise from the transcript after the call
// Readers: the after-call follow-through (delivery and no repeats), the post-call audit (harness/callGrounding.ts: a mid-call
// action is done, not an invented claim) and the after-call reflection text (jobs/postCallFollowUp.ts: never repeated).
// No member words are written here: tool names, Cue's own labels, links and names of things on file.
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { toolAction } from "./coFacts.js";

// found: what a search on the call found (searchEvents' events with their links), so a later check never "corrects" a real find.
export type DoneOnCall = { tool: string; kind: string; labels: string[]; urls: string[]; names: string[]; at: Date; found?: FoundOnCall[] };
export type FoundOnCall = { name: string; url: string };
// One thing done on the call, as the audit matches a claim to it: its kind (a send texted them), its labels, and the names and links
// of what it was about.
export type DoneItem = { kind: string; label: string; names: string[]; urls: string[] };
export type OwedAfterCall = { tool: string; items: { name: string; url: string }[]; why: "failed" | "timeout"; at: Date; taskId: number | null };
export type CallLedger = { done: DoneOnCall[]; owed: OwedAfterCall[]; covered: string[] };

// Pure: what a done tool is called in the ledger: its action labels (the same words co_facts keeps), else its name.
export function doneLabels(tool: string, input: unknown): string[] {
  // A send on a call (any of them: shareLink, resendLink, resetLink, shareArtifact) is labelled by what it texted: each link with
  // its name, the way shareLink's own record reads.
  const i = input as { urls?: unknown; names?: unknown } | null;
  const asSend = Array.isArray(i?.urls) && (i!.urls as unknown[]).length && Array.isArray(i?.names);
  const labels = (toolAction(asSend ? "shareLink" : tool, input) ?? []).map((a) => a.label).filter(Boolean);
  return labels.length ? labels : [`used ${tool}`];
}

export function recordDoneOnCall(userId: string, d: { tool: string; kind: string; input: unknown; urls?: string[]; found?: FoundOnCall[] }): Promise<void> {
  const names = Array.isArray((d.input as { names?: unknown } | null)?.names) ? ((d.input as { names: unknown[] }).names.map(String).slice(0, 6)) : [];
  return recordDecision({ layer: 8, decision: "call.done_on_call", userId, outcome: "act", action: d.tool, proposal: { kind: d.kind, labels: doneLabels(d.tool, d.input).map((l) => l.slice(0, 200)), urls: (d.urls ?? []).slice(0, 6), names: names.map((n) => n.slice(0, 160)), ...(d.found?.length ? { found: d.found.slice(0, 20).map((f) => ({ name: f.name.slice(0, 160), url: f.url })) } : {}) } });
}

export function recordOwedAfterCall(userId: string, o: { tool: string; items: { name: string; url: string }[]; why: "failed" | "timeout"; taskId?: number | null }): Promise<void> {
  return recordDecision({ layer: 8, decision: "call.owed_after_call", userId, outcome: "skip", action: o.tool, proposal: { items: o.items.slice(0, 6).map((i) => ({ name: i.name.slice(0, 160), url: i.url })), why: o.why, taskId: o.taskId ?? null } });
}

export function recordTurnActed(userId: string, sentences: string[]): Promise<void> {
  if (!sentences.length) return Promise.resolve();
  return recordDecision({ layer: 8, decision: "call.turn_acted", userId, outcome: "act", action: "covered", proposal: { said: sentences.slice(0, 6).map((s) => s.slice(0, 220)) } });
}

// Pure: the ledger from its decision rows (any order).
export function ledgerFromRows(rows: { decision: string; action: string | null; proposal: any; created_at: Date | string }[]): CallLedger {
  const done: DoneOnCall[] = [];
  const owed: OwedAfterCall[] = [];
  const covered: string[] = [];
  for (const r of [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())) {
    const p = r.proposal ?? {};
    const at = new Date(r.created_at);
    if (r.decision === "call.done_on_call") done.push({ tool: String(r.action ?? ""), kind: String(p.kind ?? ""), labels: Array.isArray(p.labels) ? p.labels.map(String) : [], urls: Array.isArray(p.urls) ? p.urls.map(String) : [], names: Array.isArray(p.names) ? p.names.map(String) : [], at, ...(Array.isArray(p.found) ? { found: p.found.filter((f: any) => f && typeof f.url === "string" && f.name).map((f: any) => ({ name: String(f.name), url: String(f.url) })) } : {}) });
    else if (r.decision === "call.owed_after_call") owed.push({ tool: String(r.action ?? ""), items: Array.isArray(p.items) ? p.items.filter((i: any) => i && typeof i.url === "string").map((i: any) => ({ name: String(i.name ?? ""), url: String(i.url) })) : [], why: p.why === "timeout" ? "timeout" : "failed", at, taskId: typeof p.taskId === "number" ? p.taskId : null });
    else if (r.decision === "call.turn_acted" && Array.isArray(p.said)) covered.push(...p.said.map(String));
  }
  // Owed rows are kept whole, whatever the order: the after-call step settles each on whether its link landed since the call started
  // (a send done on the call, before or after the owed row was written, counts: services/callFollowThrough.ts).
  return { done, owed, covered };
}

// Pure: the done list as plain lines, for the audit and the reflection.
export function doneLines(l: Pick<CallLedger, "done">): string[] {
  return [...new Set(l.done.flatMap((d) => d.labels))].slice(0, 20);
}

// Pure: the done list as the audit matches claims to it (one entry per label).
export function doneItems(l: Pick<CallLedger, "done">): DoneItem[] {
  return l.done.flatMap((d) => (d.labels.length ? d.labels : [`used ${d.tool}`]).map((label) => ({ kind: d.kind, label, names: d.names, urls: d.urls }))).slice(0, 30);
}

// Pure: what the call's searches found (each once, by its link).
export function foundOnCall(l: Pick<CallLedger, "done">): FoundOnCall[] {
  const out: FoundOnCall[] = [];
  for (const f of l.done.flatMap((d) => d.found ?? [])) if (!out.some((x) => x.url === f.url)) out.push(f);
  return out.slice(0, 40);
}

// The ledger for one call: its rows between the call's start and a little after its end.
export async function readCallLedger(userId: string, since: Date, until: Date): Promise<CallLedger> {
  const { rows } = await pool.query(
    `SELECT decision, action, proposal, created_at FROM harness_decisions
     WHERE user_id = $1 AND layer = 8 AND decision IN ('call.done_on_call', 'call.owed_after_call', 'call.turn_acted') AND created_at >= $2 AND created_at <= $3
     ORDER BY created_at LIMIT 200`,
    [userId, since, until],
  );
  return ledgerFromRows(rows);
}
