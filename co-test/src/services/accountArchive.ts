// Moved to api/src/services/accountArchive.ts (2026-09-22) so the membership
// lapse job can use it in every environment; kept here as a re-export so the
// tester reset (testerAuth.ts) is unchanged.
export { archiveAccount } from "../../../api/src/services/accountArchive.js";
