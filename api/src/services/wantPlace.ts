// Where each want is (Royce, 2026-10-15: "stop treating location as one field on the member with an engine of precedence rules...
// the place lives on the want, not the member"). A want (an open ask, or a goal Co searches for) carries its own place in plain words,
// learned once. Every search for that want (Luma, the web, X) looks there; the member's home city is only the fallback for a want with
// no place. The 10-15 morning that started it: Royce splits his time between Sacramento and SF, his goals were about SF, and the Luma
// search only ever looked in his profile city, so every Luma query came back with the same three Sacramento family events.
//
// Where a place comes from, and nothing else:
//   - the want's own words ("founder dinners in SF"): source "their_words";
//   - for a want recorded after this behavior existed (feature_epochs 'want_places', written by the deploy that brought it), also
//     what they told Co about where that kind of thing happens for them ("I go to SF for all tech stuff"): source "told", always with
//     their exact words as the quote;
//   - their correction ("actually Oakland", through whatCoKnows): source "corrected".
// A want that existed before then is read from its own text only (Royce: "reading place from existing wants never guesses... A
// wrong guessed place is worse than a missing one"). The model only proposes; code keeps a place only when its quote is copied from
// the want or from their own line, and the place is in that quote. Anything else is no place, and the home city stands in.
//
// The first find from a place they didn't name in the want itself (source "told") carries one line saying so (PLACE_NOTE), once per
// want (noted_at). The place shows in what Co knows (whatCoKnows.ts, ref place:<want key>), where it can be corrected or removed.
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";

export const PLACE_LIMITS = { placeChars: 40, placeWords: 4, toldLines: 40, toldDays: 180 } as const;

// "unread": a row the want's window made before its place was read (wantWhen.ts saveWantWhere); placeFor reads it then, as if no row.
export type PlaceSource = "their_words" | "told" | "corrected" | "none" | "removed" | "unread";
export type WantPlace = { key: string; place: string | null; source: PlaceSource; quote: string | null; notedAt: Date | null; windowEnd?: string | null };
export type Want = { key: string; text: string; createdAt: Date | null };

export const wantKeyForAsk = (askRowId: string) => `ask:${askRowId}`;
export const wantKeyForGoal = (goalHash: string) => `goal:${goalHash}`;

// The line the first find from a place they didn't name carries (COPY: Royce approves the exact words in the PR).
export const PLACE_NOTE = (place: string) => `These come from ${place} unless you tell me otherwise.`;

// Words for a kind of thing that can follow a place without making it part of a name ("SF Tech Week", "NYC AI founders").
const KIND_WORDS = new Set(["ai", "tech", "founder", "founders", "startup", "startups", "builder", "builders", "week", "events", "event", "meetup", "meetups", "dinner", "dinners", "community", "communities", "crypto", "web3", "design", "product", "vc", "vcs", "investor", "investors", "climate", "fintech", "health", "art", "arts", "music", "food", "run", "running", "networking", "social", "women", "creators", "creator"]);
const squash = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();

