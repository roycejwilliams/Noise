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
import { checkProvenance, expiresOn, isLive, KIND_LIST, renderLive, sameClaim, type Claim, type Kind, type Provenance } from "./factLabels.js";

const ZONE = "America/Los_Angeles";
// Judgment about what is stale is Sonnet's job (Royce's model policy), as the recap always was.
const CLAIMS_MODEL = MODELS.sonnet;

export type Source = { at: string; text: string };
export type Proposed = { text?: unknown; provenance?: unknown; kind?: unknown; quote?: unknown; said_on?: unknown };

// What the member said, with when, from a transcript of exchanges: only their lines.
export function theirWordsOf(rows: { content: string; created_at: Date | string }[]): Source[] {
  const out: Source[] = [];
  for (const r of rows) {
    const at = DateTime.fromJSDate(new Date(r.created_at)).setZone(ZONE).toISODate()!;
    const c = String(r.content);
    if (/ \[to [A-Za-z]+\]\s*$/.test(c)) continue; // their talk with a teammate is not about them
    const said = c.match(/^User said:\s*([\s\S]*)$/i);
    if (said) { out.push({ at, text: said[1].trim() }); continue; }
    if (/^assistant:|\nuser:/i.test(c)) for (const l of c.split("\n")) { const m = l.match(/^\s*user\s*:\s*(.*)$/i); if (m && m[1].trim()) out.push({ at, text: m[1].trim() }); }
  }
  return out;
}

// The model's proposals, checked and finished by code.
export function finishClaims(proposed: Proposed[], sources: Source[], today: string): Claim[] {
  const all = sources.map((s) => s.text).join("\n");
  const out: Claim[] = [];
  for (const p of proposed) {
    const text = typeof p.text === "string" ? p.text.trim().slice(0, 240) : "";
    const kind = KIND_LIST.find((k) => k === p.kind);
    if (!text || !kind) continue;
    const wanted: Provenance = p.provenance === "user_said" ? "user_said" : "co_inferred";
    const checked = checkProvenance(wanted, typeof p.quote === "string" ? p.quote : null, all);
    // When it was said: the day of the message that holds the quote (not the model's word for it).
    const src = checked.quote ? sources.find((s) => s.text.toLowerCase().includes(checked.quote!.toLowerCase())) : null;
    const saidOn = src?.at ?? (typeof p.said_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.said_on) ? p.said_on : today);
    const base = { text, provenance: checked.provenance, kind, quote: checked.quote, saidOn, confirmedOn: saidOn };
    out.push({ ...base, expiresOn: expiresOn(base) });
  }
  return out;
}

// Merge new claims into what is held: the same claim said again is re-confirmed (its clock moves), a new one is added.
export function mergeClaims(held: Claim[], fresh: Claim[]): Claim[] {
  const out = held.map((c) => ({ ...c }));
  for (const f of fresh) {
    const i = out.findIndex((h) => sameClaim(h, f));
    if (i < 0) { out.push(f); continue; }
    const h = out[i];
    // Only their own words re-confirm; a fresh inference never extends a claim, and never overwrites what they said.
    if (f.provenance === "user_said") {
      const confirmedOn = f.saidOn > h.confirmedOn ? f.saidOn : h.confirmedOn;
      const next = { ...h, provenance: "user_said" as Provenance, quote: f.quote ?? h.quote, text: f.saidOn >= h.saidOn ? f.text : h.text, confirmedOn, saidOn: h.saidOn > f.saidOn ? h.saidOn : f.saidOn };
      out[i] = { ...next, expiresOn: expiresOn(next) };
    }
  }
  return out;
}

type Row = { id: string; text: string; provenance: Provenance; kind: Kind; quote: string | null; said_on: Date | string; confirmed_on: Date | string; expires_on: Date | string | null };
const iso = (d: Date | string | null): string | null => (d === null ? null : typeof d === "string" ? d.slice(0, 10) : DateTime.fromJSDate(d).toISODate());
const toClaim = (r: Row): Claim => ({ text: r.text, provenance: r.provenance, kind: r.kind, quote: r.quote, saidOn: iso(r.said_on)!, confirmedOn: iso(r.confirmed_on)!, expiresOn: iso(r.expires_on) });

