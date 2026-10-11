// The claims Co holds about a member, each labelled (user_said / co_inferred) and given a lifetime (services/factLabels.ts).
// The nightly recap is now a RENDERING of the live claims, not a model's revision of its own last recap, so nothing ephemeral
// can outlive its lifetime by being quietly re-asserted night after night.
//
// Where claims come from: the member's own words (what they texted, and their side of a call). The model reads those words and
// proposes claims with a kind and, for what they said, a quote; code then checks the quote is really theirs (else the claim is
// co_inferred), decides the lifetime from the kind, resolves a relative day against when it was said, and re-confirms a claim
// they say again. Co's own lines are never a source of what they said.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { FALLBACK_ZONE, memberZone, wordsZone } from "./memberTime.js";
import { checkProvenance, expiresOn, isLive, KIND_LIST, renderLive, sameClaim, type Claim, type Kind, type Provenance } from "./factLabels.js";

// Days are the member's (services/memberTime.ts); ZONE is only the fallback when theirs isn't known.
const ZONE = FALLBACK_ZONE;
// Judgment about what is stale is Sonnet's job (Royce's model policy), as the recap always was.
const CLAIMS_MODEL = MODELS.sonnet;

export type Source = { at: string; text: string };
export type Proposed = { text?: unknown; provenance?: unknown; kind?: unknown; quote?: unknown; said_on?: unknown };

// What the member said, with when, from a transcript of exchanges: only their lines.
export function theirWordsOf(rows: { content: string; created_at: Date | string }[], zone: string = ZONE): Source[] {
  const out: Source[] = [];
  for (const r of rows) {
    const at = DateTime.fromJSDate(new Date(r.created_at)).setZone(zone).toISODate()!;
    const c = String(r.content);
    if (/ \[to [A-Za-z]+\]\s*$/.test(c)) continue; // their talk with a teammate is not about them
    const said = c.match(/^User said:\s*([\s\S]*)$/i);
    if (said) { out.push({ at, text: said[1].trim() }); continue; }
    if (/^\s*(?:assistant|user):|\nuser:/i.test(c)) for (const l of c.split("\n")) { const m = l.match(/^\s*user\s*:\s*(.*)$/i); if (m && m[1].trim()) out.push({ at, text: m[1].trim() }); }
  }
  return out;
}

// The model's proposals, checked and finished by code.
// The kinds the model may propose. "away" is written only by code, from their own latest words (services/away.ts): a model read
// that rebuilt one could restore a hold they had already ended (review of #140).
export const MODEL_KINDS = KIND_LIST.filter((k) => k !== "away");

export function finishClaims(proposed: Proposed[], sources: Source[], today: string, zone: string = ZONE): Claim[] {
  const all = sources.map((s) => s.text).join("\n");
  const out: Claim[] = [];
  for (const p of proposed) {
    const text = typeof p.text === "string" ? p.text.trim().slice(0, 240) : "";
    const kind = MODEL_KINDS.find((k) => k === p.kind);
    if (!text || !kind) continue;
    const wanted: Provenance = p.provenance === "user_said" ? "user_said" : "co_inferred";
    const checked = checkProvenance(wanted, typeof p.quote === "string" ? p.quote : null, all);
    // When it was said: the day of the message that holds the quote (not the model's word for it).
    const src = checked.quote ? sources.find((s) => s.text.toLowerCase().includes(checked.quote!.toLowerCase())) : null;
    // No quote (Co's inference): dated by the latest words it was drawn from, never by the model's word and never "today".
    const latest = sources.reduce((m, s) => (s.at > m ? s.at : m), "");
    const saidOn = src?.at ?? (latest || today);
    const base = { text, provenance: checked.provenance, kind, quote: checked.quote, saidOn, confirmedOn: saidOn };
    out.push({ ...base, expiresOn: expiresOn(base, zone) });
  }
  return out;
}

