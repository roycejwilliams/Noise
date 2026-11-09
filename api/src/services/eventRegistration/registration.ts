// Registering a member for another host's Luma event, through the event's own public registration page (Royce, 2026-11-09). This
// file is the pure core: what a form asks for, what Cue fills and what goes back to the member, what their yes covers, the states a
// registration moves through, and how a lost or unclear submission is reconciled before anything is tried again. No I/O here: the
// record lives in event_registrations (registrationStore.ts), the page is read and submitted by the browser driver (lumaDriver.ts),
// and the conversation side (agent/registrationTools.ts) wires it into the reply.
//
// The rules it holds (Royce's brief, 2026-11-09, with the 11-09 form-first refinement):
//   - The whole form is read BEFORE the member is asked, so every gap is known up front and asked for once, together.
//   - Only required fields are filled, and only from what the member approved: their name and chosen email, factual details they gave
//     Cue, and answers they approved for THIS registration. Optional fields stay blank. A marketing opt-in is never checked.
//   - Factual fields (company, role, city, LinkedIn...) may come from what they told Cue. Open questions ("why do you want to attend?")
//     are drafted only from their own words and shown for approval; a tailored answer is kept for this registration only and is never
//     reused for another event without asking again. Attestations and terms need their explicit yes, named in the ask.
//   - Free only: any price, deposit, fee, donation or credit, or a price that can't be read as free, stops it.
//   - Two approvals, never one standing in for the other (Royce, 2026-11-09 corrections): approving an ANSWER ("does this draft work?")
//     saves the answer; only a yes to the explicit submit question ("Want me to register you for this event using these details and
//     answers?") authorizes the submit. One message may carry both only when it clearly asks to register with those details.
//   - Sign-in and verification are handled where they're normal and authorized: Luma's email-code sign-in for the member's own email,
//     with the code they received asked for in that moment, used once in the held browser session, and never stored or logged; or a
//     step the member completes themselves. A bot check (CAPTCHA) is never solved or bypassed: it stops, with the real link. A field
//     Cue can't fill is never a registration: it stops with a precise blocker.
//   - What a sign-in or a second page reveals is planned again: only what's newly outside their approval goes back to them, and the
//     submit question is asked again when what they'd share or agree to changed.
//   - One submission per member and event. A lost or unclear result is reconciled from the page before anything is tried again, and a
//     retry needs their yes after that.
import { createHash } from "node:crypto";

// ---------------------------------------------------------------- what a page says

// A field's kind, read from its label, its type and its autocomplete hint (lumaDriver.ts readForm; Luma's own question types,
// read from public event pages 2026-11-09: text, select, company (+ job title), url, linkedin, instagram, twitter, terms, agree-check).
export type FieldKind =
  | "name" | "first_name" | "last_name" | "email" | "phone"
  | "company" | "job_title" | "city" | "linkedin" | "website" | "social"
  | "short_text" | "open_question" | "select" | "multi_select"
  | "terms" | "attestation" | "marketing" | "yes_no" | "unknown";

export type FormField = {
  // The page's own handle for it (the input's name, else its id): how the driver finds it again to fill it.
  id: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options?: string[];
  // A terms box's own text, when the page carries it (the terms a yes agrees to).
  termsText?: string | null;
};

export type Ticket = { label: string | null; priceText: string | null };

// What stands between the page and a registration, as the page shows it.
export type PageGate = "none" | "login" | "captcha" | "verification" | "closed" | "sold_out" | "unreadable";

// One read of the public page (the driver's inspect mode: the form opened, nothing submitted).
export type FormRead = {
  url: string;
  eventName: string | null;
  when: string | null;
  // The page's register button, by what it says: Register, Request to Join (the host approves each guest), Join Waitlist.
  action: "register" | "request" | "waitlist" | "none";
  tickets: Ticket[];
  // Whatever the page says about price, verbatim, so "free" is judged on the page's own words.
  priceText: string | null;
  fields: FormField[];
  gate: PageGate;
  gateDetail?: string | null;
  // The page says this email is already registered (after a submit), or a signed-in page says so (never in a fresh session).
  alreadyRegistered?: boolean;
  // Who the event's own description says it is for, or what it requires to attend ("open to Stanford students and affiliates", "21+",
  // "invite only"), as its own sentences: put in front of the member as a fact to confirm. Cue never judges whether they qualify.
  restrictions?: string[];
  // How the page signs a guest in, when it asks: Luma's email code (the member reads it from their inbox), or anything else.
  signIn?: "email_code" | "other" | null;
  // The form continues on another step ("Next", "Continue"): what that step asks is read only after this one is filled.
  continues?: boolean;
  readAt: string;
};

// ---------------------------------------------------------------- classifying a field (pure)

