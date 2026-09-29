// Co's extensions (Royce, 2026-09-26: "How can it be adaptable as an
// extension?"). An extension is a separate agent that works for Co with its
// own voice and its own abilities, and plugs into Co at the same few points:
//
//   abilities + limits  one registry on Co's frame (services/capabilities.ts
//                       Ability), so agent/toolGuard.ts guards its tools the
//                       same way it guards Co's: switches, limits, yes, log
//   voice               one file that defines who it is
//   teamText            reads a teammate's text when it's for the extension
//                       (routes/sendblue.ts), before Co answers
//   handoff             what Co should know, for a member the extension
//                       brought in, in Co's first conversations with them
//                       (harness/replyGrounding.ts gatherReplyFacts)
//   jobs                its schedule (jobs/index.ts), only while enabled
//
// Mo is the first. A new one adds an entry here and those pieces; nothing
// else in Co changes. Members never hear an extension's name from Co.
import type { Ability } from "./capabilities.js";
import { MO_ABILITIES, MO_LIMITS } from "../mo/abilities.js";

// coNote: Co's private note when it tags the teammate in. Context only, never
// an instruction; what the teammate does comes from the member's own words.
// ack: reacts to their message with an emoji (a tapback) when the teammate acts.
export type TeamTextOpts = { repliedTo?: string | null; handedOff?: boolean; coNote?: string | null; ack?: (emoji: string) => Promise<unknown> };

// A quiet question from Co to a teammate (Royce, 2026-09-28): the teammate
// looks things up, never acts and never texts the member; Co answers in its
// own voice from the facts it gets back.
export type ConsultResult = { facts: string[]; note: string };

export type ExtensionJob = { name: string; cron: string; timezone?: string; run: () => Promise<unknown> };

export type ExtensionRuntime = {
  // Whether its scheduled work runs. Team texts and handoffs don't wait on
  // it: someone mid-conversation, or already brought in, is still looked after.
  enabled: () => boolean;
  // opts.repliedTo: the extension's own text they pressed Reply on, so the
  // text is theirs whatever it says. opts.handedOff: Co passed it over.
  teamText?: (userId: string, text: string, opts?: TeamTextOpts) => Promise<string | null>;
  // `known`: plain facts Co may state; `instruction`: what Co may only ask
  // about, never state.
  handoff?: (userId: string) => Promise<{ known: string[]; instruction: string } | null>;
  consult?: (userId: string, question: string) => Promise<ConsultResult | null>;
  jobs?: ExtensionJob[];
};

export type CoExtension = {
  id: string;
  name: string;
  // What it does for Co, in a line.
  about: string;
  voiceFile: string;
  abilities: Ability[];
  limits: string[];
  // Loaded lazily: an extension's code pulls in a lot, and Co's reply path
  // only needs it for the few members and teammates it touches.
  load: () => Promise<ExtensionRuntime>;
};

export const EXTENSIONS: CoExtension[] = [
  {
    id: "mo",
    name: "Mo",
    about: "Extends invitations to Co: finds people who belong, brings each one to the team, and invites them on a yes.",
    voiceFile: "mo/moVoice.ts",
    abilities: MO_ABILITIES,
    limits: MO_LIMITS,
    load: () => import("../mo/extension.js").then((m) => m.moRuntime),
  },
];

// A teammate's text, offered to each extension in turn. Null when none of
// them take it, and Co answers as usual.
export async function handleTeamText(userId: string, text: string, opts: TeamTextOpts & { only?: string } = {}): Promise<{ extension: string; reply: string } | null> {
  for (const e of EXTENSIONS) {
    if (opts.only && e.id !== opts.only) continue;
    const rt = await e.load().catch(() => null);
    if (!rt?.teamText) continue;
    const reply = await rt.teamText(userId, text, opts).catch((err: any) => {
      console.error(`extensions: ${e.id} team text failed:`, err?.message ?? err);
      return null;
    });
    if (reply !== null) return { extension: e.id, reply };
  }
  return null;
}

