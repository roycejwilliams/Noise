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
export const TEAM_BUILDER_LINE = "They are on the CoPatible team that builds you, Co (a co-founder or teammate). They know what Co is and how it works because they make it. Never pitch Co to them or present Co as something they're discovering, and never treat Co fitting what they describe as a coincidence or a revelation; when what they describe is Co, talk about it as their own work. Everything else is as with any member: their life, their goals, what you're carrying for them.";