// Merge new claims into what is held: the same claim said again is re-confirmed (its clock moves), a new one is added.
export function mergeClaims(held: Claim[], fresh: Claim[], zone: string = ZONE): Claim[] {
  const out = held.map((c) => ({ ...c }));
  for (const f of fresh) {
    const i = out.findIndex((h) => sameClaim(h, f));
    if (i < 0) { out.push(f); continue; }
    const h = out[i];
    // Only their own words re-confirm; a fresh inference never extends a claim, and never overwrites what they said.
    if (f.provenance === "user_said") {
      const confirmedOn = f.saidOn > h.confirmedOn ? f.saidOn : h.confirmedOn;
      const next = { ...h, provenance: "user_said" as Provenance, quote: f.quote ?? h.quote, text: f.saidOn >= h.saidOn ? f.text : h.text, confirmedOn, saidOn: h.saidOn > f.saidOn ? h.saidOn : f.saidOn };
      out[i] = { ...next, expiresOn: expiresOn(next, zone) };
    }
  }
  return out;
}

type Row = { id: string; text: string; provenance: Provenance; kind: Kind; quote: string | null; said_on: Date | string; confirmed_on: Date | string; expires_on: Date | string | null };
const iso = (d: Date | string | null): string | null => (d === null ? null : typeof d === "string" ? d.slice(0, 10) : DateTime.fromJSDate(d).toISODate());
const toClaim = (r: Row): Claim => ({ text: r.text, provenance: r.provenance, kind: r.kind, quote: r.quote, saidOn: iso(r.said_on)!, confirmedOn: iso(r.confirmed_on)!, expiresOn: iso(r.expires_on) });