// What Co should know about a member an extension brought in: a few plain
// facts it may state (how they got in), and an instruction for the rest,
// which is never citable because none of it is something they told Co.
export async function consultTeammate(userId: string, question: string): Promise<{ extension: string; result: ConsultResult } | null> {
  for (const e of EXTENSIONS) {
    const rt = await e.load().catch(() => null);
    if (!rt?.consult) continue;
    const result = await rt.consult(userId, question).catch((err: any) => {
      console.error(`extensions: ${e.id} consult failed:`, err?.message ?? err);
      return null;
    });
    if (result) return { extension: e.id, result };
  }
  return null;
}

export async function handoffFor(userId: string): Promise<{ known: string[]; instructions: string[] }> {
  const out = { known: [] as string[], instructions: [] as string[] };
  for (const e of EXTENSIONS) {
    const rt = await e.load().catch(() => null);
    const h = rt?.handoff ? await rt.handoff(userId).catch(() => null) : null;
    if (!h) continue;
    out.known.push(...h.known);
    out.instructions.push(h.instruction);
  }
  return out;
}

export async function extensionJobs(): Promise<(ExtensionJob & { extension: string })[]> {
  const out: (ExtensionJob & { extension: string })[] = [];
  for (const e of EXTENSIONS) {
    const rt = await e.load().catch(() => null);
    if (!rt?.enabled()) continue;
    for (const j of rt.jobs ?? []) out.push({ ...j, extension: e.id });
  }
  return out;
}

// ------------------------------------------------------------ the team only
// Members never hear an extension's name from Co. The team does (Royce,
// 2026-09-28: Co pitched "I'll draft sponsor emails and you approve them" as
// a new idea to Royce, when that's what Mo already does). Gated in code: only
// for users.mo_approver.

export async function isTeamMember(userId: string): Promise<boolean> {
  const { default: pool } = await import("../db/db.js");
  return pool
    .query(`SELECT mo_approver FROM users WHERE id = $1`, [userId])
    .then((r) => r.rows[0]?.mo_approver === true)
    .catch(() => false);
}

// What Co knows about its teammates, as capability facts, for the team only.
export function teamSheet(): string[] {
  return EXTENSIONS.flatMap((e) => [
    `${e.name} is Co's teammate (an AI agent that works alongside Co, not a person: never a cofounder, and never someone in a member's own life), on this same number, known to the team only (never mention ${e.name} to anyone else). ${e.about} What ${e.name} does: ${e.abilities.map((a) => a.can).join(" ")}`,
    `${e.name}'s limits: ${e.limits.join(" ")}`,
    `So with the team, don't pitch what ${e.name} already does as a new idea: say ${e.name} already does it. Before you tell them you don't have something about ${e.name}'s work (the people it found, who's waiting, what it's doing), ask ${e.name} first: it usually has it. Two ways to work with ${e.name}. When you just need information from ${e.name} to answer them (who's in the queue, where someone stands), ask quietly with askTeammate and answer in your own voice; they never see the back-and-forth. When they want ${e.name} itself to act or talk to them (approvals, pausing, "tell ${e.name}…"), tag it in with handToTeammate: a bare @${e.name} in the thread, then ${e.name} answers them directly and you step back. They can call ${e.name} in themselves by writing @${e.name}, or by replying to one of ${e.name}'s texts; just mentioning ${e.name} leaves it with you.`,
  ]);
}

// Which extension, if any, sent one of Co's outbound messages (by its
// handle). Only this member's messages.
export async function extensionForMessage(userId: string, handle: unknown): Promise<{ id: string; content: string } | null> {
  if (typeof handle !== "string" || !handle) return null;
  const { default: pool } = await import("../db/db.js");
  const { rows } = await pool
    .query(`SELECT sender, content FROM outbound_messages WHERE message_handle = $1 AND user_id = $2`, [handle, userId])
    .catch(() => ({ rows: [] as any[] }));
  const r = rows[0];
  if (!r) return null;
  if (r.sender && r.sender !== "co" && EXTENSIONS.some((e) => e.id === r.sender)) return { id: r.sender, content: String(r.content ?? "") };
  const id = extensionByOpener(String(r.content ?? ""));
  return id ? { id, content: String(r.content ?? "") } : null;
}

// Sent before senders were recorded: an extension's texts open with its name
// ("Hey Royce, it's Mo.").
export function extensionByOpener(content: string): string | null {
  const e = EXTENSIONS.find((x) => new RegExp(`^hey [^,]{1,40}, it['’]?s ${x.name}\\b`, "i").test(content.trim()));
  return e?.id ?? null;
}
