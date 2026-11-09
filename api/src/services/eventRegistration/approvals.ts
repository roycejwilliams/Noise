// What registering a member for another host's event waits on (Royce, 2026-11-09). Code constants, never env switches (no feature
// toggles): changing one is a reviewed commit.
//
// LUMA_LIVE_SUBMIT_APPROVED: Luma's terms (luma.com/terms) ask for "publicly supported interfaces" and don't settle automating the
// public registration page either way. Until that is clarified AND Royce approves a specific live test, nothing is submitted (and no
// sign-in is started) on a live luma.com page: the driver refuses, and only local test fixtures can be submitted.
export const LUMA_LIVE_SUBMIT_APPROVED = false as boolean;
// REGISTRATION_COPY_APPROVED: every word a member reads about a registration (services/eventRegistration/copy.ts) needs Royce's yes
// first. Until both are true, the registration tools and their capability lines don't exist for anyone: Cue neither offers nor
// mentions registering (its sheet still says it can't register them), so no prompt changes.
export const REGISTRATION_COPY_APPROVED = false as boolean;

// Tests only (never read from the environment): a layer 1 test drives the live paths with this, the way setYesJudgeForTests stands in
// for the yes read. Nothing in src sets it.
let liveForTests: boolean | null = null;
export function setRegistrationLiveForTests(v: boolean | null): void {
  liveForTests = v;
}
export const registrationLive = (o: { submit?: boolean; copy?: boolean } = {}) => liveForTests ?? ((o.submit ?? LUMA_LIVE_SUBMIT_APPROVED) && (o.copy ?? REGISTRATION_COPY_APPROVED));
