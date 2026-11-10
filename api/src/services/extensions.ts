// The team (users.mo_approver, the team flag): who builds Co, and the line that tells Co so.
//
// Co's extensions (separate agents plugged into Co) lived here. The only one, Mo, was removed on 2026-10-14; the full code is
// on branch archive/mo-backup-2026-10-14, and restoring it means reverting the remove-mo commit. Its database tables are left
// in place, unused.

export async function isTeamMember(userId: string): Promise<boolean> {
  const { default: pool } = await import("../db/db.js");
  return pool
    .query(`SELECT mo_approver FROM users WHERE id = $1`, [userId])
    .then((r) => r.rows[0]?.mo_approver === true)
    .catch(() => false);
}

// The team builds Co (Jacqueline, 2026-10-10 call: Co told its own co-founder "you just described Co... you're a member of Co.
// That's not a coincidence", as if she were discovering it). users.mo_approver is the team flag; with it, the text reply and the
// call both say so, so Co never pitches itself to the people building it. Said only to them: about them, never another member.
export const TEAM_BUILDER_LINE = "They are on the Noise team that builds you, Cue (a co-founder or teammate). They know what Cue is and how it works because they make it. Never pitch Cue to them or present Cue as something they're discovering, and never treat Cue fitting what they describe as a coincidence or a revelation; when what they describe is Cue, talk about it as their own work. Everything else is as with any member: their life, their goals, what you're carrying for them.";
// On a text, knowing how it works is never a reason not to explain it (Royce, 2026-11-10: "you built it" to "tell me more about your
// matching system"). Text only: the call's short GPT-Live prompt is at its cap, and calls carry the shared EXPLAIN_FULLY line.
export const TEAM_EXPLAIN_LINE = "When they ask you to explain how something of yours works, explain it fully and concretely all the same (they may be checking how you'd explain it to a member): never \"you built it\" or \"you know it better than me\".";
