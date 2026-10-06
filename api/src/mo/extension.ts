// Mo as an extension of Co (services/extensions.ts): how Mo plugs in.
import type { ExtensionRuntime } from "../services/extensions.js";
import { runMoFind } from "./find.js";
import { consultMo, handleMoReply, sendMoDigest } from "./review.js";
import { moEnabled, runMoInbox, runMoOutreach } from "./outreach.js";
import { moHandoff } from "./handoff.js";
import { runMemberHunts, runMemberOffers, runMemberOutreach } from "./memberJobs.js";

const PT = "America/Los_Angeles";

export const moRuntime: ExtensionRuntime = {
  // Off unless MO_ENABLED=true. Sending also waits on Co's X keys and the
  // outreach email settings; without them it's shortlist-only.
  enabled: () => moEnabled(),
  teamText: (userId, text, opts) => handleMoReply(userId, text, opts),
  consult: (userId, question) => consultMo(userId, question),
  handoff: moHandoff,
  jobs: [
    // Finds people weekly, Monday 9am Pacific.
    { name: "mo find", cron: "0 9 * * 1", timezone: PT, run: runMoFind },
    // Brings approvers the next person, daily.
    { name: "mo digest", cron: "30 9 * * *", timezone: PT, run: sendMoDigest },
    // Acts on approved prospects (hourly; daytime is checked inside).
    { name: "mo outreach", cron: "20 * * * *", run: () => runMoOutreach() },
    // Replies in Co's X DMs.
    { name: "mo inbox", cron: "7,22,37,52 * * * *", run: runMoInbox },
    // Member-facing Mo (mo/memberJobs.ts): each is a no-op unless MO_MEMBER_ENABLED=true as well.
    { name: "mo member offers", cron: "15 10 * * *", timezone: PT, run: runMemberOffers },
    { name: "mo member hunts", cron: "0 10 * * 1", timezone: PT, run: runMemberHunts },
    { name: "mo member outreach", cron: "40 * * * *", run: runMemberOutreach },
  ],
};
