// Reissuing Cue's contact card to members who hold an older one (2026-11-02). Two separate things live here:
//
//   1. Whether a revision is needed (decideReissue). Cue decides that itself, on a clear basis only: the card's contact details
//      changed (a number, the email, the site), its identity (the name, the company), the approved branding (the photo), or its
//      description went out of date. A feature release on its own is never a basis: the card says who Cue is and how to reach it,
//      not what's new. Cue can then prepare the revision (prepareRevision: a new version with its diff). Preparing never approves:
//      new member-facing words or visuals, and the rollout, wait on Royce.
//
//   2. The push (runPush), which needs Royce's approval record on the version (utils/vcard.ts CardApproval: his name, the date, the
//      exact content hash, the numbers it was approved with) AND the matching --approved flag on the command line. No env switch.
//      A dry run prints coverage and sends nothing.
//
// Delivery is the existing path: sendExempt (harness/proactive.ts), the card attached to one text, the way sendContactCard sends it.
// Every send re-reads opt-out inside the per-member lock, keeps the member's local hours, and waits on the gates any text Cue starts
// waits on (spacing from any text Cue sent first, the engagement pace, the unanswered pause, mid-conversation); before that, the
// member's own holds (safety, a hard day, a hold or space they asked for) are read from memberSendState. The send wrapper refuses a
// test number, a malformed number and an open send breaker. Once per member per version: the ledger key contact_card:v<n>
// (proactive_sends, unique on user_id + target_key), plus a contact_card_sends row with what happened. A retry run only ever tries
// the members whose last attempt failed or was held; a first run only members never tried.
import type { CardFields, CardVersion, Phones } from "../utils/vcard.js";
import { CARD_VERSIONS, cardDiff, cardSha, fieldSummary, isApproved, liveVersion, numbersStillApproved, phonesFromEnv } from "../utils/vcard.js";

// ---------------------------------------------------------------- 1. the decision

export type ChangeKind = "contact" | "identity" | "branding" | "description";
// What can happen; only the four ChangeKinds are a basis for a new card.
export type Signal = { kind: ChangeKind | "feature_release" | "fix" | "internal"; field?: string; detail: string };

const FIELD_KIND: Record<string, ChangeKind | null> = {
  FN: "identity", N: "identity", ORG: "identity", TITLE: "identity",
  TEL: "contact", EMAIL: "contact", URL: "contact",
  PHOTO: "branding",
  NOTE: "description",
  UID: null, REV: null, // bookkeeping: never a reason on their own
};
// Names the card must never carry any more (the rename, 2026-10-14). A held card that still says them is out of date.
const OLD_NAMES = /\bCo\b(?!-)|\bCoPatible\b|\bMo\b/;

// Pure: what differs between the card members hold and the truth as code knows it now (the approved name, company, mark,
// description, and the numbers the held card was approved with against the env's numbers now).
export function detectChanges(held: { fields: CardFields; numbersCurrent: boolean }, truth: CardFields): Signal[] {
  const a = fieldSummary(held.fields), b = fieldSummary(truth);
  const out: Signal[] = [];
  for (const k of Object.keys(a) as (keyof typeof a)[]) {
    const kind = FIELD_KIND[k];
    if (kind && a[k] !== b[k]) out.push({ kind, field: k, detail: `${k}: ${a[k].slice(0, 80)} -> ${b[k].slice(0, 80)}` });
  }
  if (!held.numbersCurrent) out.push({ kind: "contact", field: "TEL", detail: "a number on the held card is not the number in use now" });
  if (OLD_NAMES.test(held.fields.note)) out.push({ kind: "description", field: "NOTE", detail: "the description names an old identity" });
  return out;
}

// Pure: the decision. A revision is needed only on a basis; everything else is noted and changes nothing.
export function decideReissue(signals: Signal[]): { revise: boolean; basis: Signal[]; notABasis: Signal[] } {
  const isBasis = (s: Signal) => s.kind === "contact" || s.kind === "identity" || s.kind === "branding" || s.kind === "description";
  const basis = signals.filter(isBasis);
  return { revise: basis.length > 0, basis, notABasis: signals.filter((s) => !isBasis(s)) };
}

