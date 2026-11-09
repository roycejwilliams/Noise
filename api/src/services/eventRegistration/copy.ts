// Every word a member reads about a registration (Royce, 2026-11-09). Fixed copy, sent as written: it needs Royce's yes before any
// of it reaches a member (REGISTRATION_COPY_APPROVED in approvals.ts; until then the tools that send it don't exist). No exclamation
// points, no em dashes; composed, warm, short. The only words of Cue's own in an ask are its one "why it fits" line, checked against
// the event's own public page and the find's checked facts (fitProblem).
//
// Two approvals, never one for the other: answersAsk asks for missing details and shows drafts ("Does the draft work?"); a yes to it
// saves answers and never submits. submitAsk asks the one question that authorizes the submit: "Want me to register you for this event
// using these details and answers?" A message may carry a draft inside the submit question (it then clearly asks to register with it).
import { firstWordName } from "../offerGuard.js";
import { type Blocker, type FieldKind, type Plan, type Scope } from "./registration.js";

export type Ctx = { eventName: string; when: string | null; email: string; link: string };

const ev = (c: Ctx) => c.eventName.trim() || "the event";
const q = (s: string) => `"${s.replace(/\s+/g, " ").trim()}"`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// How a needed detail is named in an ask.
const NEED: Partial<Record<FieldKind, string>> = {
  name: "your full name", first_name: "your first name", last_name: "your last name", email: "the email you'd like to use", phone: "your phone number",
  company: "your company", job_title: "your role", city: "your city", linkedin: "your LinkedIn", website: "your website", social: "your handle",
};
export function needPhrase(m: { label: string; kind: FieldKind; options?: string[] }): string {
  return NEED[m.kind] ?? `an answer to ${q(m.label)}${m.options?.length ? ` (${clip(m.options.join(", "), 120)})` : ""}`;
}

// What a value on the form is called in the submit ask ("your company (Northwind)").
const SHARE: Partial<Record<FieldKind, string>> = { name: "name", first_name: "first name", last_name: "last name", email: "email", phone: "phone number", company: "company", job_title: "role", city: "city", linkedin: "LinkedIn", website: "website", social: "handle" };

// ---------------------------------------------------------------- the asks

// A missing detail or a draft to approve. Never authorizes the submit.
export function answersAsk(c: Ctx, plan: Plan, fit: string | null): string {
  const needs = [...plan.missing.map(needPhrase), ...plan.open.map((o) => `a short answer to ${q(o.label)}`)];
  const drafts = plan.open.filter((o) => o.draft);
  const out = [`${fit ? `${fit.trim()} ` : ""}I can handle the signup for ${ev(c)}. They also need ${list(needs)}.`];
  for (const d of drafts) out.push(`Here's a draft for ${q(d.label)}: ${q(d.draft!.text)}`);
  const missing = plan.missing.map(needPhrase);
  const undrafted = plan.open.filter((o) => !o.draft).map((o) => q(o.label));
  const asks = [...missing, ...undrafted.map((l) => `your answer to ${l}`)];
  if (drafts.length && asks.length) out.push(`Does the draft work, and what should I put for ${list(asks)}?`);
  else if (drafts.length) out.push("Does the draft work?");
  else out.push(`What should I put for ${list(asks)}?`);
  return out.join(" ");
}

