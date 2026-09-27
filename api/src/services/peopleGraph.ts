// Who in a room is worth whom, as connections (Royce, 2026-09-26: "Do all"
// on the knowledge-graph ideas). Each member gets a few short "wants" and
// "offers" facts, drawn only from what they've said and what's on file, with
// an embedding each (co_facts). In a room, "A wants what B offers" is found
// by comparing those facts across every guest at once, and the best link
// becomes a hint for the scorer and an internal "because" on the ranking.
//
// Privacy (services/coFacts.ts): these facts are inferred, so they're
// owner-only. They shape who is ranked, never what anyone is told; the only
// words ever shown to another guest stay their own stated ask
// (matching.ts shareReasonFromOwnAsk), and introConsent.ts refuses a draft
// that carries an owner-only fact of the other person.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { generateEmbeddings } from "./embeddings.js";
import { getPersonSnapshot } from "../harness/personSnapshot.js";
import { askEntries } from "../harness/profileWrite.js";

export const PEOPLE_FACTS_MAX_AGE_HOURS = 72;
export const EDGE_MIN_SIMILARITY = 0.45;

export type PeopleInput = { firstName: string; work: string | null; wantsNow: string[]; valuesInPeople: string[]; goals: string[]; lifeChapters: string[]; findAsks: string[]; offering: string | null };
export type WantsOffers = { wants: string[]; offers: string[] };

export function peopleFactsPrompt(p: PeopleInput): string {
  const lines = [
    p.work ? `Work: ${p.work}` : null,
    p.lifeChapters.length ? `Where they are in life: ${p.lifeChapters.join("; ")}` : null,
    p.goals.length ? `Goals: ${p.goals.join("; ")}` : null,
    p.wantsNow.length ? `Wants right now: ${p.wantsNow.join("; ")}` : null,
    p.findAsks.length ? `Asked Co to find: ${p.findAsks.join("; ")}` : null,
    p.offering ? `Said they can offer: ${p.offering}` : null,
    p.valuesInPeople.length ? `What they value in people: ${p.valuesInPeople.join("; ")}` : null,
  ].filter(Boolean);
  return `Below is what a member of a private social club has said or has on file. Write two short lists, 3 to 8 words per item, using only what's written here:

- "wants": the kinds of people they'd want to meet (at most 5)
- "offers": what they'd bring to someone else: what they do, know, or are building (at most 5)

Plain words, no names, no companies. If there's nothing for a list, leave it empty.

${lines.join("\n") || "(nothing on file)"}

Return ONLY JSON: {"wants": ["..."], "offers": ["..."]}`;
}

export function cleanList(v: unknown, max = 5): string[] {
  return (Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => x.length >= 3 && x.split(" ").length <= 12)
    .slice(0, max);
}

