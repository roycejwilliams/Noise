// The browser drivers a registration can run through, one per platform (Royce, 2026-11-09: Luma first; others plug in later as their
// own drivers, never as branches inside Luma's). Each driver opens a platform's own public registration page in a real browser,
// reads the whole form without submitting, fills only what the plan says, submits once when allowed, and reads what the page said.
// Only Luma exists today (lumaDriver.ts). An Eventbrite or Partiful driver would implement RegistrationDriver and be added to DRIVERS;
// nothing else changes (the plan, the record, the tools and the copy are platform-neutral).
import type { FormRead, Outcome } from "./registration.js";

// What one open page can do. A session is one fresh browser context for one member and one event: no cookies from anyone else, no
// shared Cue identity, closed when done. Held between turns only while it waits on the member (their emailed code), in memory only.
export type RegistrationSession = {
  // Read the whole form as it stands now (the register form opened; nothing submitted).
  read(): Promise<FormRead>;
  // Start the platform's own sign-in for their chosen email (Luma: it emails them a code). Never a password.
  startSignIn(email: string): Promise<{ ok: true; waitingFor: "code" | "member_step" } | { ok: false; detail: string }>;
  // Enter the code they received, once. Never stored, logged or returned.
  enterCode(code: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  // Fill the planned values (by field id) and tick the boxes they agreed to; every other box stays as the page left it (unticked).
  fill(values: Record<string, string>, agreed: string[]): Promise<{ ok: true } | { ok: false; detail: string }>;
  // Submit once and read the page's answer. Refused unless live submission is approved or the page is a test fixture.
  submit(): Promise<SubmitRead>;
  // Read the page's current state again without submitting (a reconcile read).
  readResult(): Promise<SubmitRead>;
  // The page's visible text, as it stands (read only).
  pageText(): Promise<string>;
  close(): Promise<void>;
};

export type SubmitRead = { state: Outcome["state"] | "unknown" | "needs_code"; detail: string | null; link: string | null; linkKind: Outcome["linkKind"] };

export type RegistrationDriver = {
  platform: "luma";
  // Whether a link is this platform's public event page.
  handles(url: string): boolean;
  open(url: string): Promise<RegistrationSession>;
};

export async function driverFor(url: string, drivers?: RegistrationDriver[]): Promise<RegistrationDriver | null> {
  const list = drivers ?? [(await import("./lumaDriver.js")).lumaDriver()];
  return list.find((d) => d.handles(url)) ?? null;
}