// The one question whose yes authorizes the submit. Names the event, the time, that it's free (and approval or waitlist), every value
// that goes on the form, every term they'd agree to, and that marketing boxes stay unticked.
export function submitAsk(c: Ctx, plan: Plan, scope: Scope, fit: string | null, lead: string | null = null): string {
  const when = c.when ? ` is on ${c.when}` : "";
  const status = plan.expect === "pending_approval" ? `${ev(c)}${when}. It's free, and the host approves each guest.` : plan.expect === "waitlisted" ? `${ev(c)}${when}. It's free but full, so this would add you to the waitlist.` : `${ev(c)}${when}, and it's free.`;
  // Their details by name ("your company (Northwind)"); every other answer by the form's own question.
  const details = plan.fill.filter((f) => SHARE[f.kind]).map((f) => `your ${SHARE[f.kind]} (${f.value})`);
  const answers = plan.fill.filter((f) => !SHARE[f.kind]).map((f) => `${q(f.label)}: ${q(f.value)}`);
  const out: string[] = [];
  if (lead) out.push(lead.trim());
  if (fit) out.push(fit.trim());
  out.push(status);
  out.push(`I'd use ${list(details)}${answers.length ? `, with ${answers.length === 1 ? "this answer" : "these answers"}: ${answers.join("; ")}` : ""}.`);
  if (plan.attestations.length) out.push(`Registering also means agreeing to ${plan.attestations.length === 1 ? "their terms" : "these terms"}: ${plan.attestations.map((a) => q(clip(a.termsText || a.label, 300))).join("; ")}.`);
  if (plan.leftBlank.some((l) => l.why === "marketing")) out.push("I'll leave their mailing-list boxes unchecked.");
  out.push(`Want me to register you for this event using these details${answers.length ? " and answers" : ""}${plan.attestations.length ? `, and agree to ${plan.attestations.length === 1 ? "those terms" : "these terms"}` : ""}?`);
  void scope;
  return out.join(" ");
}

// The sentence of the submit ask its yes answers: it must be in what Cue actually sent before a yes can authorize anything.
export const SUBMIT_QUESTION = /Want me to register you for this event using these details/;

// The page changed since they were asked.
export const changedLead = (changes: string[]) => `Before I submit: the page changed since I asked (${list(changes)}).`;
// A sign-in or a later step showed more questions.
export const revealedLead = (n: number) => (n === 1 ? "Signing in showed one more question." : "Signing in showed a few more questions.");

// ---------------------------------------------------------------- sign-in and codes

export const codeAsk = (c: Ctx, when: "sign_in" | "after_submit") =>
  when === "sign_in"
    ? `Luma sent a sign-in code to ${c.email}. What's the code? I'll use it once and won't keep it.`
    : `Luma sent a code to ${c.email} to confirm the signup. What's the code? I'll use it once and won't keep it.`;
export const codeAgain = "That code didn't go through. Could you check the latest email from Luma and send the code again?";
export const memberStepAsk = () => "Luma wants you to confirm from your email before the signup goes through. Tell me once you have, and I'll check the page.";
export const sessionExpired = (c: Ctx, submitted: boolean) =>
  submitted
    ? `The page timed out before I could enter the code, so the signup for ${ev(c)} isn't confirmed. Here's the page:\n${c.link}`
    : `The signup page timed out while I waited for the code, so nothing was submitted. Want me to start it again? Luma will send a new code.`;

// ---------------------------------------------------------------- outcomes

export function outcomeLine(c: Ctx, state: "registered" | "pending_approval" | "waitlisted" | "already_registered" | "failed" | "uncertain", o: { detail?: string | null; link?: string | null; confirmation?: boolean } = {}): string {
  const link = o.link ?? c.link;
  const at = c.when ? `, ${c.when}` : "";
  switch (state) {
    case "registered":
      return `You're registered for ${ev(c)}${at}. Luma's confirmation goes to ${c.email}.\n${link}`;
    case "pending_approval":
      // Royce, 2026-11-09: never "Done" for a request the host still has to approve.
      return `Submitted, pending approval. The host reviews each request for ${ev(c)}, so you're not confirmed yet; Luma emails ${c.email} when they decide.\n${link}`;
    case "waitlisted":
      return `You're on the waitlist for ${ev(c)}, not confirmed yet. If a spot opens, Luma will email ${c.email}.\n${link}`;
    case "already_registered":
      return `You're already registered for ${ev(c)} with ${c.email}, so I didn't sign you up again.\n${link}`;
    case "failed":
      return `The signup for ${ev(c)} didn't go through${o.detail ? `: the page said ${q(clip(o.detail, 140))}` : ""}. Nothing is confirmed. Here's the page if you'd like to try it yourself:\n${link}`;
    case "uncertain":
      return `I submitted the signup for ${ev(c)}, but the page didn't confirm it, so I can't say you're in. A confirmation from Luma at ${c.email} would settle it. I won't submit again unless you want me to.\n${link}`;
  }
}