export async function readWantsOffers(input: PeopleInput): Promise<WantsOffers | null> {
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      experimental_telemetry: { isEnabled: true, functionId: "peopleGraph.facts" },
      prompt: peopleFactsPrompt(input),
    });
    const r = parseModelJson<{ wants?: unknown; offers?: unknown }>(text);
    return { wants: cleanList(r.wants), offers: cleanList(r.offers) };
  } catch (err: any) {
    console.error("peopleGraph: facts read failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

async function gather(userId: string): Promise<PeopleInput | null> {
  const [u, p, asks, snap] = await Promise.all([
    pool.query(`SELECT first_name FROM users WHERE id = $1 AND archived_at IS NULL`, [userId]).catch(() => ({ rows: [] as any[] })),
    pool.query(`SELECT goals, life_chapters, intent FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] })),
    pool.query(`SELECT ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL AND kind = 'find' ORDER BY created_at DESC LIMIT 5`, [userId]).catch(() => ({ rows: [] as any[] })),
    getPersonSnapshot(userId).catch(() => null),
  ]);
  if (!u.rows[0]) return null;
  const prof = p.rows[0] ?? {};
  const offering = askEntries(prof.intent).filter((i: any) => i.type === "offering").pop()?.text ?? null;
  return {
    firstName: u.rows[0].first_name ?? "Member",
    work: snap?.work ?? null,
    wantsNow: snap?.wantsNow ?? [],
    valuesInPeople: snap?.valuesInPeople ?? [],
    goals: prof.goals ?? [],
    lifeChapters: prof.life_chapters ?? [],
    findAsks: asks.rows.map((r: any) => String(r.ask_text)),
    offering,
  };
}

// Fresh wants/offers for one member, written as owner-only facts. Older
// ones are retired, not deleted. Skipped when the current set is recent.
export async function refreshPeopleFacts(userId: string, opts: { maxAgeHours?: number } = {}): Promise<WantsOffers | null> {
  const maxAge = opts.maxAgeHours ?? PEOPLE_FACTS_MAX_AGE_HOURS;
  const { rows: fresh } = await pool
    .query(
      `SELECT 1 FROM co_facts WHERE owner_user_id = $1 AND relation IN ('wants', 'offers') AND retired_at IS NULL AND created_at > NOW() - make_interval(hours => $2) LIMIT 1`,
      [userId, maxAge],
    )
    .catch(() => ({ rows: [] as any[] }));
  if (fresh.length) return null;
  const input = await gather(userId);
  if (!input) return null;
  const wo = await readWantsOffers(input);
  if (!wo) return null;
  const labels = [...wo.wants.map((l) => ["wants", l] as const), ...wo.offers.map((l) => ["offers", l] as const)];
  const vecs = labels.length ? await generateEmbeddings(labels.map(([, l]) => l)).catch(() => [] as number[][]) : [];
  await pool.query(`UPDATE co_facts SET retired_at = NOW() WHERE owner_user_id = $1 AND relation IN ('wants', 'offers') AND retired_at IS NULL`, [userId]).catch(() => {});
  const now = new Date();
  for (let i = 0; i < labels.length; i++) {
    const [relation, label] = labels[i];
    await pool
      .query(
        `INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, visibility, source, happened_at, embedding)
         VALUES ($1, 'member', $2, $3, $4, 'owner', 'peopleGraph', $5, $6::vector)
         ON CONFLICT (owner_user_id, relation, object_key, happened_at) DO NOTHING`,
        [userId, relation, label, label.toLowerCase(), now, vecs[i] ? `[${vecs[i].join(",")}]` : null],
      )
      .catch((err: any) => console.error("peopleGraph: fact write failed (non-fatal):", err?.message ?? err));
  }
  return wo;
}

export type Edge = { candidateId: string; score: number; want: string | null; offer: string | null; mutual: boolean };

// Pure: the best "wants what they offer" link per candidate, both ways.
// score is the stronger direction's similarity; mutual when both clear the bar.
export function bestEdges(
  personId: string,
  pairs: { wantOwner: string; offerOwner: string; want: string; offer: string; sim: number }[],
  min = EDGE_MIN_SIMILARITY,
): Map<string, Edge> {
  const out = new Map<string, Edge>();
  const forward = new Map<string, { sim: number; want: string; offer: string }>();
  const back = new Map<string, number>();
  for (const p of pairs) {
    if (p.wantOwner === personId && p.offerOwner !== personId) {
      const cur = forward.get(p.offerOwner);
      if (!cur || p.sim > cur.sim) forward.set(p.offerOwner, { sim: p.sim, want: p.want, offer: p.offer });
    } else if (p.offerOwner === personId && p.wantOwner !== personId) {
      back.set(p.wantOwner, Math.max(back.get(p.wantOwner) ?? 0, p.sim));
    }
  }
  const ids = new Set([...forward.keys(), ...back.keys()]);
  for (const id of ids) {
    const f = forward.get(id);
    const b = back.get(id) ?? 0;
    const score = Math.max(f?.sim ?? 0, b);
    if (score < min) continue;
    out.set(id, { candidateId: id, score: Math.round(score * 100) / 100, want: f && f.sim >= min ? f.want : null, offer: f && f.sim >= min ? f.offer : null, mutual: (f?.sim ?? 0) >= min && b >= min });
  }
  return out;
}

// Every guest's wants against every other guest's offers, in one query.
export async function roomEdges(personId: string, candidateIds: string[]): Promise<Map<string, Edge>> {
  if (!candidateIds.length) return new Map();
  const ids = [personId, ...candidateIds];
  const { rows } = await pool
    .query(
      `SELECT w.owner_user_id AS want_owner, o.owner_user_id AS offer_owner, w.object_label AS want, o.object_label AS offer,
              1 - (w.embedding <=> o.embedding) AS sim
       FROM co_facts w JOIN co_facts o ON o.relation = 'offers' AND o.retired_at IS NULL AND o.embedding IS NOT NULL AND o.owner_user_id = ANY($1::uuid[])
       WHERE w.relation = 'wants' AND w.retired_at IS NULL AND w.embedding IS NOT NULL AND w.owner_user_id = ANY($1::uuid[])
         AND w.owner_user_id <> o.owner_user_id AND ($2::uuid IN (w.owner_user_id, o.owner_user_id))`,
      [ids, personId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return bestEdges(
    personId,
    rows.map((r: any) => ({ wantOwner: r.want_owner, offerOwner: r.offer_owner, want: r.want, offer: r.offer, sim: Number(r.sim) })),
  );
}

// Keeps everyone's wants/offers current before a room is scored, a few at a time.
export async function refreshRoom(userIds: string[]): Promise<void> {
  const queue = [...new Set(userIds)];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift()!;
        await refreshPeopleFacts(id).catch(() => null);
      }
    }),
  );
}

// The line the scorer reads about a candidate: internal, never shown.
export function edgeHint(e: Edge | undefined): string | null {
  if (!e) return null;
  if (e.want && e.offer) return `likely overlap: the asker wants "${e.want}" and this person offers "${e.offer}"${e.mutual ? " (and it goes both ways)" : ""}`;
  return e.mutual ? "likely overlap: this person may want what the asker offers" : null;
}