// Pure: a prepared revision: the next version number, its fields, its diff against what members hold, and no approval. Its member
// note is left empty: words for members are Royce's to approve, never filled in by the decision.
export function prepareRevision(held: CardVersion, truth: CardFields, signals: Signal[], versions: readonly CardVersion[] = CARD_VERSIONS): { version: CardVersion; diff: ReturnType<typeof cardDiff> } | null {
  const d = decideReissue(signals);
  if (!d.revise) return null;
  const next = Math.max(...versions.map((v) => v.version)) + 1;
  const version: CardVersion = { version: next, fields: truth, memberNote: null, basis: [...new Set(d.basis.map((s) => s.kind))], approval: null };
  return { version, diff: cardDiff(held, version) };
}

// The truth as code holds it today: the newest prepared version's fields (Royce's approved name, company and mark; the proposed
// description). What members hold: the live version.
export function reissueCheck(phones: Phones = phonesFromEnv()): { held: CardVersion; decision: ReturnType<typeof decideReissue>; waiting: CardVersion | null } {
  const held = liveVersion();
  const newest = [...CARD_VERSIONS].sort((a, b) => b.version - a.version)[0];
  const numbersCurrent = held.approval === "legacy" ? true : numbersStillApproved(held, phones);
  const decision = decideReissue(detectChanges({ fields: held.fields, numbersCurrent }, newest.fields));
  return { held, decision, waiting: newest.version > held.version && !isApproved(newest) ? newest : null };
}

// ---------------------------------------------------------------- 2. who gets it

export const EXCLUSIONS = [
  "archived",
  "no_phone",
  "unsendable_number",
  "test_number",
  "bot_blocked",
  "not_a_member_yet",
  "opted_out",
  "safety_hold",
  "joined_after_live",
  "already_sent",
] as const;
export type Exclusion = (typeof EXCLUSIONS)[number];

export type AudienceRow = {
  id: string;
  phone_number: string | null;
  created_at: Date | string;
  archived_at: Date | string | null;
  sms_opted_out: boolean | null;
  identity_captured: boolean | null;
  // Silenced and blocked in Sendblue at the invite gate as an automated sender (harness_decisions gate.silent / silent_automated).
  bot_blocked: boolean;
  safety_hold: boolean;
  // This version's ledger key is taken (proactive_sends contact_card:v<n>), or a contact_card_sends row says sent.
  sent: boolean;
  // This version's last attempt: null when never tried.
  attempt: "failed" | "held" | null;
};

// A fictional 555-01xx number in ANY environment (services/testNumbers.ts only fakes them off production; here they are always out).
const FICTIONAL = /^1?\d{3}55501\d{2}$/;
const SENDABLE = (n: string) => /^\+\d{10,15}$/.test(n) && (!n.startsWith("+1") || n.length === 12);

// Pure: first reason a member is left out, or "eligible". liveSince: when this version went live; a member who joined after it was
// sent this version at onboarding (/co.vcf) and never gets it again.
export function classify(r: AudienceRow, o: { liveSince: Date | null }): Exclusion | "eligible" {
  if (r.archived_at) return "archived";
  if (!r.phone_number) return "no_phone";
  if (!SENDABLE(r.phone_number.trim())) return "unsendable_number";
  if (FICTIONAL.test(r.phone_number.replace(/\D/g, ""))) return "test_number";
  if (r.bot_blocked) return "bot_blocked";
  if (r.identity_captured !== true) return "not_a_member_yet";
  if (r.sms_opted_out === true) return "opted_out";
  if (r.safety_hold) return "safety_hold";
  if (o.liveSince && new Date(r.created_at).getTime() >= o.liveSince.getTime()) return "joined_after_live";
  if (r.sent) return "already_sent";
  return "eligible";
}

export type Coverage = { eligible: number; neverTried: number; toRetry: number; excluded: Record<Exclusion, number> };
export function coverage(rows: AudienceRow[], o: { liveSince: Date | null }): Coverage {
  const excluded = Object.fromEntries(EXCLUSIONS.map((e) => [e, 0])) as Record<Exclusion, number>;
  let eligible = 0, neverTried = 0, toRetry = 0;
  for (const r of rows) {
    const c = classify(r, o);
    if (c !== "eligible") excluded[c]++;
    else {
      eligible++;
      if (r.attempt) toRetry++;
      else neverTried++;
    }
  }
  return { eligible, neverTried, toRetry, excluded };
}