// Pure: the place a read proposed, kept only when it's backed. quote must be copied from one of the sources (the want's own text, or one
// of their own lines), and the place must be in that quote as words. A place too long to be a place is no place.
export function backedPlace(place: unknown, quote: unknown, sources: string[]): { place: string; quote: string } | null {
  const p = String(place ?? "").trim().replace(/[.,;:!?]+$/, "");
  const q = String(quote ?? "").trim();
  if (!p || !q) return null;
  if (p.length > PLACE_LIMITS.placeChars || p.split(/\s+/).length > PLACE_LIMITS.placeWords) return null;
  if (!sources.some((s) => squash(s).includes(squash(q)))) return null;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const m = new RegExp(`(^|[^A-Za-z0-9])(${esc})(?=$|[^A-Za-z0-9])`, "i").exec(q);
  if (!m) return null;
  // Part of a longer name ("South Park Commons", "Berkeley Rep") isn't the place: a wrong place is worse than none (Royce, 2026-10-15).
  // A kind of thing after it is still the place ("SF Tech Week", "SF AI founder events"): only a word that isn't one makes it a name.
  const next = q.slice(m.index + m[0].length).match(/^\s+([A-Z][\w'&.-]*)/)?.[1];
  if (next && !KIND_WORDS.has(next.toLowerCase())) return null;
  // Said as where it isn't ("anywhere but SF", "not in SF", "outside SF"): no place.
  if (/\b(not|but|outside|except|other than|away from|besides|instead of|leaving|left)\s+(in\s+|to\s+|from\s+|of\s+)?$/i.test(q.slice(0, m.index + m[1].length))) return null;
  return { place: p, quote: q };
}

// Pure: whether this want may take a place from what they told Co (recorded after the behavior existed here), or only from its own
// words. No known start, or no known recording time: its own words only (the retrofit never guesses).
export function mayUseTold(w: Want, since: Date | null): boolean {
  return !!since && !!w.createdAt && w.createdAt.getTime() >= since.getTime();
}

export function placePrompt(w: Want, told: string[]): string {
  return `A member asked Cue to look out for something. Say where it's for, only if their words say so.

What they want: "${w.text.slice(0, 300)}"
${told.length ? `\nTheir own words about where things happen for them (newest first):\n${told.map((t) => `- "${t.slice(0, 240)}"`).join("\n")}\n` : ""}
Return the place this want is for, as a city or area in their words ("SF", "Oakland", "New York"), and a quote copied exactly from the want${told.length ? " or from one of their lines" : ""} that says it. A line about where they go for this kind of thing counts ("I go to SF for all tech stuff" for a tech meetup); a line about something else doesn't. Online, remote or anywhere is no place. If nothing they wrote says where, the answer is none: never infer it from who they are, from a company or a program's location, or from anything else.

Reply with JSON only: {"place": "SF", "quote": "..."} or {"place": null}`;
}

export type PlaceDeps = {
  // When this behavior first existed here (feature_epochs), or null when it can't be read.
  since: () => Promise<Date | null>;
  row: (userId: string, key: string) => Promise<WantPlace | null>;
  told: (userId: string) => Promise<string[]>;
  model: (prompt: string) => Promise<string>;
  save: (userId: string, w: Want, p: WantPlace) => Promise<void>;
  log: typeof recordDecision;
  // The member's own day (their zone), and ending a want's window once that day is past it (wantWhen.ts endWindow).
  today?: (userId: string) => Promise<string>;
  endWindow?: (userId: string, key: string) => Promise<void>;
};

// The place of one want: the stored one, or read now (once) and stored. A read that fails is not stored (read again next time) and
// gives no place for this search.
export async function placeFor(userId: string, w: Want, deps: PlaceDeps = realPlaceDeps): Promise<WantPlace> {
  let have = await deps.row(userId, w.key).catch(() => null);
  // Their window is over (their day is past its last day): it ends now, and a place it came with ends with it (Royce, 2026-10-16).
  // A day that can't be read leaves the window as it is.
  if (have?.windowEnd && deps.today && deps.endWindow) {
    const today = await deps.today(userId).catch(() => null);
    if (today && have.windowEnd < today) {
      await deps.endWindow(userId, w.key).catch((err: any) => console.error("wantPlace: ending the window failed (non-fatal):", err?.message ?? err));
      have = await deps.row(userId, w.key).catch(() => null);
    }
  }
  if (have && have.source !== "unread") return have;
  const since = await deps.since().catch(() => null);
  const told = mayUseTold(w, since) ? await deps.told(userId).catch(() => [] as string[]) : [];
  let raw: string;
  try {
    raw = await deps.model(placePrompt(w, told));
  } catch (err: any) {
    console.error("wantPlace: the read failed (non-fatal, no place for this search):", err?.message ?? err);
    return { key: w.key, place: null, source: "none", quote: null, notedAt: null };
  }
  let parsed: { place?: unknown; quote?: unknown } = {};
  try {
    parsed = JSON.parse((raw.match(/\{[\s\S]*\}/) ?? ["{}"])[0]);
  } catch {
    parsed = {};
  }
  const fromWant = backedPlace(parsed.place, parsed.quote, [w.text]);
  const fromTold = !fromWant && told.length ? backedPlace(parsed.place, parsed.quote, told) : null;
  const got = fromWant ?? fromTold;
  const p: WantPlace = got ? { key: w.key, place: got.place, source: fromWant ? "their_words" : "told", quote: got.quote, notedAt: null } : { key: w.key, place: null, source: "none", quote: null, notedAt: null };
  await deps.save(userId, w, p).catch((err: any) => console.error("wantPlace: storing the place failed (non-fatal):", err?.message ?? err));
  await deps
    .log({ layer: 3, decision: "want.place", userId, outcome: got ? "act" : "skip", action: got ? p.source : parsed.place ? "unbacked" : "none", proposal: { key: w.key, want: w.text.slice(0, 160), place: p.place, quote: p.quote, proposed: parsed.place ?? null, retro: !mayUseTold(w, since) } })
    .catch(() => {});
  return p;
}

// What the first find from a place they didn't name carries, once: their place for this want, when it came from what they told Co
// (not the want's own words, not a correction they made) and wasn't said yet.
// Their home city by any spelling ("Sacramento" and "Sacramento, CA") is home.
export const ALIASES: Record<string, string> = { sf: "san francisco", "san fran": "san francisco", nyc: "new york", "new york city": "new york", ny: "new york", la: "los angeles", dc: "washington", "washington dc": "washington", philly: "philadelphia", atl: "atlanta", chi: "chicago", sac: "sacramento" };
export const samePlace = (a: string | null | undefined, b: string | null | undefined) => {
  const k = (x: string | null | undefined) => {
    const c = String(x ?? "").split(",")[0].trim().toLowerCase().replace(/\./g, "");
    return ALIASES[c] ?? c;
  };
  return !!k(a) && k(a) === k(b);
};
export function noteDue(p: Pick<WantPlace, "place" | "source" | "notedAt"> | null | undefined, home?: string | null): string | null {
  return p && p.place && p.source === "told" && !p.notedAt && !samePlace(p.place, home) ? PLACE_NOTE(p.place) : null;
}

export async function markNoted(userId: string, key: string): Promise<void> {
  await pool.query(`UPDATE want_places SET noted_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND want_key = $2 AND noted_at IS NULL`, [userId, key]);
}

// Their correction (whatCoKnows.ts): the place they said, or none (the home city stands in, and it's never read again).
// The correction also clears this want's resolved place (placeResolve.ts: resolved again, for the new place, on its next search) and
// drops the finds pooled for this want from the old place (Royce, 2026-10-29: "invalidates that ask's old cached location and its
// cached results"). Only this want: never their home, never another want's finds. Its finds queued but not yet sent are cancelled too,
// on the same change (whatCoKnows.ts cancelQueued, "place corrected"; Royce 2026-10-29, replacing the 10-15 "queued finds still go").
export async function setPlace(db: { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> }, userId: string, key: string, place: string | null, theirWords: string) {
  const r = await db.query(
    `UPDATE want_places SET place = $3, source = $4, quote = $5, noted_at = COALESCE(noted_at, NOW()), updated_at = NOW(),
       resolved_for = NULL, resolved_home = NULL, resolved_status = NULL, resolved_label = NULL, resolved_lat = NULL, resolved_lng = NULL, resolved_options = NULL, resolved_at = NULL
     WHERE user_id = $1 AND want_key = $2`,
    [userId, key, place, place ? "corrected" : "removed", theirWords.slice(0, 300)],
  );
  if (r.rowCount) await dropWantFinds(db, userId, key);
  return r;
}

// Pure: a backlog's items without this want's finds: the ask's own backlog (an ask's key), or finds searched for it (searchedIn.key).
export function withoutWantFinds(askId: string, items: unknown[], key: string): unknown[] {
  const askRow = key.startsWith("ask:") ? key.slice(4) : null;
  return items.filter((it: any) => !(String(askId) === askRow || it?.match?.searchedIn?.key === key));
}
async function dropWantFinds(db: { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> }, userId: string, key: string): Promise<void> {
  const { rows } = await db.query(`SELECT ask_id, items FROM event_backlogs WHERE user_id = $1 FOR UPDATE`, [userId]);
  for (const b of rows) {
    const items = Array.isArray(b.items) ? b.items : [];
    const kept = withoutWantFinds(String(b.ask_id), items, key);
    if (kept.length !== items.length) await db.query(`UPDATE event_backlogs SET items = $3, updated_at = NOW() WHERE user_id = $1 AND ask_id = $2`, [userId, b.ask_id, JSON.stringify(kept)]);
  }
}

// The stored places of the wants they have open (for what Co knows).
export async function placesOf(userId: string, keys: string[], db: { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<{ key: string; want: string; place: string | null; source: PlaceSource }[]> {
  if (!keys.length) return [];
  const { rows } = await db.query(`SELECT want_key, want_text, place, source FROM want_places WHERE user_id = $1 AND want_key = ANY($2::text[])`, [userId, keys]);
  return rows.map((r: any) => ({ key: String(r.want_key), want: String(r.want_text ?? ""), place: r.place ?? null, source: String(r.source) as PlaceSource }));
}

// Pure: which of these wants search their home city together, and which have a place of their own that isn't home (each searched
// on its own, there). No place, or the home city by name, is home.
export function splitByPlace<T>(items: { key: string; item: T }[], places: { key: string; place: string | null }[], home: string | null): { home: { key: string; item: T }[]; own: { key: string; item: T; place: string }[] } {
  const by = new Map(places.map((p) => [p.key, p.place]));
  const out = { home: [] as { key: string; item: T }[], own: [] as { key: string; item: T; place: string }[] };
  for (const it of items) {
    const p = by.get(it.key) ?? null;
    if (p && !samePlace(p, home)) out.own.push({ ...it, place: p });
    else out.home.push(it);
  }
  return out;
}

let sinceCache: Date | null = null;
export const realPlaceDeps: PlaceDeps = {
  since: async () => {
    if (sinceCache) return sinceCache;
    const { rows } = await pool.query(`SELECT since FROM feature_epochs WHERE name = 'want_places'`);
    sinceCache = rows[0]?.since ? new Date(rows[0].since) : null;
    return sinceCache;
  },
  row: async (userId, key) => {
    const { rows } = await pool.query(`SELECT want_key, place, source, quote, noted_at, window_end FROM want_places WHERE user_id = $1 AND want_key = $2`, [userId, key]);
    const end = rows[0]?.window_end ? (rows[0].window_end instanceof Date ? rows[0].window_end.toISOString().slice(0, 10) : String(rows[0].window_end).slice(0, 10)) : null;
    return rows[0] ? { key, place: rows[0].place ?? null, source: String(rows[0].source) as PlaceSource, quote: rows[0].quote ?? null, notedAt: rows[0].noted_at ? new Date(rows[0].noted_at) : null, windowEnd: end } : null;
  },
  today: async (userId) => {
    const { memberZone, localDay } = await import("./memberTime.js");
    return localDay(new Date(), await memberZone(userId));
  },
  endWindow: async (userId, key) => {
    const { endWindow } = await import("./wantWhen.js");
    await endWindow(pool, userId, key);
  },
  // Their own lines that say where they are or go (a place word next to a capitalized name), newest first, never a line to a teammate.
  told: async (userId) => {
    const { notToTeammate } = await import("./teamLines.js");
    const { rows } = await pool.query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()}
         AND created_at > NOW() - make_interval(days => $2)
         AND content ~* '\\m(in|to|from|based|live|living|lives|split|go|going|head|heading|travel|move|moving|around)\\M'
       ORDER BY created_at DESC LIMIT 200`,
      [userId, PLACE_LIMITS.toldDays],
    );
    // Only their words: the notes Co adds to their line (what a photo shows, a link it read) are cut first.
    return rows
      .map((r: any) => String(r.content).replace(/^User said:\s*/, "").replace(/\s*\[[^\]]*\]/g, "").trim())
      .filter((t) => /\s[A-Z][a-zA-Z]+/.test(t))
      .slice(0, PLACE_LIMITS.toldLines);
  },
  model: async (prompt) => {
    const { generateText } = await import("ai");
    const { anthropic } = await import("@ai-sdk/anthropic");
    const { MODELS } = await import("../models.js");
    const r = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 200, abortSignal: AbortSignal.timeout(20_000), experimental_telemetry: { isEnabled: true, functionId: "wantPlace.read", recordInputs: false, recordOutputs: false }, prompt });
    return r.text;
  },
  save: async (userId, w, p) => {
    await pool.query(
      `INSERT INTO want_places (user_id, want_key, want_text, place, source, quote) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, want_key) DO UPDATE SET place = EXCLUDED.place, source = EXCLUDED.source, quote = EXCLUDED.quote, read_at = NOW(), updated_at = NOW()
         WHERE want_places.source = 'unread'`,
      [userId, w.key, w.text.slice(0, 300), p.place, p.source, p.quote],
    );
  },
  log: recordDecision,
};
