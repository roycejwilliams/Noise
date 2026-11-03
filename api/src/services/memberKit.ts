// The details Co needs to do things for someone, kept so it never guesses
// them and never asks twice (Royce, 2026-09-29, from Instinct: it lists which
// details it will use, and asks numbered questions only for what it must not
// guess, only when a form needs them). Account details already exist (name,
// email, phone, city); company, role and LinkedIn are new and are saved only
// from the member's own words.
import pool from "../db/db.js";
import { PENDING_EMAIL_DOMAIN } from "./identity.js";

export type KitKey = "full_name" | "email" | "phone" | "city" | "company" | "role" | "linkedin";

export const KIT_LABELS: Record<KitKey, string> = {
  full_name: "your full name",
  email: "your email",
  phone: "your phone number",
  city: "the city you're in",
  company: "your company or project",
  role: "your role",
  linkedin: "your LinkedIn link",
};

// The ones Co saves itself, from what they say.
export const SAVED_KEYS: KitKey[] = ["company", "role", "linkedin"];

export type Kit = Partial<Record<KitKey, string>>;

export async function loadKit(userId: string): Promise<Kit> {
  const [account, profile, saved] = await Promise.all([
    pool.query(`SELECT first_name, last_name, email, phone_number FROM users WHERE id = $1`, [userId]).then((r) => r.rows[0] ?? null).catch(() => null),
    pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId]).then((r) => r.rows[0] ?? null).catch(() => null),
    pool.query(`SELECT key, value FROM member_kit WHERE user_id = $1`, [userId]).then((r) => r.rows).catch(() => [] as any[]),
  ]);
  const kit: Kit = {};
  const name = [account?.first_name, account?.last_name].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
  if (name && account?.last_name) kit.full_name = name;
  // The placeholder a new member has until they give theirs (services/identity.ts) is never their email (ruling A: Cue answers before it).
  if (account?.email && !String(account.email).endsWith(PENDING_EMAIL_DOMAIN)) kit.email = String(account.email);
  if (account?.phone_number) kit.phone = String(account.phone_number);
  if (profile?.city) kit.city = String(profile.city);
  for (const r of saved) if (SAVED_KEYS.includes(r.key)) kit[r.key as KitKey] = String(r.value);
  return kit;
}

// What Co reads: which details it has and which it doesn't. Email and phone
// are named, never shown; what they said about their work is shown, to use.
export function kitLines(kit: Kit): string[] {
  const have = (Object.keys(KIT_LABELS) as KitKey[]).filter((k) => kit[k]);
  const missing = (Object.keys(KIT_LABELS) as KitKey[]).filter((k) => !kit[k]);
  const lines: string[] = [`Details on file for doing things on their behalf: ${have.length ? have.map((k) => KIT_LABELS[k]).join(", ") : "none"}. Not on file: ${missing.length ? missing.map((k) => KIT_LABELS[k]).join(", ") : "nothing"}.`];
  const shown: string[] = [];
  if (kit.company) shown.push(`company or project: ${kit.company}`);
  if (kit.role) shown.push(`role: ${kit.role}`);
  if (kit.linkedin) shown.push(`LinkedIn: ${kit.linkedin}`);
  if (kit.city) shown.push(`city: ${kit.city}`);
  if (shown.length) lines.push(`What they've told Cue about themselves for this: ${shown.join("; ")}.`);
  return lines;
}

// "I'll use your name, your email and your LinkedIn link", before anything
// goes out under their name.
export function detailsToUse(kit: Kit, keys: KitKey[]): { line: string; missing: KitKey[] } {
  const have = keys.filter((k) => kit[k]);
  const missing = keys.filter((k) => !kit[k]);
  const list = have.map((k) => KIT_LABELS[k]);
  const joined = list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return { line: have.length ? `I'll use ${joined}.` : "", missing };
}

const norm = (t: string) => t.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

// A detail is saved only if it is really in what they wrote, in the right shape.
export function checkKitValue(key: KitKey, value: string, theirMessage: string): { ok: true; value: string } | { ok: false; why: string } {
  if (!SAVED_KEYS.includes(key)) return { ok: false, why: "That one isn't saved this way." };
  const v = value.trim().replace(/\s+/g, " ");
  if (v.length < 2 || v.length > 120) return { ok: false, why: "Too short or too long to be that." };
  if (!norm(theirMessage).includes(norm(v))) return { ok: false, why: "It has to be something they actually wrote." };
  if (key === "linkedin" && !/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in|company)\/[\w\-%.]+\/?$/i.test(v)) return { ok: false, why: "That isn't a LinkedIn profile link." };
  return { ok: true, value: v };
}

export async function saveKitFact(userId: string, key: KitKey, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO member_kit (user_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [userId, key, value],
  );
}