// A failed read throws: callers that rewrite the table must never mistake "couldn't read" for "nothing held".
export async function heldClaimsStrict(userId: string, q: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<Claim[]> {
  const { rows } = await q.query(`SELECT id, text, provenance, kind, quote, said_on, confirmed_on, expires_on FROM member_claims WHERE user_id = $1 ORDER BY said_on`, [userId]);
  return (rows as Row[]).map(toClaim);
}
export async function heldClaims(userId: string): Promise<Claim[]> {
  return heldClaimsStrict(userId).catch((err) => { console.error("claims: read failed (treated as none for display only):", err?.message ?? err); return [] as Claim[]; });
}
// First run for a member reads this far back, so what they said long ago (their city, what they are building) is not lost.
export const FIRST_RUN_DAYS = 120;

export async function liveClaims(userId: string, now = new Date(), zoneIn?: string | null): Promise<Claim[]> {
  const zone = wordsZone(zoneIn !== undefined ? zoneIn : await memberZone(userId));
  return (await heldClaims(userId)).filter((c) => isLive(c, now, zone));
}

// Their live claims, labelled and dated in their zone: what a reply or a call reads.
export async function liveClaimsRendered(userId: string, now = new Date()): Promise<ReturnType<typeof renderLive>> {
  const zone = wordsZone(await memberZone(userId));
  return renderLive(await liveClaims(userId, now, zone), now, zone);
}

// The model's read of what they said. It proposes; finishClaims decides.
export async function proposeClaims(sources: Source[], held: Claim[], today: string): Promise<Proposed[]> {
  if (!sources.length) return [];
  const { text } = await generateText({
    model: anthropic(CLAIMS_MODEL),
    experimental_telemetry: { isEnabled: true, functionId: "claims.propose", recordInputs: false, recordOutputs: false },
    prompt: `You keep a short list of CLAIMS about one person, from their own words only. Below is what they wrote (and said on calls), oldest first, each with its date.

For each thing worth keeping, write one claim:
- "text": one plain sentence about them, third person.
- "provenance": "user_said" ONLY if they said it and you can copy a "quote" of at least 8 characters from THEIR words below, exactly as written. Otherwise "co_inferred" (something you concluded) with no quote.
- "kind": one of ${MODEL_KINDS.join(", ")}.
  Enduring (who they are): identity, building, relationship (cofounder, partner), city, role, preference.
  Ephemeral (expires): plan, deadline, meeting, mood, exploring, worry, pending_decision.
- "said_on": the date of the message holding the quote (YYYY-MM-DD).
A test prompt, a hypothetical, advice they asked for about a made-up situation, or something Co said is NOT a claim about them. Never write a date or a day of the week into "text" unless they wrote it; do not turn a plan into a fact about the present. Skip anything you are not sure they said.

What is already held (do not repeat it; say it again only if they said it again):
${held.map((c) => `- ${c.text}`).join("\n") || "(nothing)"}

Today is ${today}. Their words:
${sources.map((s) => `[${s.at}] ${s.text}`).join("\n").slice(-14000)}

Return ONLY JSON: {"claims": [{"text": "...", "provenance": "user_said", "kind": "plan", "quote": "...", "said_on": "YYYY-MM-DD"}]}`,
  });
  return parseModelJson<{ claims?: Proposed[] }>(text).claims ?? [];
}

// Nightly: read what is new, merge it in, and let what has expired go. Returns the live claims.
// Atomic: the member's claims are rewritten in one transaction under a per-member lock, from a read that must have succeeded, and
// nothing is rewritten when the model call failed (the held claims stay as they were and the marker does not move).
export async function refreshClaims(userId: string, now = new Date(), deps: { propose?: typeof proposeClaims; db?: { connect: () => Promise<any> }; zone?: string | null } = {}): Promise<Claim[]> {
  const zone = wordsZone(deps.zone !== undefined ? deps.zone : await memberZone(userId));
  const today = DateTime.fromJSDate(now).setZone(zone).toISODate()!;
  const client = await (deps.db ?? pool).connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('member_claims:' || $1))`, [userId]);
    const { rows: st } = await client.query(`SELECT refreshed_at FROM member_claims_state WHERE user_id = $1`, [userId]);
    const since = st[0]?.refreshed_at ?? new Date(now.getTime() - FIRST_RUN_DAYS * 86400_000);
    const { rows: exchanges } = await client.query(
      `SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type IN ('text_exchange', 'call_transcript') AND content NOT LIKE 'Co initiated call%' AND created_at > $2 ORDER BY created_at ASC`,
      [userId, since],
    );
    const held = await heldClaimsStrict(userId, client);
    const sources = theirWordsOf(exchanges, zone);
    const proposed = sources.length ? await (deps.propose ?? proposeClaims)(sources, held, today) : [];
    const merged = mergeClaims(held, finishClaims(proposed, sources, today, zone), zone);
    await client.query(`DELETE FROM member_claims WHERE user_id = $1`, [userId]);
    for (const c of merged) {
      // What has expired is dropped here, not carried: the table holds only claims still inside their lifetime.
      if (!isLive(c, now, zone)) continue;
      await client.query(
        `INSERT INTO member_claims (user_id, text, provenance, kind, quote, said_on, confirmed_on, expires_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [userId, c.text, c.provenance, c.kind, c.quote, c.saidOn, c.confirmedOn, c.expiresOn],
      );
    }
    await client.query(`INSERT INTO member_claims_state (user_id, refreshed_at) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at`, [userId, now]);
    await client.query("COMMIT");
    return merged.filter((c) => isLive(c, now, zone));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// A recap read back into what they said and what Co read into it. A recap from before the claims rebuild (prose, unlabelled) is
// all background: it can't back a date, an event or a commitment.
export function splitRecap(recap: string): { theySaid: string; coRead: string } {
  if (!/^(Who they are|What is going on right now|Co's read)/m.test(recap)) return { theySaid: "", coRead: recap };
  const sections = recap.split(/\n\n(?=[A-Z])/);
  const coRead = sections.filter((s) => s.startsWith("Co's read")).join("\n\n");
  return { theySaid: sections.filter((s) => !s.startsWith("Co's read")).join("\n\n"), coRead };
}

// The recap: only live claims, each labelled; what they said apart from what Co read into it.
export function renderRecap(claims: Claim[], now: Date, zone: string | null = ZONE): string {
  const r = renderLive(claims, now, wordsZone(zone));
  const sec = (title: string, lines: string[]) => (lines.length ? `${title}\n${lines.map((l) => `- ${l}`).join("\n")}` : "");
  return [
    sec("Who they are (they said):", r.enduring),
    sec("What is going on right now (they said it, and it is still inside its lifetime):", r.theySaid),
    sec("Co's read (inference: orientation only, never state it back as something they told you):", r.coInferred),
  ].filter(Boolean).join("\n\n");
}