export async function heldClaims(userId: string): Promise<Claim[]> {
  const { rows } = await pool.query(`SELECT id, text, provenance, kind, quote, said_on, confirmed_on, expires_on FROM member_claims WHERE user_id = $1 ORDER BY said_on`, [userId]).catch(() => ({ rows: [] as Row[] }));
  return rows.map(toClaim);
}

export async function liveClaims(userId: string, now = new Date()): Promise<Claim[]> {
  return (await heldClaims(userId)).filter((c) => isLive(c, now, ZONE));
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
- "kind": one of ${KIND_LIST.join(", ")}.
  Enduring (who they are): identity, building, relationship (cofounder, partner), city, role, preference.
  Ephemeral (expires): plan, deadline, meeting, mood, exploring, worry, pending_decision.
- "said_on": the date of the message holding the quote (YYYY-MM-DD).
A test prompt, a hypothetical, advice they asked for about a made-up situation, or something Co said is NOT a claim about them. Never write a date or a day of the week into "text" unless they wrote it; do not turn a plan into a fact about the present. Skip anything you are not sure they said.

What is already held (do not repeat it; say it again only if they said it again):
${held.map((c) => `- ${c.text}`).join("\n") || "(nothing)"}

Today is ${today}. Their words:
${sources.map((s) => `[${s.at}] ${s.text}`).join("\n").slice(0, 14000)}

Return ONLY JSON: {"claims": [{"text": "...", "provenance": "user_said", "kind": "plan", "quote": "...", "said_on": "YYYY-MM-DD"}]}`,
  });
  return parseModelJson<{ claims?: Proposed[] }>(text).claims ?? [];
}

// Nightly: read what is new, merge it in, and let what has expired go. Returns the live claims.
export async function refreshClaims(userId: string, now = new Date(), deps: { propose?: typeof proposeClaims } = {}): Promise<Claim[]> {
  const today = DateTime.fromJSDate(now).setZone(ZONE).toISODate()!;
  const { rows: last } = await pool.query(`SELECT MAX(created_at) AS at FROM member_claims WHERE user_id = $1`, [userId]).catch(() => ({ rows: [{ at: null }] }));
  const since = last[0]?.at ?? new Date(now.getTime() - 14 * 86400_000);
  const { rows: exchanges } = await pool.query(
    `SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type IN ('text_exchange', 'call_transcript') AND content NOT LIKE 'Co initiated call%' AND created_at > $2 ORDER BY created_at ASC`,
    [userId, since],
  );
  const held = await heldClaims(userId);
  const sources = theirWordsOf(exchanges);
  const proposed = sources.length ? await (deps.propose ?? proposeClaims)(sources, held, today) : [];
  const merged = mergeClaims(held, finishClaims(proposed, sources, today));
  await pool.query(`DELETE FROM member_claims WHERE user_id = $1`, [userId]);
  for (const c of merged) {
    // What has expired is dropped here, not carried: the table holds only claims still inside their lifetime.
    if (!isLive(c, now, ZONE)) continue;
    await pool.query(
      `INSERT INTO member_claims (user_id, text, provenance, kind, quote, said_on, confirmed_on, expires_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId, c.text, c.provenance, c.kind, c.quote, c.saidOn, c.confirmedOn, c.expiresOn],
    );
  }
  return merged.filter((c) => isLive(c, now, ZONE));
}

// The recap: only live claims, each labelled; what they said apart from what Co read into it.
export function renderRecap(claims: Claim[], now: Date): string {
  const r = renderLive(claims, now, ZONE);
  const sec = (title: string, lines: string[]) => (lines.length ? `${title}\n${lines.map((l) => `- ${l}`).join("\n")}` : "");
  return [
    sec("Who they are (they said):", r.enduring),
    sec("What is going on right now (they said it, and it is still inside its lifetime):", r.theySaid),
    sec("Co's read (inference: orientation only, never state it back as something they told you):", r.coInferred),
  ].filter(Boolean).join("\n\n");
}