// Before any retry: Luma's own page is read signed in as them, so it needs the code Luma emails them.
export const reconcileCodeAsk = (c: Ctx) => `Before I try again, I'll check with Luma whether the first one went through. Luma sent a sign-in code to ${c.email}. What's the code? I'll use it once and won't keep it.`;
// The reconcile couldn't tell: nothing is sent again.
export const cannotConfirm = (c: Ctx) => `I couldn't confirm whether the signup for ${ev(c)} went through, so I won't submit it again. Luma's confirmation email to ${c.email}, or the event page when you're signed in, will show it.\n${c.link}`;
export const retryAsk = (c: Ctx) => `Still nothing confirming ${ev(c)}. Want me to submit it once more? If the first one went through, Luma should say you're already registered.`;

// ---------------------------------------------------------------- stops

export function blockerLine(c: Ctx, b: Blocker): string {
  switch (b.kind) {
    case "paid":
      return `${ev(c)} isn't free (${b.detail}), and paid signups aren't something I do. Here's the page:\n${c.link}`;
    case "price_unclear":
      return `I can't tell from the page whether ${ev(c)} costs anything, so I stopped there. Here's the page:\n${c.link}`;
    case "login":
      return `${ev(c)} wants a sign-in I can't do for you, so I stopped there. Here's the page:\n${c.link}`;
    case "verification":
      return `Luma wants a confirmation step I can't finish for you, so I stopped there. Here's the page:\n${c.link}`;
    case "captcha":
      return `The page for ${ev(c)} put up a bot check, and I don't get around those. Here's the page to sign up yourself:\n${c.link}`;
    case "closed":
      return `Registration for ${ev(c)} is closed.\n${c.link}`;
    case "full":
      return `${ev(c)} is full, with no waitlist.\n${c.link}`;
    case "ticket_choice":
      return `${ev(c)} has more than one ticket type, and I only handle a single free ticket for now. Here's the page:\n${c.link}`;
    case "unsupported":
      return `The form for ${ev(c)} asks for something I can't fill in (${b.detail.replace(/^the form asks for something Cue can't fill in /, "")}). Here's the page:\n${c.link}`;
    case "unreadable":
      return `I couldn't read the signup form for ${ev(c)}, so nothing was submitted. Here's the page:\n${c.link}`;
  }
}

// ---------------------------------------------------------------- the one line of Cue's own: why it fits

// Pure: why Cue's "why it fits" line can't go in the ask, or null. Every name, number and attendee claim in it has to be on the event's
// own public page or in the find's checked facts (Royce, 2026-11-09): never a guess, never anything private about them or about any other
// member (no cross-member leaks). The member's own reasons belong in their own words elsewhere, not in a sales line.
export function fitProblem(fit: string, verified: string): string | null {
  const t = fit.replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length > 220) return "keep the fit to one short sentence";
  if (/[!—–]/.test(t)) return "no exclamation points or em dashes";
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const hay = norm(verified);
  const NUM_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|dozen|dozens|hundreds?|several|a few|many|most)\b/i;
  for (const n of t.match(/\d[\d,.]*/g) ?? []) if (!hay.includes(` ${n.replace(/[,.]$/, "").toLowerCase()}`)) return `the fit says ${n}, which the event page doesn't`;
  if (/\b(attendees?|guests?|people (?:going|attending|coming)|who'?s going|going are|founders going|members? (?:going|attending))\b/i.test(t)) {
    if (!/\b(guests?|attendees?|going|registered)\b/i.test(verified)) return "the fit makes a claim about who's going that the event page doesn't back";
    const m = t.match(NUM_WORDS);
    if (m && !hay.includes(` ${m[0].toLowerCase()} `)) return `the fit says ${m[0]} about who's going, which the event page doesn't`;
  }
  const words = t.split(/\s+/);
  // The first word too, when it reads as a name there (offerGuard.ts firstWordName: "Maya from your last dinner...").
  const lead = firstWordName(words);
  if (lead && !hay.includes(` ${lead.toLowerCase()} `)) return `the fit names "${lead}", which the event page and the find don't`;
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/^[("'“]+|[)"'”.,;:!?]+$/g, "").replace(/'s$/i, "");
    if (/^[A-Z][A-Za-z0-9'&-]+$/.test(w) && !hay.includes(` ${w.toLowerCase()} `) && !/^(I|I'm|I'd|I'll|Luma|You|Your)$/.test(w)) return `the fit names "${w}", which the event page and the find don't`;
  }
  return null;
}