const MARKETING = /\b(newsletter|subscribe|mailing list|marketing|promotional|promotions|updates? (?:from|about)|hear (?:more )?(?:about|from)|stay in (?:the )?loop|future events|keep me (?:posted|informed|updated)|admissions information|special offers|sponsor(?:s|'s)? (?:to )?contact|share my (?:info|information|details|email) with)\b/i;
const TERMS = /\b(terms|code of conduct|privacy policy|waiver|liability|release|policy)\b/i;
const ATTEST = /\b(i agree|agree to|i consent|consent to|i acknowledge|acknowledge|i understand|i confirm|confirm that|i certify|certify|attest|i am (?:over|at least|a |an )|i'?m (?:over|at least)|by (?:registering|checking))\b/i;
const OPEN = /\b(why|what (?:do you hope|are you hoping|brings you|would you like to|draws you|interests you)|tell us|describe|share (?:a bit|more|about)|reason|motivat|interest(?:ed)? in attending|what do you want to get|goals? for)\b/i;

// Pure: a field's kind from what the page shows of it.
export function classifyField(f: { label: string; type?: string | null; autocomplete?: string | null; name?: string | null; options?: string[] | null; multiple?: boolean; required?: boolean }): FieldKind {
  const label = String(f.label ?? "").replace(/\s+/g, " ").trim();
  const type = String(f.type ?? "").toLowerCase();
  const auto = String(f.autocomplete ?? "").toLowerCase();
  const name = String(f.name ?? "").toLowerCase();
  if (type === "checkbox") {
    // A box that would send them mail is marketing, required or not; a required one is still never ticked silently (planFill).
    if (MARKETING.test(label)) return "marketing";
    if (TERMS.test(label) || ATTEST.test(label)) return TERMS.test(label) ? "terms" : "attestation";
    return "yes_no";
  }
  if (type === "email" || auto === "email" || name === "email") return "email";
  if (name === "name" || auto === "name") return "name";
  if (auto === "given-name" || /^first[ _-]?name$/i.test(label)) return "first_name";
  if (auto === "family-name" || /^last[ _-]?name$/i.test(label)) return "last_name";
  if (type === "tel" || auto === "tel" || /\bphone\b/i.test(label)) return "phone";
  // The page's own hints first: Luma's company question carries a job title input whose label also says "company".
  if (auto === "organization-title" || /\.job_title$/.test(name)) return "job_title";
  if (auto === "organization" || /\.company$/.test(name) || /\b(company|organi[sz]ation|employer|startup|where do you work)\b/i.test(label) && !/\burl|website|link\b/i.test(label)) return "company";
  if (auto === "organization-title" || /\.job_title$/.test(name) || /\b(job title|title|role|position)\b/i.test(label) && !OPEN.test(label)) return "job_title";
  if (/linkedin/i.test(label)) return "linkedin";
  if (/\b(instagram|twitter|x handle|tiktok|github)\b/i.test(label)) return "social";
  if (type === "url" || /\b(url|website|portfolio)\b/i.test(label)) return "website";
  if (/\b(city|based in|where are you (?:based|located)|location)\b/i.test(label)) return "city";
  if (f.options?.length) return f.multiple ? "multi_select" : "select";
  if (MARKETING.test(label) && !f.required) return "marketing";
  if (OPEN.test(label) || type === "textarea") return "open_question";
  if (type === "text" || type === "" || type === "textarea") return "short_text";
  return "unknown";
}

// ---------------------------------------------------------------- free only (pure)

// Pure: whether the page's price words say free, and nothing that costs anything. Null when it can't be told (then it stops: an
// uncertain term is surfaced, never assumed away).
export function freeOnly(priceText: string | null | undefined, tickets: Ticket[] = []): { free: boolean | null; why: string } {
  const words = [priceText ?? "", ...tickets.map((t) => `${t.label ?? ""} ${t.priceText ?? ""}`)].join(" ").replace(/\s+/g, " ").trim();
  if (!words) return { free: null, why: "the page doesn't say what it costs" };
  const money = words.match(/(?:[$€£¥]|usd|eur|gbp)\s?\d[\d,.]*|\d[\d,.]*\s?(?:usd|eur|gbp|dollars?)/gi) ?? [];
  const nonZero = money.filter((m) => Number(m.replace(/[^\d.]/g, "")) > 0);
  if (nonZero.length) return { free: false, why: `the page shows a price (${nonZero[0]})` };
  if (/\b(deposit|fee|donation|donate|pay what you|suggested|sliding scale|credits?|card (?:required|on file)|payment|paid|purchase|checkout|refundable)\b/i.test(words)) {
    return { free: false, why: `the page mentions ${words.match(/\b(deposit|fee|donation|donate|pay what you|suggested|sliding scale|credits?|card (?:required|on file)|payment|paid|purchase|checkout|refundable)\b/i)![0].toLowerCase()}` };
  }
  if (/\bfree\b|^\s*(?:[$€£]\s?0(?:\.00)?)\s*$/i.test(words) || money.length) return { free: true, why: "the page says it's free" };
  return { free: null, why: "the page doesn't say it's free" };
}

// ---------------------------------------------------------------- the member's details (pure)

// What Cue may put on a form: their name and the email they chose, and factual details they gave Cue. Each value carries where it came
// from, which the ask names.
export type FactSource = "account" | "they_said" | "earlier_signup";
export type MemberFacts = Partial<Record<"first_name" | "last_name" | "email" | "phone" | "company" | "job_title" | "city" | "linkedin" | "website", { value: string; source: FactSource }>>;

// The kinds a member's fact can fill (a tailored answer never: those are kept per registration).
export const FACTUAL_KINDS: ReadonlySet<FieldKind> = new Set(["name", "first_name", "last_name", "email", "phone", "company", "job_title", "city", "linkedin", "website"]);

// An answer approved for THIS registration, by field id: the member's own words, or a draft of Cue's they approved (as written or
// edited). Kept on the registration record only.
export type Answer = { value: string; source: "member" | "draft_approved" | "fact" };
export type Answers = Record<string, Answer>;

// A draft of Cue's for an open question, from their own words (basis: the words of theirs it rests on). Shown for approval, never sent
// on its own.
export type Draft = { fieldId: string; text: string; basis: string };

export type Blocker =
  | { kind: "paid"; detail: string }
  | { kind: "price_unclear"; detail: string }
  | { kind: "login"; detail: string }
  | { kind: "captcha"; detail: string }
  | { kind: "verification"; detail: string }
  | { kind: "closed"; detail: string }
  | { kind: "full"; detail: string }
  | { kind: "ticket_choice"; detail: string }
  | { kind: "unsupported"; detail: string }
  | { kind: "unreadable"; detail: string };

export type Fill = { fieldId: string; label: string; kind: FieldKind; value: string; source: FactSource | Answer["source"] };
export type Plan = {
  blockers: Blocker[];
  // Required fields with an approved or known value: what will be sent.
  fill: Fill[];
  // Required factual or short fields with no value: asked for, together, in one ask.
  missing: { fieldId: string; label: string; kind: FieldKind; options?: string[] }[];
  // Required open questions with no approved answer: Cue drafts from their words, they approve.
  open: { fieldId: string; label: string; draft: Draft | null }[];
  // Required boxes that agree to terms or attest something: each needs their explicit yes, named in the ask.
  attestations: { fieldId: string; label: string; termsText: string | null }[];
  // Left blank or unticked on purpose: optional fields, and every marketing box.
  leftBlank: { fieldId: string; label: string; why: "optional" | "marketing" }[];
  // What a submit is expected to get: in, a request the host approves, or the waitlist.
  expect: "registered" | "pending_approval" | "waitlisted";
  ticket: Ticket | null;
  // The page wants a sign-in or an emailed code first: Cue enters their chosen email and asks them for the code (needs_member_code).
  signIn: boolean;
};

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

// Pure: the value a factual field takes from their details. A full name is first + last; a name field with only a first name is
// missing (a guess at a surname is never made).
export function factFor(kind: FieldKind, facts: MemberFacts): { value: string; source: FactSource } | null {
  if (kind === "name") {
    const f = facts.first_name, l = facts.last_name;
    if (!f?.value?.trim() || !l?.value?.trim()) return null;
    return { value: clean(`${f.value} ${l.value}`), source: f.source === "account" && l.source === "account" ? "account" : "they_said" };
  }
  const k = kind as keyof MemberFacts;
  const v = facts[k];
  return v?.value?.trim() ? { value: clean(v.value), source: v.source } : null;
}

// Pure: the plan for one form: what is filled from what, what's missing, what needs a draft, what needs an explicit yes, what is
// left blank, and what stops it. answers are this registration's approved answers; drafts are Cue's current drafts.
export function planFill(form: FormRead, facts: MemberFacts, answers: Answers = {}, drafts: Draft[] = []): Plan {
  const blockers: Blocker[] = [];
  const gate = form.gate;
  // A sign-in wall is not a blocker by itself: Luma signs a guest in with a code sent to their own email (signIn below), which the
  // member gives Cue in the moment. Only a sign-in Cue can't do that way (a password, another provider) stops it.
  if (gate === "login" && form.signIn !== "email_code") blockers.push({ kind: "login", detail: form.gateDetail ?? "the page asks them to sign in a way Cue can't (not by an email code)" });
  if (gate === "captcha") blockers.push({ kind: "captcha", detail: form.gateDetail ?? "the page put up a bot check" });
  if (gate === "closed") blockers.push({ kind: "closed", detail: form.gateDetail ?? "registration is closed" });
  if (gate === "sold_out") blockers.push({ kind: "full", detail: form.gateDetail ?? "it's full, with no waitlist" });
  if (gate === "unreadable") blockers.push({ kind: "unreadable", detail: form.gateDetail ?? "the registration form couldn't be read" });
  if (gate === "none" && form.action === "none") blockers.push({ kind: "unreadable", detail: "the page has no register button" });
  if (form.tickets.length > 1) blockers.push({ kind: "ticket_choice", detail: `the page offers ${form.tickets.length} ticket types` });
  const price = freeOnly(form.priceText, form.tickets);
  if (price.free === false) blockers.push({ kind: "paid", detail: price.why });
  else if (price.free === null) blockers.push({ kind: "price_unclear", detail: price.why });

  const fill: Fill[] = [];
  const missing: Plan["missing"] = [];
  const open: Plan["open"] = [];
  const attestations: Plan["attestations"] = [];
  const leftBlank: Plan["leftBlank"] = [];
  for (const f of form.fields) {
    if (f.kind === "marketing") { leftBlank.push({ fieldId: f.id, label: f.label, why: "marketing" }); continue; }
    if (!f.required) { leftBlank.push({ fieldId: f.id, label: f.label, why: "optional" }); continue; }
    if (f.kind === "terms" || f.kind === "attestation") { attestations.push({ fieldId: f.id, label: f.label, termsText: f.termsText ?? null }); continue; }
    if (f.kind === "unknown") { blockers.push({ kind: "unsupported", detail: `the form asks for something Cue can't fill in ("${f.label.slice(0, 80)}")` }); continue; }
    const approved = answers[f.id];
    if (approved?.value?.trim()) {
      if ((f.kind === "select" || f.kind === "multi_select") && f.options?.length && !optionsMatch(approved.value, f.options, f.kind === "multi_select")) {
        missing.push({ fieldId: f.id, label: f.label, kind: f.kind, options: f.options });
        continue;
      }
      fill.push({ fieldId: f.id, label: f.label, kind: f.kind, value: clean(approved.value), source: approved.source });
      continue;
    }
    if (FACTUAL_KINDS.has(f.kind)) {
      const fact = factFor(f.kind, facts);
      if (fact) { fill.push({ fieldId: f.id, label: f.label, kind: f.kind, value: fact.value, source: fact.source }); continue; }
    }
    if (f.kind === "open_question") { open.push({ fieldId: f.id, label: f.label, draft: drafts.find((d) => d.fieldId === f.id) ?? null }); continue; }
    // A yes/no question, a select, a short factual question ("who invited you?", "average check size?"): theirs to answer, never
    // inferred from anything they said elsewhere.
    missing.push({ fieldId: f.id, label: f.label, kind: f.kind, ...(f.options?.length ? { options: f.options } : {}) });
  }
  const expect = form.action === "waitlist" ? "waitlisted" : form.action === "request" ? "pending_approval" : "registered";
  return { blockers, fill, missing, open, attestations, leftBlank, expect, ticket: form.tickets[0] ?? null, signIn: (gate === "login" && form.signIn === "email_code") || gate === "verification" };
}

// Pure: an answer names one of the options (a multi-select: each comma-separated part does).
export function optionsMatch(value: string, options: string[], multi = false): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const opts = new Set(options.map(norm));
  const parts = multi ? value.split(/\s*[,;]\s*/) : [value];
  return parts.length > 0 && parts.every((p) => opts.has(norm(p)));
}

// Pure: whether the plan can go to the one yes (nothing stops it and nothing is missing). Drafts and attestations ride in the ask.
export const readyForYes = (p: Plan) => !p.blockers.length && !p.missing.length && p.open.every((o) => !!o.draft);

// ---------------------------------------------------------------- who the event is for (pure)

// Pure: the sentences of the event's own description that say who it's for or what attending requires, verbatim and clipped (live test
// 2026-11-09: "This event is open to Stanford students and affiliates. You must RSVP to attend." was never asked by the form, and a
// non-affiliate was registered). Cue puts them in front of the member as a fact to confirm; it never decides whether they qualify.
// Only eligibility (review 2026-11-09): who may attend (students, affiliates, members, employees, alumni, faculty, staff), invite-only,
// an age floor, an ID or badge, or an RSVP required of such a group. Never capacity ("space is limited"), food, or "open to all".
const WHO = /\b(?:students?|affiliates?|members?|employees?|alumni|alumnae|faculty|staff|residents?)\b/i;
const NARROWS = /\b(?:open (?:only )?to|only (?:open )?(?:to|for)|exclusively|restricted to|reserved for|limited to|must be|is for|are for|(?:students?|affiliates?|members?|employees?|alumni|faculty|staff)[- ]only|eligible)\b/i;
const INVITE = /\b(?:invite|invitation)[- ]only\b|\bby invitation\b|\bprivate event\b/i;
const AGE = /\b(?:21|18)\s?\+|\b(?:21|18) (?:and|or) (?:over|older|up)\b|\bages? (?:21|18)\b|\bmust be (?:21|18)\b/i;
const IDS = /\b(?:valid |student |government |photo |company )?(?:id|identification|badge)\b[^.]{0,40}\b(?:required|needed|must|bring|show|present)\b|\b(?:bring|show|present) (?:a |your )?(?:valid |student |government |photo |company )?(?:id|identification|badge)\b/i;
const RSVP_GROUP = /\b(?:students?|affiliates?|members?|employees?|alumni|faculty|staff)\b[^.]{0,60}\bmust (?:rsvp|register)\b/i;
const NOT_ELIGIBILITY = /\bopen to (?:all|everyone|the public|anyone)\b|\beveryone (?:is )?welcome\b|\b(?:space|spots?|seats?|capacity)\b[^.]{0,30}\blimited\b|\blimited (?:space|spots?|seats?|capacity)\b|\bfirst come\b/i;
export function restrictionsIn(description: string | null | undefined): string[] {
  const text = String(description ?? "").replace(/[​ ]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const out: string[] = [];
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    const t = s.trim();
    if (!t || NOT_ELIGIBILITY.test(t) && !INVITE.test(t) && !AGE.test(t)) continue;
    const eligible = (WHO.test(t) && NARROWS.test(t)) || INVITE.test(t) || AGE.test(t) || IDS.test(t) || RSVP_GROUP.test(t);
    if (eligible && !out.includes(t)) out.push(t.length > 220 ? `${t.slice(0, 219).trimEnd()}…` : t);
  }
  // Uncapped, in a stable order, so a page that reorders its sentences asks nothing new.
  return out.sort((x, y) => normRestriction(x).localeCompare(normRestriction(y)));
}
// Pure: a restriction as compared and hashed: case, punctuation, "&" and spacing don't count (a cosmetic edit never re-asks).
export const normRestriction = (r: string) => r.toLowerCase().replace(/&/g, " and ").replace(/[’']/g, "").replace(/[^a-z0-9+]+/g, " ").trim();

// ---------------------------------------------------------------- tailored answers stay with their registration (pure)

// Pure: facts a later registration may propose from earlier ones: factual details they approved on an earlier signup (their company,
// role, city, LinkedIn, a chosen email), within their permission: the new ask still lists every one, and only a yes to it sends them.
// A tailored answer (an open question, a select, a yes/no, a short custom answer) is never carried over: the next event asks anew.
export function factsFromEarlierSignups(earlier: { fields: FormField[]; answers: Answers }[]): MemberFacts {
  const out: MemberFacts = {};
  for (const r of earlier) {
    for (const f of r.fields) {
      const a = r.answers[f.id];
      if (!a || a.source === "draft_approved" || !FACTUAL_KINDS.has(f.kind) || f.kind === "name") continue;
      const k = f.kind as keyof MemberFacts;
      if (!out[k]) out[k] = { value: a.value, source: "earlier_signup" };
    }
  }
  return out;
}

// ---------------------------------------------------------------- drafts from their own words (pure)

// Pure: why a draft can't be shown, or null. It rests on their own words (basis, found in what they said), adds no number, link or
// name that isn't in those words, and never agrees, attests or claims a credential on their behalf.
export function draftProblem(d: Draft, theirWords: string): string | null {
  const t = clean(d.text);
  if (!t) return "the draft is empty";
  if (t.length > 600) return "the draft is too long (600 characters at most)";
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const basis = norm(d.basis);
  if (basis.trim().length < 8) return "the draft needs the words of theirs it rests on (basis)";
  if (!norm(theirWords).includes(basis)) return "the basis isn't their words: quote what they actually said";
  if (/\b(i agree|i consent|i accept|i certify|i attest|i confirm that|i acknowledge)\b/i.test(t)) return "a draft never agrees, consents or attests for them";
  if (/https?:\/\/|www\.|@[a-z0-9]/i.test(t)) return "a draft carries no links or handles";
  const nums = (s: string) => new Set(s.match(/\d[\d,.]*/g)?.map((n) => n.replace(/[,.]$/, "")) ?? []);
  const theirNums = nums(theirWords);
  const extra = [...nums(t)].filter((n) => !theirNums.has(n));
  if (extra.length) return `the draft says ${extra[0]}, which they never said`;
  // A capitalized word mid-sentence (a company, a school, a person) has to be in their words.
  const known = norm(theirWords);
  for (const sentence of t.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/^[("'“]+|[)"'”.,;:!?]+$/g, "").replace(/'s$/i, "");
      if (/^[A-Z][A-Za-z'-]+$/.test(w) && w !== "I" && !known.includes(` ${w.toLowerCase()} `)) return `the draft names "${w}", which isn't in their words`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- what their yes covers (pure)

// What the ask put in front of them: the event, the ticket, what happens on submit, every value that goes on the form, every term they
// agree to, and that marketing boxes stay unticked. Hashed, so the page read right before submitting can be held to the same scope.
export type Scope = {
  // Who the event says it's for (FormRead.restrictions), as their yes saw it.
  restrictions?: string[];
  eventUrl: string;
  eventName: string | null;
  when: string | null;
  ticket: string | null;
  price: string;
  expect: Plan["expect"];
  shares: { label: string; value: string }[];
  agrees: { label: string; termsText: string | null }[];
};

export function scopeOf(form: FormRead, plan: Plan): Scope {
  const price = freeOnly(form.priceText, form.tickets);
  return {
    eventUrl: canonicalEventUrl(form.url) ?? form.url,
    eventName: form.eventName,
    when: form.when,
    ticket: plan.ticket?.label ?? null,
    price: price.free === true ? "free" : price.why,
    expect: plan.expect,
    shares: [...plan.fill.map((f) => ({ label: f.label, value: f.value }))].sort((a, b) => a.label.localeCompare(b.label)),
    ...(form.restrictions?.length ? { restrictions: [...form.restrictions] } : {}),
    agrees: plan.attestations.map((a) => ({ label: a.label, termsText: a.termsText })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}

// The hash compares restrictions by their normalized words, sorted: the page's own wording is what the member reads.
export const scopeHash = (s: Scope) => createHash("sha256").update(JSON.stringify({ ...s, restrictions: s.restrictions ? [...new Set(s.restrictions.map(normRestriction))].sort() : undefined })).digest("hex").slice(0, 32);

// Pure: what changed between the scope they said yes to and the page now, in plain terms. Material changes stop the submit and go back
// to them: a new time, a price, a different outcome (approval or waitlist), a new thing to share, a new term to agree to.
export function scopeChanges(asked: Scope, now: Scope): string[] {
  const out: string[] = [];
  if ((asked.when ?? "") !== (now.when ?? "")) out.push(`the time changed (${asked.when ?? "unknown"} to ${now.when ?? "unknown"})`);
  if (asked.price !== now.price) out.push(`the price changed (${asked.price} to ${now.price})`);
  if (asked.ticket !== now.ticket) out.push("the ticket changed");
  if (asked.expect !== now.expect) out.push(now.expect === "waitlisted" ? "it's now a waitlist" : now.expect === "pending_approval" ? "the host now approves each guest" : "it no longer needs approval");
  const askedShares = new Set(asked.shares.map((s) => `${s.label}=${s.value}`));
  for (const s of now.shares) if (!askedShares.has(`${s.label}=${s.value}`)) out.push(`the form now also asks for "${s.label}"`);
  const askedAgrees = new Set(asked.agrees.map((a) => `${a.label}|${a.termsText ?? ""}`));
  for (const a of now.agrees) if (!askedAgrees.has(`${a.label}|${a.termsText ?? ""}`)) out.push(`there are new terms to agree to ("${a.label.slice(0, 80)}")`);
  if (asked.eventName && now.eventName && asked.eventName !== now.eventName) out.push("the event's name changed");
  const askedR = new Set((asked.restrictions ?? []).map(normRestriction));
  if ((now.restrictions ?? []).some((r) => !askedR.has(normRestriction(r)))) out.push("the page now says more about who it's for");
  return out;
}

// ---------------------------------------------------------------- the record and its states (pure)

export type Status =
  | "inspected" // the form was read; nothing asked yet
  | "needs_answers" // asked; a required detail or an approval is still missing
  | "awaiting_yes" // the submit question went out with everything filled; waiting on their yes to it
  | "needs_member_code" // Luma sent a code to their email; the held session waits for them to text it (used once, never stored)
  | "needs_member_step" // a verification step only they can do (a link in their email); the held session waits for their word
  | "submitting" // claimed for the one submit (never two)
  | "uncertain" // submitted, but the result wasn't seen: reconcile before anything else
  | "registered" | "pending_approval" | "waitlisted" | "already_registered" // what the page said
  | "failed" // the page said the submit didn't go
  | "blocked" // stopped before submitting (a blocker)
  | "withdrawn"; // they took it back, or said no

export const FINAL: ReadonlySet<Status> = new Set(["registered", "pending_approval", "waitlisted", "already_registered"]);

const EDGES: Record<Status, Status[]> = {
  inspected: ["needs_answers", "awaiting_yes", "blocked", "withdrawn", "inspected"],
  needs_answers: ["needs_answers", "awaiting_yes", "blocked", "withdrawn", "inspected"],
  awaiting_yes: ["submitting", "awaiting_yes", "needs_answers", "needs_member_code", "needs_member_step", "blocked", "withdrawn", "inspected"],
  // A sign-in or a code step in the middle of the submit pauses it; their code resumes the same session.
  submitting: ["registered", "pending_approval", "waitlisted", "already_registered", "failed", "blocked", "uncertain", "needs_member_code", "needs_member_step", "needs_answers", "awaiting_yes"],
  // Luma's own page (read signed in) can settle it without a submit; a reconcile that can't tell goes back to uncertain.
  needs_member_code: ["submitting", "needs_member_code", "needs_answers", "awaiting_yes", "blocked", "withdrawn", "inspected", "uncertain", "registered", "pending_approval", "waitlisted", "already_registered"],
  // Luma's own page (read signed in) can settle it without a submit; a reconcile that can't tell goes back to uncertain.
  needs_member_step: ["submitting", "needs_member_step", "needs_answers", "awaiting_yes", "blocked", "withdrawn", "inspected", "uncertain", "registered", "pending_approval", "waitlisted", "already_registered"],
  // A reconcile read signs in with their emailed code first (needs_member_code), then settles or, only if not registered, submits.
  uncertain: ["registered", "pending_approval", "waitlisted", "already_registered", "failed", "uncertain", "submitting", "needs_member_code"],
  registered: [],
  already_registered: [],
  // A pending request or a waitlist spot can be confirmed later (a reconcile read).
  pending_approval: ["registered"],
  waitlisted: ["registered", "pending_approval"],
  failed: ["inspected", "withdrawn"],
  blocked: ["inspected", "withdrawn"],
  withdrawn: ["inspected"],
};
export const canMove = (from: Status, to: Status) => EDGES[from]?.includes(to) ?? false;

// The durable record (event_registrations), one per member and event.
export type RegistrationRecord = {
  id: string;
  userId: string;
  eventKey: string;
  eventUrl: string;
  itemKey: string | null;
  eventName: string | null;
  status: Status;
  form: FormRead | null;
  scope: Scope | null;
  scopeHash: string | null;
  answers: Answers;
  drafts: Draft[];
  // The last ask that went out, and which kind: "answers" (a missing detail or a draft to approve; a yes to it saves answers, never
  // submits) or "submit" (the explicit "register you ... using these details and answers?"; only a yes to it authorizes the submit).
  askedAt: Date | null;
  askKind: "answers" | "submit" | null;
  askText: string | null;
  attempts: number;
  submitStartedAt: Date | null;
  outcome: Outcome | null;
  updatedAt: Date;
};

// What the page said after a submit (the driver's read), or what a reconcile read found.
export type Outcome = {
  state: "registered" | "pending_approval" | "waitlisted" | "already_registered" | "failed" | "blocked" | "uncertain";
  // A link the page itself gave (a ticket or confirmation link on the page), else the event's own page. Never made up.
  link: string | null;
  linkKind: "confirmation" | "event_page";
  detail: string | null;
  blocker?: Blocker | null;
  at: string;
};

// Pure: the one key for a member and an event: the event page's canonical link (lu.ma and luma.com are one host; tracking parameters
// and fragments dropped). Null for anything that isn't a Luma event page (v1 is Luma's public page only).
export function canonicalEventUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(String(url).trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (u.protocol !== "https:" || !["lu.ma", "luma.com"].includes(host)) return null;
  const path = u.pathname.replace(/\/+$/, "").replace(/^\/event(?=\/[^/]+$)/i, "");
  const slug = path.replace(/^\//, "");
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(slug) || RESERVED_PATHS.has(slug.toLowerCase())) return null;
  return `https://luma.com/${slug}`;
}
// Luma pages that aren't an event (a city, discover, a sign-in page...).
const RESERVED_PATHS = new Set(["discover", "signin", "login", "home", "calendar", "create", "explore", "settings", "user", "sf", "nyc", "la", "london", "pricing", "help"]);

export const eventKeyOf = (url: string): string | null => canonicalEventUrl(url)?.replace(/^https:\/\/luma\.com\//, "luma:") ?? null;
export const idempotencyKey = (userId: string, eventKey: string) => `${userId}:${eventKey}`;

// ---------------------------------------------------------------- right before the submit (pure)

export type SubmitCheck =
  | { go: true }
  | { go: false; why: "not_asked" | "withdrawn" | "newer_message" | "already_final" | "in_flight" | "uncertain" | "changed" | "blocked" | "incomplete" | "live_off" | "sign_in"; detail: string; changes?: string[] };

// Pure: whether the one submit may happen now. Rechecked right before submitting, after a fresh read of the page:
//   - an ask went out and their yes came after it, and nothing newer came from them since (a "wait, actually no" stops it);
//   - the record isn't withdrawn, final, in flight or unreconciled;
//   - the page now asks for the same thing the yes covered (scope hash), with nothing missing and nothing in the way;
//   - and live submission is approved at all (lumaDriver.ts LUMA_LIVE_SUBMIT_APPROVED), unless the page is a test fixture.
export function submitCheck(i: {
  record: Pick<RegistrationRecord, "status" | "askedAt" | "askKind" | "scope" | "scopeHash">;
  yesAt: Date;
  latestFromThemAt: Date | null;
  planNow: Plan;
  scopeNow: Scope;
  liveAllowed: boolean;
  // The held session already signed in with their code (the sign-in step is done).
  signedIn?: boolean;
}): SubmitCheck {
  const r = i.record;
  if (r.status === "withdrawn") return { go: false, why: "withdrawn", detail: "they took it back" };
  if (FINAL.has(r.status)) return { go: false, why: "already_final", detail: `already ${r.status.replace(/_/g, " ")}` };
  if (r.status === "submitting") return { go: false, why: "in_flight", detail: "a submit for this is already under way" };
  if (r.status === "uncertain") return { go: false, why: "uncertain", detail: "an earlier submit's result was never seen: reconcile first" };
  // Resuming after their code: the session is held at the step their code opens, so the record is waiting on them, not on a yes.
  const resuming = (r.status === "needs_member_code" || r.status === "needs_member_step") && i.signedIn;
  if (r.status !== "awaiting_yes" && !resuming) return { go: false, why: "not_asked", detail: r.status === "needs_answers" ? "they approved answers, but haven't been asked whether to register: ask the submit question" : `the registration is ${r.status.replace(/_/g, " ")}` };
  // Approving an answer is never the submit: only a yes to the submit question is (Royce, 2026-11-09).
  if (r.askKind !== "submit") return { go: false, why: "not_asked", detail: "the submit question hasn't been asked: approving an answer isn't a yes to register" };
  if (!r.askedAt || !r.scope || !r.scopeHash) return { go: false, why: "not_asked", detail: "they were never asked about this registration" };
  if (i.yesAt.getTime() < r.askedAt.getTime()) return { go: false, why: "not_asked", detail: "their yes came before the ask" };
  if (i.latestFromThemAt && i.latestFromThemAt.getTime() > i.yesAt.getTime()) return { go: false, why: "newer_message", detail: "they sent something after their yes: read it first" };
  if (i.planNow.signIn && !i.signedIn) return { go: false, why: "sign_in", detail: "the page wants their emailed code first" };
  if (i.planNow.blockers.length) return { go: false, why: "blocked", detail: i.planNow.blockers.map((b) => b.detail).join("; ") };
  if (i.planNow.missing.length || i.planNow.open.length) return { go: false, why: "incomplete", detail: "something the form needs still has no approved answer" };
  const changes = scopeChanges(r.scope, i.scopeNow);
  if (changes.length || scopeHash(i.scopeNow) !== r.scopeHash) return { go: false, why: "changed", detail: "the page changed since they were asked", changes: changes.length ? changes : ["what the form asks changed"] };
  if (!i.liveAllowed) return { go: false, why: "live_off", detail: "submitting on a live page isn't approved yet" };
  return { go: true };
}

// ---------------------------------------------------------------- after a lost or unclear result (pure)

// Pure: what to do with a registration whose submit result was never seen. Never submit again on a guess: the page is read first. A
// page that now shows them registered, pending or waitlisted settles it. A page that shows nothing either way stays uncertain, and a
// retry needs their yes AFTER they've been told it's unconfirmed (Luma documents that a repeat registration for the same email says
// "You have already registered for this event", help.luma.com/p/event-registration-process; unverified live).
export type Reconcile = { settle: Outcome["state"] } | { stay: "uncertain"; retryNeedsTheirYes: true };
export function reconcile(pageNow: { state: Outcome["state"] | "unknown" }): Reconcile {
  if (pageNow.state === "unknown" || pageNow.state === "uncertain" || pageNow.state === "blocked" || pageNow.state === "failed") return { stay: "uncertain", retryNeedsTheirYes: true };
  return { settle: pageNow.state };
}

// Pure: what the page says after a submit, from its visible text (the driver reads it; the wording is Luma's guest-facing text as far
// as it can be known without a live submit: every pattern here still needs live verification).
// The text read here is the REGISTRATION RESULT only: the dialog or the event's RSVP/ticket region the submit acted on, never the
// whole page (live test 2026-11-09, luma.com/example-event: a signup that succeeded was read as "blocked" because the page's header nav
// carries "Sign In"). A sign-in or a code step is never read from words here: the driver reads it from the page's structure (a code
// input, or a sign-in form in place of the registration form, inside that region). Anything this can't tell is "unknown", which the
// record keeps as uncertain after a click: never "blocked", never a guessed "failed", and never a second submit.
export function readResultText(text: string): Outcome["state"] | "unknown" {
  const t = String(text ?? "").replace(/[’]/g, "'").replace(/\s+/g, " ");
  if (/already registered|already (?:on the )?guest list|you('| a)re already (?:going|in)/i.test(t)) return "already_registered";
  // Only the guest's own status, never an offer ("Get on the waitlist", "If you're in SF…", "…before we see you there?").
  if (/you('| a)re on the wait ?list|added to the wait ?list|joined the wait ?list|you('| a)re waitlisted/i.test(t)) return "waitlisted";
  if (/pending approval|request (?:has been |was )?(?:sent|submitted|received)|waiting (?:for|on) (?:the )?host|awaiting approval|approval pending|registration pending/i.test(t)) return "pending_approval";
  if (/you('| a)re in(?:\s*[.!]|\s*$|\s+(?:add to calendar|invite a friend|no longer able|starting|my ticket|a confirmation))|you('| a)re registered\b|you('| a)re going\b|registration (?:is )?confirmed(?!\s+(?:by|after|once|when|upon))|you('| a)re confirmed\b|added to (?:the )?guest list/i.test(t)) return "registered";
  if (/something went wrong|couldn'?t (?:register|complete)|registration failed|please try again|an error occurred|invalid (?:email|input)/i.test(t)) return "failed";
  return "unknown";
}

// Pure: the blocker a result read stops on (an email code or a sign-in after submit is never success).
// Never a success: a code step pauses for their code (needs_member_code), a step only they can do pauses for them (needs_member_step).
export function resultBlocker(text: string): Blocker | null {
  const t = String(text ?? "").replace(/[’]/g, "'");
  if (/(?:enter|check your (?:email|inbox) for) (?:the |a )?(?:code|verification)|verify your email|one-time code|verification code/i.test(t)) return { kind: "verification", detail: "Luma sent a code to their email" };
  if (/please sign in|sign in to (?:continue|register)|log in to (?:continue|register)/i.test(t)) return { kind: "login", detail: "Luma asked them to sign in" };
  return null;
}

// ---------------------------------------------------------------- their emailed code (pure)

// Pure: the code in their message, when it's the only thing that looks like one: 4 to 8 digits (Luma's sign-in codes are digits; the
// exact length still needs live verification). Two candidates, or none, is no code: Cue asks again rather than guess. The code is used
// once in the held session and never stored, logged or put in a model prompt (agent/registrationTools.ts; toolGuard.ts redactedInput).
export function codeIn(message: string): string | null {
  const found = String(message ?? "").match(/(?<![\d-])\d(?:[ -]?\d){3,7}(?![\d-])/g) ?? [];
  const codes = [...new Set(found.map((c) => c.replace(/[ -]/g, "")))].filter((c) => c.length >= 4 && c.length <= 8);
  return codes.length === 1 ? codes[0] : null;
}

// Pure: what a sign-in or a later step revealed that their approval doesn't cover yet: only the new things go back to them; and
// whether the submit question has to be asked again (what they'd share or agree to changed).
export function newlyOutside(asked: Scope | null, planNow: Plan, scopeNow: Scope): { ask: { fieldId: string; label: string }[]; reaskSubmit: boolean; changes: string[] } {
  const ask = [...planNow.missing.map((m) => ({ fieldId: m.fieldId, label: m.label })), ...planNow.open.map((o) => ({ fieldId: o.fieldId, label: o.label }))];
  const changes = asked ? scopeChanges(asked, scopeNow) : ["nothing was asked yet"];
  return { ask, reaskSubmit: changes.length > 0 || !asked, changes };
}
