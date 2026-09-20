// Pure decision behind Co telling a member their invite was used
// (routes/sendblue.ts tellInviterTheyJoined, services/invites.ts
// claimJoinNotice). Split out from the route file so the branching that
// decides what Co claims — and who it's about — can be eval-tested
// (evals/invites/rules.ts) without a database, and without pulling in the
// route file's heavy service clients (Sendblue, ElevenLabs, OpenAI), which
// construct eagerly at import time and have no place in a model-free,
// API-free eval.
export type InviteJoinedAction = "no_inviter" | "already_sent" | "inviter_unreachable" | "no_friend_name" | "sent";

export type InviteJoinedGate =
  | { attempt: false; action: Exclude<InviteJoinedAction, "sent">; userId: string | null }
  | { attempt: true; action: "sent"; userId: string; friend: string };

// Facts the caller has already gathered — this function makes no queries and
// sends nothing itself:
//   newUserId        — the person who just joined.
//   claimedInviterId — services/invites.ts claimJoinNotice's result: who to
//     notify, or null when there's nothing to send.
//   priorInviterId   — only meaningful when claimedInviterId is null: who
//     this member's invite actually came from, if the note already went out
//     earlier. claimJoinNotice's claim is one-shot and returns null either
//     way once used, so this is the only way to tell "nobody invited them"
//     apart from "already told them" in the decision log.
//   inviterReachable — the inviter's account exists, has identity captured,
//     and isn't opted out of texts.
//   friend           — the new member's first name, to name in the note.
export function decideInviteJoinedGate(input: {
  newUserId: string;
  claimedInviterId: string | null;
  priorInviterId: string | null;
  inviterReachable: boolean;
  friend: string | null;
}): InviteJoinedGate {
  if (!input.claimedInviterId) {
    return input.priorInviterId
      ? { attempt: false, action: "already_sent", userId: input.priorInviterId }
      : { attempt: false, action: "no_inviter", userId: input.newUserId };
  }
  if (!input.inviterReachable) {
    return { attempt: false, action: "inviter_unreachable", userId: input.claimedInviterId };
  }
  if (!input.friend) {
    return { attempt: false, action: "no_friend_name", userId: input.claimedInviterId };
  }
  return { attempt: true, action: "sent", userId: input.claimedInviterId, friend: input.friend };
}
