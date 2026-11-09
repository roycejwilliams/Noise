// The durable record of one member's registration for one event (event_registrations, db/migrations.ts). One row per member and event
// (UNIQUE (user_id, event_key)): a second yes, a retried turn or a restarted server finds the same row, so the same registration is
// never attempted twice. Every query is bound to the member ($1/$2 = their id); nothing here reads another member's row.
//
// The submit is claimed in one UPDATE that only succeeds from a state that may submit, with the scope their yes covered: two turns
// racing on one yes get one claim. A claim whose result never came back (the process died mid-submit) reads as uncertain after
// SUBMIT_STALE_MS, never as free to try again.
//
// What's kept: the form as read, the scope they were asked, their approved answers for THIS registration (the email they chose among
// them), Cue's drafts, the outcome and the real link. Never an emailed sign-in code, a password or a session cookie: the browser
// session lives in memory only while it waits on them (lumaDriver.ts held sessions) and is closed after.
import pool from "../../db/db.js";
import { canMove, FINAL, type Answers, type Draft, type FormRead, type Outcome, type RegistrationRecord, type Scope, type Status } from "./registration.js";

export type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
const db = (q?: Q): Q => q ?? (pool as unknown as Q);

// A submit claimed this long ago with no result recorded is treated as uncertain (reconciled before anything else).
export const SUBMIT_STALE_MS = 5 * 60_000;

