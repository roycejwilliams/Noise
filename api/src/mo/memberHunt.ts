// Member-facing Mo, step 1: hunt from memory, not setup (spec requirement 1). The input is only what Co already holds
// for the member: their open "seeking" asks and their person model. Nothing is configured. The output is at most three
// people, each backed by a quote of their own public words, stored as an OPEN batch for the member to see. Nothing
// leaves the club here: this only reads the public web and writes the member's own rows.
//
// Leak rules (standing, and the same ones the team Mo keeps): a search query never carries a run of five words from
// any member's ask, and never a member's name (queryLeaks); a person is kept only if the quote is theirs (quoteIsTheirs);
// the member's name and ask reach a stranger only in the message the member approves later.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { MO, inCity, neutralPronouns, placeOk, quoteIsTheirs, suppressionKeys } from "./rules.js";
import { queryLeaks } from "./find.js";
import { searchPostsWithAuthors, type MoPost } from "./xApi.js";
import { huntAllowed, optInRow, openBatch, storeBatch, type Found } from "./memberFlow.js";
import { MEMBER_MO } from "./memberRules.js";

export type Judged = { index: number; fit: boolean; why: string; quote: string; inCity?: boolean };
export type Plan = { queries: string[]; need: string };

export type HuntDeps = {
  now: () => Date;
  openAsks: (userId: string) => Promise<string[]>;
  isHuntable: (ask: string) => Promise<boolean>;
  personModel: (userId: string) => Promise<string>;
  plan: (ask: string, person: string) => Promise<Plan>;
  memberNames: () => Promise<string[]>;
  allAsks: () => Promise<string[]>;
  search: (query: string) => Promise<MoPost[]>;
  judge: (ask: string, person: string, posts: MoPost[]) => Promise<Judged[]>;
  alreadyKnown: (keys: string[], xUserId: string | null) => Promise<boolean>;
};

export type HuntResult = { status: "stored" | "none" | "skipped"; why?: string; batchId?: string; found?: number };

export async function huntForMember(userId: string, deps: HuntDeps): Promise<HuntResult> {
  const now = deps.now();
  const [opt, open] = await Promise.all([optInRow(userId), openBatch(userId)]);
  const allowed = huntAllowed({ optIn: opt?.status ?? null, paused: !!opt?.paused_at, lastHuntAt: opt?.hunt_last_at ? new Date(opt.hunt_last_at) : null, openBatch: !!open, now });
  if (!allowed.ok) return { status: "skipped", why: allowed.why ?? undefined };

  // The newest open ask a person could answer (a designer, an investor, a cofounder): advice and feelings are never hunted.
  let ask: string | null = null;
  for (const a of await deps.openAsks(userId)) {
    if (await deps.isHuntable(a)) {
      ask = a;
      break;
    }
  }
  if (!ask) return { status: "skipped", why: "no open ask a person could answer" };

  const person = await deps.personModel(userId).catch(() => "");
  // The plan (and so every search query) is made from the ask alone: nothing from the person model can reach X's search.
  const plan = await deps.plan(ask, "");
  const [names, asks] = await Promise.all([deps.memberNames(), deps.allAsks()]);
  const queries = plan.queries.filter((q) => q.length < 400 && !queryLeaks(q, asks, names)).slice(0, 3);
  if (!queries.length || !plan.need.trim()) return { status: "none", why: "no safe search to run" };

  const byAuthor = new Map<string, MoPost>();
  for (const query of queries) for (const p of await deps.search(query).catch(() => [] as MoPost[])) if (!byAuthor.has(p.author.id)) byAuthor.set(p.author.id, p);
  const posts = [...byAuthor.values()].filter((p) => inCity(p.author.location, p.text)).slice(0, 25);
  const judged = await deps.judge(ask, person, posts).catch(() => [] as Judged[]);

  const found: Found[] = [];
  for (const j of judged) {
    if (found.length >= MEMBER_MO.perBatch) break;
    const p = posts[j.index];
    if (!p || !j.fit) continue;
    if (!quoteIsTheirs(j.quote, p.text)) continue;
    if (!placeOk(p.author.location, j.inCity)) continue;
    if (await deps.alreadyKnown(suppressionKeys({ x_user_id: p.author.id }), p.author.id)) continue;
    found.push({ xUserId: p.author.id, handle: p.author.username, name: p.author.name, source: "x", postText: p.text, quote: j.quote, why: neutralPronouns(j.why) });
  }
  if (!found.length) return { status: "none", why: "nobody backed by their own words" };
  const batchId = await storeBatch(userId, ask, plan.need, found, now);
  return batchId ? { status: "stored", batchId, found: found.length } : { status: "none" };
}

// ---------------------------------------------------------------- the real steps

export async function realOpenAsks(userId: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  const intent = Array.isArray(rows[0]?.intent) ? rows[0].intent : [];
  return intent
    .filter((i: any) => i?.type === "seeking" && typeof i?.text === "string" && !i?.resolved_at && i?.status !== "resolved")
    .map((i: any) => String(i.text))
    .reverse();
}

export async function realIsHuntable(ask: string): Promise<boolean> {
  const { text } = await generateText({
    model: anthropic(MODELS.haiku),
    experimental_telemetry: { isEnabled: true, functionId: "mo.member.huntable", recordInputs: false, recordOutputs: false },
    prompt: `Is this a request for a specific kind of person who could be found publicly online and approached (a designer, an investor, a cofounder, a host, a lawyer)? Advice, feelings, events, places or general goals are NOT. Answer one word: yes or no.\n\n"${ask.slice(0, 300)}"`,
  });
  return /^yes/i.test(text.trim());
}

