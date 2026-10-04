// Synthetic members and helpers. Phones are in the fictional 555-01xx range
// (services/testNumbers.ts), emails are .invalid, and every row lives in the
// TEMP shadows of the case's savepoint.
import { raw } from "./db.js";

export const PHONE = { A: "+14155550100", B: "+14155550101", C: "+14155550102", D: "+14155550103", E: "+14155550104" };
export const ID = {
  A: "c0000000-0000-4000-8000-0000000000a1",
  B: "c0000000-0000-4000-8000-0000000000b2",
  C: "c0000000-0000-4000-8000-0000000000c3",
  D: "c0000000-0000-4000-8000-0000000000d4",
  E: "c0000000-0000-4000-8000-0000000000e5",
};
export const NAME = { A: "Avery", B: "Jordan", C: "Noor", D: "Ellis", E: "Sam" };
export type Who = keyof typeof ID;

export async function member(w: Who, o: { city?: string | null; first?: string; identity?: boolean; invite?: boolean; extra?: Record<string, any>; profile?: Record<string, any> } = {}) {
  const first = o.first ?? NAME[w];
  const e = { contact_verified: true, identity_captured: o.identity ?? true, intake_asked: true, invite_verified: o.invite ?? true, ...(o.extra ?? {}) };
  const cols = ["id", "first_name", "last_name", "email", "phone_number", "username", ...Object.keys(e)];
  const vals = [ID[w], first, "Test", `${first.toLowerCase()}.${w.toLowerCase()}@co.invalid`, PHONE[w], `${first.toLowerCase()}_${w.toLowerCase()}`, ...Object.values(e)];
  await raw(`INSERT INTO users (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, vals);
  const prof = { city: o.city === undefined ? "San Francisco" : o.city, ...(o.profile ?? {}) };
  const pc = ["user_id", ...Object.keys(prof)];
  await raw(`INSERT INTO co_profiles (${pc.join(",")}) VALUES (${pc.map((_, i) => `$${i + 1}`).join(",")})`, [ID[w], ...Object.entries(prof).map(([k, v]) => (JSONB_COLS.has(k) || (v !== null && typeof v === "object" && !Array.isArray(v)) ? JSON.stringify(v) : v))]);
  // Timezone lookups read this cache; without a row they'd call Google (blocked).
  if (prof.city) await raw(`INSERT INTO geocode_cache (query, lat, lng, timezone) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [prof.city, ...(CITY[prof.city] ?? [37.7749, -122.4194, "America/Los_Angeles"])]);
  return { id: ID[w], phone: PHONE[w], first };
}
const JSONB_COLS = new Set(["intent", "trust_components", "topics_covered", "topics_asked"]);
export const CITY: Record<string, [number, number, string]> = {
  "San Francisco": [37.7749, -122.4194, "America/Los_Angeles"],
  Portland: [45.5152, -122.6784, "America/Los_Angeles"],
  Oakland: [37.8044, -122.2712, "America/Los_Angeles"],
};
export function intent(entries: { text: string; type: "seeking" | "offering"; id?: string }[]) {
  return entries.map((e, i) => ({ id: e.id ?? `ask-${i + 1}`, text: e.text, type: e.type, status: "active", created_at: new Date().toISOString() }));
}

// Fixture memories existed before the case: created a minute before the
// case's NOW(), so production rows written during the case come after them.
export async function memory(w: Who, type: string, content: string, embedding?: number[], ageMinutes = 1) {
  await raw(`INSERT INTO co_memories (user_id, memory_type, content, created_at${embedding ? ", content_embedding" : ""}) VALUES ($1, $2, $3, NOW() - make_interval(mins => $4)${embedding ? ", $5::vector" : ""})`, embedding ? [ID[w], type, content, ageMinutes, `[${embedding.join(",")}]`] : [ID[w], type, content, ageMinutes]);
}

export async function rows(sql: string, values?: any[]) {
  return (await raw(sql, values)).rows;
}

export type Check = { name: string; pass: boolean; reason?: string };
export const ck = (name: string, pass: boolean, reason?: unknown): Check => ({ name, pass: !!pass, ...(pass ? {} : { reason: typeof reason === "string" ? reason : JSON.stringify(reason)?.slice(0, 600) }) });
export type CaseResult = { status?: "pass" | "fail" | "blocked"; checks: Check[]; observed?: any; texts?: any };
export type Case = { suite: string; id: string; mode?: "fixture-live" | "source-live" | "model-free"; runs1?: boolean; allowRefusals?: boolean; replaced?: string[]; run: (ctx: { run: number; DB: typeof import("./db.js") }) => Promise<CaseResult> };
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