export const REGISTRATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS event_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  event_url TEXT NOT NULL,
  item_key TEXT,
  event_name TEXT,
  status TEXT NOT NULL DEFAULT 'inspected',
  form JSONB,
  scope JSONB,
  scope_hash TEXT,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  drafts JSONB NOT NULL DEFAULT '[]'::jsonb,
  asked_at TIMESTAMPTZ,
  ask_kind TEXT,
  ask_text TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  submit_started_at TIMESTAMPTZ,
  outcome JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, event_key)
)`;

// Pure: a row as the record.
export function fromRow(r: any): RegistrationRecord {
  const json = <T>(v: unknown, d: T): T => (v == null ? d : typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
  return {
    id: String(r.id),
    userId: String(r.user_id),
    eventKey: String(r.event_key),
    eventUrl: String(r.event_url),
    itemKey: r.item_key ?? null,
    eventName: r.event_name ?? null,
    status: r.status as Status,
    form: json<FormRead | null>(r.form, null),
    scope: json<Scope | null>(r.scope, null),
    scopeHash: r.scope_hash ?? null,
    answers: json<Answers>(r.answers, {}),
    drafts: json<Draft[]>(r.drafts, []),
    askedAt: r.asked_at ? new Date(r.asked_at) : null,
    askKind: r.ask_kind === "answers" || r.ask_kind === "submit" ? r.ask_kind : null,
    askText: r.ask_text ?? null,
    attempts: Number(r.attempts ?? 0),
    submitStartedAt: r.submit_started_at ? new Date(r.submit_started_at) : null,
    outcome: json<Outcome | null>(r.outcome, null),
    updatedAt: new Date(r.updated_at ?? Date.now()),
  };
}

// Pure: the status as it stands now: a submit claimed long ago with no result is uncertain, never still "submitting".
export function effectiveStatus(r: Pick<RegistrationRecord, "status" | "submitStartedAt">, now = Date.now()): Status {
  if (r.status === "submitting" && (!r.submitStartedAt || now - r.submitStartedAt.getTime() > SUBMIT_STALE_MS)) return "uncertain";
  return r.status;
}

// The member's row for this event, made when it doesn't exist. Never resets a row that exists.
export async function openRegistration(userId: string, o: { eventKey: string; eventUrl: string; itemKey: string | null; eventName: string | null }, q?: Q): Promise<RegistrationRecord> {
  const { rows } = await db(q).query(
    `INSERT INTO event_registrations (user_id, event_key, event_url, item_key, event_name) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, event_key) DO UPDATE SET item_key = COALESCE(event_registrations.item_key, EXCLUDED.item_key)
     RETURNING *`,
    [userId, o.eventKey, o.eventUrl, o.itemKey, o.eventName],
  );
  return fromRow(rows[0]);
}

export async function registrationById(userId: string, id: string, q?: Q): Promise<RegistrationRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db(q).query(`SELECT * FROM event_registrations WHERE user_id = $1 AND id = $2`, [userId, id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function registrationFor(userId: string, eventKey: string, q?: Q): Promise<RegistrationRecord | null> {
  const { rows } = await db(q).query(`SELECT * FROM event_registrations WHERE user_id = $1 AND event_key = $2`, [userId, eventKey]);
  return rows[0] ? fromRow(rows[0]) : null;
}

// Their earlier registrations' forms and answers, for the factual details they approved there (registration.ts factsFromEarlierSignups).
export async function earlierSignups(userId: string, exceptId: string | null, q?: Q): Promise<{ fields: FormRead["fields"]; answers: Answers }[]> {
  const { rows } = await db(q).query(
    `SELECT form, answers FROM event_registrations WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid) AND form IS NOT NULL ORDER BY updated_at DESC LIMIT 20`,
    [userId, exceptId],
  );
  return rows.map((r: any) => ({ fields: (typeof r.form === "string" ? JSON.parse(r.form) : r.form)?.fields ?? [], answers: typeof r.answers === "string" ? JSON.parse(r.answers) : (r.answers ?? {}) }));
}

export type Patch = Partial<{ form: FormRead; scope: Scope | null; scopeHash: string | null; answers: Answers; drafts: Draft[]; askedAt: Date | null; askKind: "answers" | "submit" | null; askText: string | null; outcome: Outcome | null; eventName: string | null }>;

// Pure: the SET clause and values for a patch, after the status ($3) and the two keys ($1 id, $2 user).
export function patchSql(p: Patch): { sets: string[]; args: unknown[] } {
  const cols: [keyof Patch, string, (v: any) => unknown][] = [
    ["form", "form", (v) => JSON.stringify(v)], ["scope", "scope", (v) => (v == null ? null : JSON.stringify(v))], ["scopeHash", "scope_hash", (v) => v],
    ["answers", "answers", (v) => JSON.stringify(v ?? {})], ["drafts", "drafts", (v) => JSON.stringify(v ?? [])], ["askedAt", "asked_at", (v) => v],
    ["askKind", "ask_kind", (v) => v], ["askText", "ask_text", (v) => v], ["outcome", "outcome", (v) => (v == null ? null : JSON.stringify(v))], ["eventName", "event_name", (v) => v],
  ];
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col, conv] of cols) {
    if (!(k in p)) continue;
    args.push(conv(p[k]));
    sets.push(`${col} = $${4 + args.length}`);
  }
  return { sets, args };
}

// Moves the row to `to` with the patch, only from a state that may move there (registration.ts canMove), in one UPDATE: a row another
// turn moved first is left alone and null comes back.
export async function moveRegistration(userId: string, id: string, to: Status, patch: Patch = {}, q?: Q): Promise<RegistrationRecord | null> {
  const from = (Object.keys(EDGE_FROM) as Status[]).filter((s) => canMove(s, to));
  if (!from.length) return null;
  const { sets, args } = patchSql(patch);
  const { rows } = await db(q).query(
    `UPDATE event_registrations SET status = $3, updated_at = NOW()${sets.length ? `, ${sets.join(", ")}` : ""}
     WHERE id = $1 AND user_id = $2 AND status = ANY($4::text[]) RETURNING *`,
    [id, userId, to, from, ...args],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}
const EDGE_FROM: Record<Status, true> = {
  inspected: true, needs_answers: true, awaiting_yes: true, needs_member_code: true, needs_member_step: true, submitting: true, uncertain: true,
  registered: true, pending_approval: true, waitlisted: true, already_registered: true, failed: true, blocked: true, withdrawn: true,
};

// The one submit: claimed only from awaiting_yes (or a held sign-in step resuming), only for the scope their yes covered. Returns null
// when another turn has it, it's final, or the scope moved: nothing is submitted then.
export async function claimSubmit(userId: string, id: string, scopeHash: string, o: { resuming?: boolean } = {}, q?: Q): Promise<RegistrationRecord | null> {
  const from = o.resuming ? ["needs_member_code", "needs_member_step"] : ["awaiting_yes"];
  const { rows } = await db(q).query(
    `UPDATE event_registrations SET status = 'submitting', attempts = attempts + 1, submit_started_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = ANY($3::text[]) AND scope_hash = $4 AND ask_kind = 'submit' RETURNING *`,
    [id, userId, from, scopeHash],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

// A retry after an uncertain result: only after a reconcile read left it uncertain AND they said yes to trying again, asked after the
// first submit (ask_kind 'submit', asked_at after submit_started_at). Never on the first response going missing alone.
export async function claimRetry(userId: string, id: string, scopeHash: string, q?: Q): Promise<RegistrationRecord | null> {
  const { rows } = await db(q).query(
    `UPDATE event_registrations SET status = 'submitting', attempts = attempts + 1, submit_started_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'uncertain' AND scope_hash = $3 AND ask_kind = 'submit' AND asked_at > submit_started_at RETURNING *`,
    [id, userId, scopeHash],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

// The page's answer, recorded once. A final state is never overwritten by a later read that says less.
export async function recordOutcome(userId: string, id: string, outcome: Outcome, to: Status, q?: Q): Promise<RegistrationRecord | null> {
  return moveRegistration(userId, id, to, { outcome }, q);
}

// Their registrations that ended up on a guest list (registered) or waiting on the host or a spot: what follow-through reads.
export async function registrationsForFollowThrough(userId: string, q?: Q): Promise<{ eventKey: string; eventUrl: string; itemKey: string | null; status: Status; at: Date }[]> {
  const { rows } = await db(q).query(
    `SELECT event_key, event_url, item_key, status, updated_at FROM event_registrations WHERE user_id = $1 AND status = ANY($2::text[]) ORDER BY updated_at DESC LIMIT 50`,
    [userId, [...FINAL]],
  );
  return rows.map((r: any) => ({ eventKey: r.event_key, eventUrl: r.event_url, itemKey: r.item_key ?? null, status: r.status as Status, at: new Date(r.updated_at) }));
}