export async function realPlan(ask: string, person: string): Promise<Plan> {
  const { text } = await generateText({
    model: anthropic(MODELS.haiku),
    experimental_telemetry: { isEnabled: true, functionId: "mo.member.plan", recordInputs: false, recordOutputs: false },
    prompt: `A member of a private club in ${MO.city} wants this: "${ask.slice(0, 300)}"\n${person ? `What the club knows about them (never put any of it in a search): ${person.slice(0, 700)}\n` : ""}
Write up to 3 X recent-search queries that find people in ${MO.city} posting about doing exactly this kind of work themselves (use X operators, e.g. ("designer" OR "design") ("SF" OR "San Francisco") ("open to" OR "taking on")). The queries describe the KIND of person in general words; never use the member's own words, their name, or anything about them.
Also write "need": a short neutral phrase for what the member needs, in 12 words or fewer, which the member will see and approve (e.g. "a product designer for an early-stage app").

Return ONLY JSON: {"queries": ["..."], "need": "..."}`,
  });
  const p = parseModelJson<{ queries?: string[]; need?: string }>(text);
  return { queries: (p.queries ?? []).filter((q) => typeof q === "string"), need: String(p.need ?? "").replace(/[—–!]/g, "").slice(0, 120) };
}

export async function realJudge(ask: string, person: string, posts: MoPost[]): Promise<Judged[]> {
  if (!posts.length) return [];
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    providerOptions: { anthropic: { effort: "low" } },
    experimental_telemetry: { isEnabled: true, functionId: "mo.member.judge", recordInputs: false, recordOutputs: false },
    prompt: `A member of Co, a private club in ${MO.city}, needs: "${ask.slice(0, 300)}"
${person ? `Context on the member (do not repeat any of it): ${person.slice(0, 500)}\n` : ""}
Posts (one per person):
${posts.map((p, i) => `[${i}] @${p.author.username} (${p.author.name}; location: ${p.author.location ?? "none"}; bio: ${(p.author.description ?? "").slice(0, 160)})\n${p.text.slice(0, 500)}`).join("\n\n")}

Keep only people whose own post shows they do this kind of work or are open to it, and who would plausibly take the call: not promoters, recruiters, bots, agencies pitching, or generic advice threads. For each kept person return "why": one plain sentence (under 22 words) saying what they said that fits, in your own words, naming no member and never saying what the member wants; "quote": 4 or more consecutive words COPIED from their post; "inCity".

Return ONLY JSON: {"people": [{"index": 0, "fit": true, "why": "...", "quote": "...", "inCity": true}]}`,
  });
  return (parseModelJson<{ people?: Judged[] }>(text).people ?? []).filter((j) => j && typeof j.index === "number" && typeof j.why === "string");
}

export async function realMemberNames(): Promise<string[]> {
  const { rows } = await pool.query(`SELECT first_name, last_name FROM users WHERE archived_at IS NULL`).catch(() => ({ rows: [] as any[] }));
  return rows.flatMap((r: any) => [r.first_name, r.last_name]).filter((n: any) => typeof n === "string" && n.trim().length >= 3).map((n: string) => n.trim().toLowerCase());
}

export async function realAllAsks(): Promise<string[]> {
  const { rows } = await pool.query(`SELECT ask_text FROM ask_checkins WHERE resolved_at IS NULL AND created_at > NOW() - INTERVAL '90 days' LIMIT 500`).catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => String(r.ask_text));
}

export async function realAlreadyKnown(keys: string[], xUserId: string | null): Promise<boolean> {
  const [supp, a, b] = await Promise.all([
    keys.length ? pool.query(`SELECT 1 FROM mo_suppression WHERE key = ANY($1::text[]) LIMIT 1`, [keys]) : Promise.resolve({ rows: [] as any[] }),
    pool.query(`SELECT 1 FROM mo_prospects WHERE x_user_id IS NOT NULL AND x_user_id = $1 LIMIT 1`, [xUserId]).catch(() => ({ rows: [] as any[] })),
    pool.query(`SELECT 1 FROM mo_member_candidates WHERE x_user_id IS NOT NULL AND x_user_id = $1 AND created_at > NOW() - make_interval(days => $2) LIMIT 1`, [xUserId, MEMBER_MO.strangerGapDays]).catch(() => ({ rows: [] as any[] })),
  ]);
  return Boolean(supp.rows[0] || a.rows[0] || b.rows[0]);
}

export async function realHuntDeps(): Promise<HuntDeps> {
  const { personModel } = await import("../services/personModel.js");
  const { reserveXSearch } = await import("../services/tieredRecommendation.js");
  return {
    now: () => new Date(),
    openAsks: realOpenAsks,
    isHuntable: realIsHuntable,
    personModel: (u) => personModel(u),
    plan: realPlan,
    memberNames: realMemberNames,
    allAsks: realAllAsks,
    search: async (query) => {
      const budget = await reserveXSearch(null, "sweep", `mo member: ${query}`);
      if (!budget.ok) return [];
      return searchPostsWithAuthors(query, 25);
    },
    judge: realJudge,
    alreadyKnown: realAlreadyKnown,
  };
}
