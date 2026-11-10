// What registering a member for another host's event waits on (Royce, 2026-11-09). Code constants, never env switches (no feature
// toggles): changing one is a reviewed commit.
//
// LUMA_LIVE_SUBMIT_APPROVED: submitting (and Luma's emailed-code sign-in) on a live luma.com page. Off, the driver refuses and only local
// test fixtures can be submitted. On for all members since 2026-11-09.
export const LUMA_LIVE_SUBMIT_APPROVED = true as boolean; // Royce, 2026-11-09: "No do it for everyone" (live for all members).
// REGISTRATION_COPY_APPROVED: every word a member reads about a registration (services/eventRegistration/copy.ts) needs Royce's yes
// first. Both must be true for the registration tools and their capability lines to exist (registrationLive).
// Approved by Royce, 2026-11-09 (COPY_REVIEW.md, including the eligibility line).
export const REGISTRATION_COPY_APPROVED = true as boolean;

// Tests only (never read from the environment): a layer 1 test drives the live paths with this, the way setYesJudgeForTests stands in
// for the yes read. Nothing in src sets it.
let liveForTests: boolean | null = null;
export function setRegistrationLiveForTests(v: boolean | null): void {
  liveForTests = v;
}
export const registrationLive = (o: { submit?: boolean; copy?: boolean } = {}) => liveForTests ?? ((o.submit ?? LUMA_LIVE_SUBMIT_APPROVED) && (o.copy ?? REGISTRATION_COPY_APPROVED));