// Pure: who a run tries. "send" tries only members never tried for this version; "retry" only those whose last attempt failed or
// was held. Never everyone again.
export type Mode = "dry_run" | "send" | "retry";
export function targets(rows: AudienceRow[], mode: Mode, o: { liveSince: Date | null }): AudienceRow[] {
  const eligible = rows.filter((r) => classify(r, o) === "eligible");
  if (mode === "retry") return eligible.filter((r) => r.attempt === "failed" || r.attempt === "held");
  if (mode === "send") return eligible.filter((r) => r.attempt === null);
  return [];
}

// ---------------------------------------------------------------- 3. permission

export const cardTargetKey = (n: number) => `contact_card:v${n}`;
// The flag Royce passes with a real run: the version and the first 12 characters of its approved content hash.
export const approvalFlag = (v: CardVersion) => `v${v.version}:${cardSha(v).slice(0, 12)}`;

// Pure: whether a real run may send. Every reason it can't is listed.
export function sendPermission(v: CardVersion | null, o: { flag: string | null; phones: Phones; live: CardVersion }): { ok: true } | { ok: false; why: string[] } {
  const why: string[] = [];
  if (!v) return { ok: false, why: ["no such card version"] };
  if (v.approval === "legacy") why.push(`version ${v.version} is the legacy card; it is never pushed`);
  else if (!v.approval) why.push(`version ${v.version} has no approval record from Royce`);
  else if (!isApproved(v)) why.push(`version ${v.version}'s approval doesn't match its content (the card or its note changed after he approved it)`);
  if (v.approval && v.approval !== "legacy" && !numbersStillApproved(v, o.phones)) why.push("a number on the card is not the number it was approved with");
  if (!v.memberNote?.trim()) why.push("no approved note to go with the card");
  if (o.live.version !== v.version) why.push(`version ${v.version} is not the live card (live: ${o.live.version})`);
  if (!o.flag) why.push("no --approved flag");
  else if (o.flag !== approvalFlag(v)) why.push("the --approved flag doesn't match this version's approval");
  return why.length ? { ok: false, why } : { ok: true };
}

// ---------------------------------------------------------------- 4. the run

export type Outcome = { status: "sent" | "failed" | "held"; reason?: string };
export type PushDeps = {
  rows: (version: number) => Promise<AudienceRow[]>;
  liveSince: (version: number) => Promise<Date | null>;
  // One member: the holds, then the send. Never throws (a throw is a failure, recorded).
  sendOne: (r: AudienceRow, v: CardVersion) => Promise<Outcome>;
  record: (userId: string, version: number, o: Outcome) => Promise<void>;
  phones: Phones;
  log: (line: string) => void;
};
export type PushReport = { mode: Mode; version: number; coverage: Coverage; tried: number; sent: number; failed: number; held: number; refused?: string[] };

export async function runPush(o: { version: number; mode: Mode; flag?: string | null; versions?: readonly CardVersion[] }, d: PushDeps): Promise<PushReport> {
  const versions = o.versions ?? CARD_VERSIONS;
  const v = versions.find((x) => x.version === o.version) ?? null;
  const live = liveVersion(versions);
  const liveSince = v ? await d.liveSince(o.version) : null;
  const rows = v ? await d.rows(o.version) : [];
  const cov = coverage(rows, { liveSince });
  const report: PushReport = { mode: o.mode, version: o.version, coverage: cov, tried: 0, sent: 0, failed: 0, held: 0 };
  if (o.mode === "dry_run") return report;
  const p = sendPermission(v, { flag: o.flag ?? null, phones: d.phones, live });
  if (!p.ok) {
    d.log(`card v${o.version}: not sending: ${p.why.join("; ")}`);
    return { ...report, refused: p.why };
  }
  for (const r of targets(rows, o.mode, { liveSince })) {
    report.tried++;
    const out = await d.sendOne(r, v!).catch((err: any): Outcome => ({ status: "failed", reason: String(err?.message ?? err).slice(0, 200) }));
    await d.record(r.id, o.version, out).catch((err: any) => d.log(`card v${o.version}: record failed for a member (non-fatal): ${err?.message ?? err}`));
    report[out.status]++;
  }
  return report;
}

// ---------------------------------------------------------------- real deps (DB, the send path)

