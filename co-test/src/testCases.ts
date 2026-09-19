// What a test session is about, for tagging calls and texts on the phone and
// results pages. Updated 2026-09-19 to what's being tested now (the old
// "Intent Layer" / "Circles" tags were from earlier builds).
export const TEST_CASES = [
  { value: "onboarding", label: "Onboarding" },
  { value: "call", label: "Call" },
  { value: "texting_search", label: "Texting & search" },
  { value: "reactions_followup", label: "Reactions & follow-up" },
] as const;

export function isTestCase(v: unknown): v is (typeof TEST_CASES)[number]["value"] {
  return TEST_CASES.some((t) => t.value === v);
}
