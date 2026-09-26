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

export type ExtensionJob = { name: string; cron: string; timezone?: string; run: () => Promise<unknown> };

export type ExtensionRuntime = {
  // Whether its scheduled work runs. Team texts and handoffs don't wait on
  // it: someone mid-conversation, or already brought in, is still looked after.
  enabled: () => boolean;
  teamText?: (userId: string, text: string) => Promise<string | null>;
  // `known`: plain facts Co may state; `instruction`: what Co may only ask
  // about, never state.
  handoff?: (userId: string) => Promise<{ known: string[]; instruction: string } | null>;
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
export async function handleTeamText(userId: string, text: string): Promise<{ extension: string; reply: string } | null> {
  for (const e of EXTENSIONS) {
    const rt = await e.load().catch(() => null);
    if (!rt?.teamText) continue;
    const reply = await rt.teamText(userId, text).catch((err: any) => {
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