export const AUDIENCE_SQL = `
  SELECT u.id, u.phone_number, u.created_at, u.archived_at, u.sms_opted_out, u.identity_captured,
         EXISTS (SELECT 1 FROM harness_decisions d WHERE d.user_id = u.id AND d.decision = 'gate.silent' AND d.action = 'silent_automated') AS bot_blocked,
         EXISTS (SELECT 1 FROM co_profiles p WHERE p.user_id = u.id AND p.safety_hold_until > NOW()) AS safety_hold,
         (EXISTS (SELECT 1 FROM proactive_sends s WHERE s.user_id = u.id AND s.target_key = $1)
           OR EXISTS (SELECT 1 FROM contact_card_sends c WHERE c.user_id = u.id AND c.version = $2 AND c.status = 'sent')) AS sent,
         (SELECT c.status FROM contact_card_sends c WHERE c.user_id = u.id AND c.version = $2 AND c.status <> 'sent') AS attempt
    FROM users u`;

// The versioned card's public URL, on the same host as CO_VCARD_URL (ends in .vcf, as Sendblue requires).
export function versionedCardUrl(base: string | undefined, version: number): string | null {
  if (!base) return null;
  try {
    return `${new URL(base).origin}/cards/v${version}/Cue.vcf`;
  } catch {
    return null;
  }
}

export async function realPushDeps(): Promise<PushDeps> {
  const { default: pool } = await import("../db/db.js");
  const P = await import("../harness/proactive.js");
  const { memberZone } = await import("./memberTime.js");
  return {
    phones: phonesFromEnv(),
    log: (l) => console.log(l),
    rows: async (version) => (await pool.query(AUDIENCE_SQL, [cardTargetKey(version), version])).rows as AudienceRow[],
    liveSince: async (version) => {
      const { rows } = await pool.query(`SELECT live_since FROM contact_card_versions WHERE version = $1`, [version]).catch(() => ({ rows: [] as any[] }));
      return rows[0]?.live_since ? new Date(rows[0].live_since) : null;
    },
    record: async (userId, version, o) => {
      await pool.query(
        `INSERT INTO contact_card_sends (user_id, version, status, reason, attempts, sent_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, CASE WHEN $3 = 'sent' THEN NOW() END, NOW())
         ON CONFLICT (user_id, version) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason,
           attempts = contact_card_sends.attempts + 1, sent_at = COALESCE(contact_card_sends.sent_at, EXCLUDED.sent_at), updated_at = NOW()`,
        [userId, version, o.status, o.reason ?? null],
      );
    },
    sendOne: async (r, v) => {
      const url = versionedCardUrl(process.env.CO_VCARD_URL, v.version);
      if (!url) return { status: "failed", reason: "no card URL (CO_VCARD_URL)" };
      const now = new Date();
      const timezone = await memberZone(r.id);
      // The member's own holds, as dispatch reads them.
      const s = await P.memberSendState(r.id, { timezone, optedOut: r.sms_opted_out === true }, now);
      if (s.state.safetyHold) return { status: "held", reason: "safety hold" };
      if (P.heldForMood(s.state)) return { status: "held", reason: "a hard day" };
      if (s.holdUntil && s.holdUntil > now) return { status: "held", reason: "a hold they asked for" };
      if (s.spaceUntil && s.spaceUntil > now) return { status: "held", reason: "space they asked for" };
      const res = await P.sendExempt({
        userId: r.id,
        phoneNumber: r.phone_number!,
        type: "contact_card",
        targetKey: cardTargetKey(v.version),
        messages: [v.memberNote!],
        mediaUrl: url,
        timezone,
        respectHours: true,
        coInitiated: { kind: null },
      });
      if (res.sent || res.reason === "already sent") return { status: "sent" };
      return { status: /^held|outside local hours|opted out/.test(res.reason ?? "") ? "held" : "failed", reason: res.reason };
    },
  };
}

// The first time a version is served (/co.vcf), it is live from then: a member who joins after that got it at onboarding. Once per
// process per version; never in the way of the card itself.
const servedNoted = new Set<number>();
export function noteVersionServed(version: number): void {
  if (servedNoted.has(version)) return;
  servedNoted.add(version);
  import("../db/db.js")
    .then(({ default: pool }) => pool.query(`INSERT INTO contact_card_versions (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`, [version]))
    .catch((err: any) => {
      servedNoted.delete(version);
      console.error("contact card: live-since not recorded (non-fatal):", err?.message ?? err);
    });
}

// For the PR and the script: a version against the one before it.
export function diffFromPrevious(n: number): ReturnType<typeof cardDiff> | null {
  const v = CARD_VERSIONS.find((x) => x.version === n), before = CARD_VERSIONS.find((x) => x.version === n - 1);
  return v && before ? cardDiff(before, v) : null;
}
