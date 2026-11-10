// Luma's public registration page, in a real browser (Royce, 2026-11-09). The same headless Chromium Cue already runs to read pages
// (services/browserRead.ts: playwright-core + Alpine's chromium in the api image, one shared browser, page slots), so nothing new is
// installed. Never Noise's organizer API key (it can't be assumed to reach another host's event), never a private endpoint, never a
// cookie taken from anywhere: the page a guest sees, a fresh browser context per member and event, closed when done.
//
// The flow, as coded (open → read → [sign in] → fill → submit → read result):
//   1. open: a fresh context (no cookies, no storage, Cue's ordinary desktop user agent), the event's public page. A bot check on load
//      (Cloudflare's "Just a moment", a CAPTCHA frame) is read as the captcha gate and nothing else is tried.
//   2. read: the page's own public data (its __NEXT_DATA__ script: the event's name and start, the ticket info, the terms text), then the
//      register button by what it says (Register / Request to Join / Join Waitlist), clicked to open the form; every field in the form is
//      read: label, type, required, options (a dropdown is opened and closed to read them), checkboxes with their own label. A sign-in
//      form (an email box and "Continue with email") is the login gate; a code box is the verification gate.
//   3. sign in (only when the page asks, and only Luma's emailed code): their chosen email typed in, the page emails them a code; the
//      session waits in memory (held sessions below) for the code they text back, which is typed in once and never kept.
//   4. fill: each planned value into its field (found by its name, else by its label), a dropdown by clicking its option, and only the
//      boxes they agreed to ticked. Optional fields and every marketing box are never touched.
//   5. submit (only when LUMA_LIVE_SUBMIT_APPROVED, or on a local fixture): the form's own submit button, clicked once. Then the page's
//      text is read for up to RESULT_MS: registered, pending approval, waitlisted, already registered, a code step, an error. Nothing
//      readable by then is "unknown", which the record keeps as uncertain: never retried on a guess.
//
// While reading (inspect), the context refuses every request that isn't a GET, so nothing on the page can register anyone even if
// something were clicked by mistake. While submitting, POSTs may go to Luma's own hosts only.
//
// LIVE SUBMISSION IS OFF. Luma's terms (luma.com/terms) ask for "publicly supported interfaces" and don't settle automation of the public
// registration page either way; this stays off until that is clarified and Royce approves a specific live test. A code constant, not an
// env switch (no feature toggles; approvals.ts). Inspect mode (reading a public page) works live; submit works only on local fixtures.
import type { Browser, BrowserContext, Page } from "playwright-core";
import { DateTime } from "luxon";
import { classifyField, readResultText, restrictionsIn, canonicalEventUrl, type FormField, type FormRead, type Ticket } from "./registration.js";
import type { RegistrationDriver, RegistrationSession, SubmitRead } from "./drivers.js";
import { keepBrowserWhile } from "../browserRead.js";

import { LUMA_LIVE_SUBMIT_APPROVED } from "./approvals.js";
export { LUMA_LIVE_SUBMIT_APPROVED };

export const LUMA_LIMITS = { pageMs: 20_000, settleMs: 1_500, resultMs: 12_000, pollMs: 400, heldMs: 10 * 60_000, heldMax: 3 } as const;
const LUMA_HOSTS = new Set(["luma.com", "lu.ma", "api.lu.ma", "api.luma.com"]);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const REGISTER_BUTTON = /^(register|request to join|join waitlist|rsvp|one-click rsvp|get tickets?|sign in to register)$/i;

export type LumaDeps = {
  browser: () => Promise<Browser>;
  slot: () => Promise<() => void>;
  // Tests: every request is answered from these (url → html, or a function standing in for Luma's server) and anything else is
  // refused; submit works only here.
  fixtures?: Record<string, string> | ((url: URL) => { body: string; contentType?: string } | undefined);
  // Live reads: whether a host resolves to public addresses (browserRead.ts publicHostChecker).
  publicHost?: (host: string) => Promise<boolean>;
};

export class LiveSubmitDisabled extends Error {
  constructor() {
    super("Live submission to Luma is not approved (LUMA_LIVE_SUBMIT_APPROVED is false).");
  }
}

// Pure: whether a submit may happen in this session.
export const submitAllowed = (fixtureMode: boolean, approved: boolean = LUMA_LIVE_SUBMIT_APPROVED) => approved || fixtureMode;

// Pure: the page's public data (its __NEXT_DATA__ JSON) as the parts a registration needs. Anything missing is null, never guessed.
export type PageData = { description?: string | null; name: string | null; startAt: string | null; zone: string | null; free: boolean | null; priceCents: number | null; flexible: boolean; ticketTypes: Ticket[]; requireApproval: boolean | null; soldOut: boolean | null; waitlist: boolean | null; terms: string[]; hosts: string[] };
export function pageDataFrom(json: unknown): PageData {
  const root: any = json ?? {};
  const d: any = root?.props?.pageProps?.initialData?.data ?? root?.props?.pageProps?.initialData ?? {};
  const ev: any = d.event ?? {};
  const ti: any = d.ticket_info ?? {};
  const flat = (node: any): string => (!node ? "" : typeof node.text === "string" ? node.text : Array.isArray(node.content) ? node.content.map(flat).join(node.type === "doc" ? "\n" : "") : "");
  const terms = (Array.isArray(d.registration_questions) ? d.registration_questions : []).filter((q: any) => q?.question_type === "terms").map((q: any) => flat(q?.terms?.content).trim()).filter(Boolean);
  const types = (Array.isArray(d.ticket_types) ? d.ticket_types : []).map((t: any) => ({ label: t?.name ?? null, priceText: t?.type === "free" ? "Free" : typeof t?.cents === "number" ? `$${(t.cents / 100).toFixed(2)}` : null }));
  const cents = typeof ti?.price?.cents === "number" ? ti.price.cents : null;
  return {
    name: typeof ev.name === "string" ? ev.name : null,
    startAt: typeof ev.start_at === "string" ? ev.start_at : typeof d.start_at === "string" ? d.start_at : null,
    zone: typeof ev.timezone === "string" ? ev.timezone : null,
    free: typeof ti.is_free === "boolean" ? ti.is_free : null,
    priceCents: cents,
    flexible: !!ti?.price?.is_flexible,
    ticketTypes: types,
    requireApproval: typeof ti.require_approval === "boolean" ? ti.require_approval : null,
    soldOut: typeof ti.is_sold_out === "boolean" ? ti.is_sold_out : typeof d.sold_out === "boolean" ? d.sold_out : null,
    waitlist: typeof d.waitlist_active === "boolean" ? d.waitlist_active : null,
    terms,
    hosts: (Array.isArray(d.hosts) ? d.hosts : []).map((h: any) => String(h?.name ?? "")).filter(Boolean),
    description: (() => { const t = flat(d.description_mirror ?? ev.description_mirror).trim(); return t || (typeof ev.description === "string" ? ev.description : null); })(),
  };
}

// Pure: the price words a plan judges free-only on, from the page's own data. A flexible or paid price is said as such.
export function priceTextOf(p: PageData): string | null {
  if (p.free === true && !p.flexible && (p.priceCents ?? 0) === 0) return "Free";
  if (p.flexible) return "Pay what you want";
  if (p.priceCents && p.priceCents > 0) return `$${(p.priceCents / 100).toFixed(2)}`;
  return null;
}

// Pure: the event's start as a member reads it, in the event's own zone.
export function whenOf(p: PageData): string | null {
  if (!p.startAt) return null;
  const d = DateTime.fromISO(p.startAt, { zone: p.zone ?? "UTC" });
  return d.isValid ? d.toFormat("ccc LLL d, h:mm a") : null;
}

// What the page's form says, read in the page (raw, classified in node).
type RawField = { name: string | null; label: string; type: string; autocomplete: string | null; required: boolean; options: string[]; checked?: boolean; combo?: boolean };
type RawForm = { fields: RawField[]; text: string; submitLabel: string | null; codeBox: boolean; signInForm: boolean; captcha: boolean };

// Pure: a field's stable id: its name when the page gives one (Luma's registration_answers.N.value), else its kind and label.
export const fieldId = (r: Pick<RawField, "name" | "label" | "type" | "combo">) =>
  r.name ? r.name : `${r.type === "checkbox" ? "check" : r.combo ? "combo" : "label"}:${r.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80)}`;

// Pure: the FormRead from the page's data and its form.
export function formReadFrom(url: string, data: PageData, raw: RawForm | null, button: string | null, at = new Date()): FormRead {
  const text = raw?.text ?? "";
  const action: FormRead["action"] = !button ? "none" : /waitlist/i.test(button) ? "waitlist" : /request/i.test(button) || data.requireApproval ? "request" : "register";
  let gate: FormRead["gate"] = "none";
  let signIn: FormRead["signIn"] = null;
  if (raw?.captcha) gate = "captcha";
  else if (raw?.codeBox) gate = "verification";
  else if (raw?.signInForm) {
    gate = "login";
    signIn = /continue with email|email (?:me )?a code|we'?ll (?:email|send) you a code|sign in with email/i.test(text) ? "email_code" : "other";
  } else if (/registration (?:is )?closed|no longer accepting|event has ended|this event has passed/i.test(text)) gate = "closed";
  else if ((data.soldOut || /sold out|event (?:is )?full/i.test(text)) && action !== "waitlist") gate = "sold_out";
  const fields: FormField[] = (raw?.fields ?? []).map((r) => {
    const kind = classifyField({ label: r.label, type: r.combo ? "text" : r.type, autocomplete: r.autocomplete, name: r.name, options: r.options, required: r.required });
    return { id: fieldId(r), label: r.label.replace(/\s*\*\s*$/, "").trim(), kind, required: r.required, ...(r.options.length ? { options: r.options } : {}), ...(kind === "terms" && data.terms.length ? { termsText: data.terms.join("\n\n").slice(0, 2000) } : {}) };
  });
  return {
    url: canonicalEventUrl(url) ?? url,
    eventName: data.name,
    when: whenOf(data),
    action: gate === "captcha" && !button ? "none" : action,
    tickets: data.ticketTypes.length > 1 ? data.ticketTypes : [],
    priceText: priceTextOf(data),
    // Who the event's own description says it's for (put to the member to confirm; never judged).
    ...(restrictionsIn(data.description).length ? { restrictions: restrictionsIn(data.description) } : {}),
    fields,
    gate,
    signIn,
    continues: !!raw?.submitLabel && /^(next|continue)$/i.test(raw.submitLabel),
    readAt: at.toISOString(),
  };
}

// In the page: the open form, read. Runs in the browser, so it uses only the DOM.
// Plain JavaScript in a string, not a function: a transpiler's helpers (tsx adds __name to nested functions) don't exist in the page.
const READ_FORM_JS = String.raw`(() => {
  const scope = document.querySelector("[role=dialog] form") || document.querySelector("[role=dialog]") || document.querySelector("form") || document;
  const text = ((scope.innerText !== undefined ? scope.innerText : document.body.innerText) || "").slice(0, 8000);
  const labelOf = (el) => {
    const id = el.getAttribute("id");
    const byFor = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
    const by = el.getAttribute("aria-labelledby");
    const byAria = by ? document.getElementById(by.split(" ")[0]) : null;
    const wrap = el.closest("label");
    const t = (byFor && byFor.innerText) || (byAria && byAria.innerText) || (wrap && wrap.innerText) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
    return t.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  };
  const fields = [];
  for (const el of Array.from(scope.querySelectorAll("input, textarea, select, [role=combobox]"))) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || (tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text")).toLowerCase();
    if (["hidden", "submit", "button"].includes(type)) continue;
    // A div combobox wraps its own input; read the input once.
    if (tag !== "input" && el.querySelector("input")) continue;
    const label = labelOf(el);
    const combo = el.getAttribute("role") === "combobox";
    const listId = el.getAttribute("aria-controls");
    const options = tag === "select" ? Array.from(el.options).map((o) => o.text.trim()).filter((t) => t && !/^select/i.test(t)) : listId ? Array.from(document.querySelectorAll("#" + CSS.escape(listId) + " [role=option]")).map((o) => o.innerText.trim()).filter(Boolean) : [];
    // The same id fieldId() gives in node: its name, else its kind and label. Tagged so fill finds this exact element again.
    const name = el.getAttribute("name");
    const id = name ? name : (type === "checkbox" ? "check" : combo ? "combo" : "label") + ":" + label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    el.setAttribute("data-cue-id", id);
    const f = { name, label, type, autocomplete: el.getAttribute("autocomplete"), required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label), options, combo };
    if (type === "checkbox") f.checked = el.checked;
    fields.push(f);
  }
  const submit = scope.querySelector("button[type=submit]");
  const codeBox = !!scope.querySelector("input[autocomplete=one-time-code]") || /enter the code|verification code|code we (?:sent|emailed)/i.test(text);
  const emailOnly = fields.length > 0 && fields.every((f) => f.type === "email" || f.autocomplete === "email");
  const signInForm = (emailOnly && /sign in|log in|continue with email/i.test(text)) || /please sign in to register/i.test(text);
  const captcha = !!document.querySelector('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile, .g-recaptcha, .h-captcha') || /^just a moment/i.test(document.title) || /verify you are human|checking your browser/i.test(document.body.innerText || "");
  return { fields, text, submitLabel: submit ? submit.innerText.trim() : null, codeBox, signInForm, captcha };
})()`;

// Pure: what a signed-in event page says Luma holds for this guest. "not_registered" only when the page offers its register button and
// says none of the guest states; anything else it can't tell is "unknown" (never read as not registered).
// Pure: Luma's own state for this guest from the region read: a status only from the guest-status block (or a dialog); "not registered"
// only when there is no status block and a live register button is on the page; anything else is unknown.
export function ownStateFromRegion(r: RegionRead | null): ReturnType<typeof ownStateFrom> {
  if (!r) return { state: "unknown", why: "the page couldn't be read" };
  if (r.region === "status" || r.region === "dialog") return ownStateFrom(r.text, false);
  if (r.registerButton) return { state: "not_registered", why: "signed in, the page offers registration and shows no status block for them" };
  return { state: "unknown", why: "the page shows neither this guest's status nor a way to register" };
}
export function ownStateFrom(text: string, registerButton: boolean): { state: "registered" | "pending_approval" | "waitlisted" | "not_registered" | "unknown"; why: string } {
  const t = String(text ?? "").replace(/[’]/g, "'").replace(/\s+/g, " ");
  if (/pending approval|request (?:has been |was )?(?:sent|submitted)|waiting (?:for|on) (?:the )?host/i.test(t)) return { state: "pending_approval", why: "the page shows their request pending" };
  if (/you're on the waitlist|you're waitlisted|on the wait ?list/i.test(t)) return { state: "waitlisted", why: "the page shows them on the waitlist" };
  if (/you're going|you're registered|you're in\b|you have already registered|registration confirmed/i.test(t)) return { state: "registered", why: "the page shows them registered" };
  if (registerButton) return { state: "not_registered", why: "signed in, the page offers registration and shows no registration for them" };
  return { state: "unknown", why: "the page shows neither a registration nor a way to register" };
}

// What the page shows in the registration's own region, read in the page (plain JavaScript in a string, like READ_FORM_JS).
//   region: the open dialog, else the RSVP/ticket block the register button sat in (tagged when it was clicked), else the page's main
//   content with its header, nav and footer taken out ("main"), else nothing.
export type RegionRead = { region: "dialog" | "status" | "rsvp" | "main" | "none"; text: string; codeInput: boolean; signInForm: boolean; formStillOpen: boolean; tied: boolean; ticket: string | null; registerButton: boolean };
// The registration's own region, in this order:
//   1. an open dialog (the form, or its answer);
//   2. the guest-status block for this event: the block that carries this guest's own controls (cancel the registration, My Ticket),
//      read with its status line ("You're In", "Pending", "On the waitlist"). Luma's registered page (captured 2026-11-09) also shows a
//      "Registration ... Register" block further down, inert: inert and hidden blocks are never read, and that block is not a state;
//   3. the RSVP/ticket block the register button sat in (tagged when it was clicked);
//   4. the page's main content with its header, nav, footer and inert blocks taken out ("main": its words are never proof).
// registerButton: a visible register button outside any inert block.
const REGION_JS = String.raw`((member) => {
  const live = (el) => !!el && el.isConnected && !el.closest("[inert], [aria-hidden=true]") && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const words = (root) => {
    const out = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => { const p = n.parentElement; if (!p) return NodeFilter.FILTER_REJECT; if (p.closest("script, style, noscript, [inert], [aria-hidden=true], header, nav, footer, [role=navigation], [role=banner], [role=contentinfo]")) return NodeFilter.FILTER_REJECT; return NodeFilter.FILTER_ACCEPT; } });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) { const t = n.nodeValue.trim(); if (t) out.push(t); }
    return out.join(" ").replace(/\s+/g, " ").slice(0, 4000);
  };
  const STATE = /you[’']re in\b|you[’']re (?:going|registered)|pending approval|request (?:has been |was )?(?:sent|submitted)|on the wait ?list|you[’']re waitlisted|registration (?:is )?confirmed/i;
  const CONTROL = /cancel(?:ing)? (?:your )?registration|my ticket/i;
  const registerButton = Array.from(document.querySelectorAll("button, [role=button]")).some((b) => live(b) && /^(register|request to join|join waitlist|rsvp|one-click rsvp|get tickets?)$/i.test((b.innerText || "").trim()));
  let region = "none", node = null;
  const dialog = document.querySelector("[role=dialog]");
  if (live(dialog)) { region = "dialog"; node = dialog; }
  if (!node) {
    const controls = Array.from(document.querySelectorAll("button, [role=button], a")).filter((el) => live(el) && (CONTROL.test(el.innerText || "") || CONTROL.test(el.getAttribute("aria-label") || "")));
    for (const c of controls) {
      let up = c;
      for (let i = 0; i < 7 && up && up !== document.body; i++, up = up.parentElement) if (STATE.test(words(up))) { node = up; region = "status"; break; }
      if (node) break;
    }
  }
  if (!node) { const rsvp = document.querySelector("[data-cue-region]"); if (live(rsvp)) { region = "rsvp"; node = rsvp; } }
  if (!node) { node = document.querySelector("main") || document.body; region = node ? "main" : "none"; }
  if (!node) return { region: "none", text: "", codeInput: false, signInForm: false, formStillOpen: false, tied: false, ticket: null, registerButton };
  const text = words(node);
  const q = (s) => Array.from(node.querySelectorAll(s)).find((el) => live(el)) || null;
  const codeInput = !!q("input[autocomplete=one-time-code]") || (!!q("input[inputmode=numeric]") && /code/i.test(text));
  const hasName = !!q("input[name=name], input[autocomplete=name], input[autocomplete=given-name]");
  const hasEmail = !!q("input[type=email], input[autocomplete=email]");
  const signInForm = hasEmail && !hasName && /sign in|log in|continue with email/i.test(text);
  const formStillOpen = region === "dialog" && hasName && !!q("button[type=submit]");
  const low = text.toLowerCase();
  const tiedWords = (member.email && low.includes(String(member.email).toLowerCase())) || (member.name && low.includes(String(member.name).toLowerCase()));
  const links = Array.from(node.querySelectorAll("a[href]")).filter((a) => live(a)).map((a) => a.href);
  const ticket = links.find((h) => /^https:\/\/(?:lu\.ma|luma\.com)\/(?:ticket|e\/ticket|tickets?)\//i.test(h)) || null;
  return { region, text, codeInput, signInForm, formStillOpen, tied: !!tiedWords || !!ticket, ticket, registerButton };
})`;

// A string expression is evaluated as is (Playwright passes no argument to it), so the member is written into the call.
export const regionCall = (member: { email: string | null; name: string | null }) => `${REGION_JS}(${JSON.stringify(member)})`;

// Pure: the result of a submit from its region's read. A code input in the region is the code step. Success, pending, waitlist and
// already-registered count only from the dialog or the RSVP block (generic words in the page's main content are not proof). An error
// counts as failed only while the dialog's form is still open (the submit was refused there); everything else after a click is unknown,
// which the record keeps as uncertain: never "blocked", never a guessed "failed", never a second submit.
export function resultFrom(r: RegionRead | null, eventUrl: string): SubmitRead {
  const none: SubmitRead = { state: "unknown", detail: null, link: eventUrl, linkKind: "event_page" };
  if (!r) return none;
  if (r.codeInput) return { state: "needs_code", detail: "Luma sent a code to their email", link: null, linkKind: "event_page" };
  if (r.signInForm) return none;
  const words = readResultText(r.text);
  const scoped = r.region === "dialog" || r.region === "status" || r.region === "rsvp";
  const link = r.ticket ?? eventUrl;
  const linkKind = r.ticket ? ("confirmation" as const) : ("event_page" as const);
  const detail = `${r.text.slice(0, 200)}${r.tied ? "" : " [not tied to them on the page]"}`;
  if (words === "failed") return r.formStillOpen ? { state: "failed", detail: r.text.slice(0, 200), link: eventUrl, linkKind: "event_page" } : none;
  if (words === "unknown" || words === "blocked" || words === "uncertain" || !scoped) return none;
  return { state: words, detail, link, linkKind };
}

// ---------------------------------------------------------------- held sessions (in memory only)

// A session waiting on the member (their emailed code), by registration id. In memory only: a restart drops it (the member is asked to
// start the sign-in again; nothing about it is ever written down). Closed when used, when it times out, or past heldMax.
const held = new Map<string, { session: RegistrationSession; until: number }>();
// Expired holds are closed by a timer (not only when the next one is held), and every hold is closed when the process shuts down.
let sweeper: NodeJS.Timeout | null = null;
export function sweepHeld(now = Date.now()): number {
  let closed = 0;
  for (const [k, v] of held) if (v.until < now) { held.delete(k); void v.session.close(); closed++; }
  if (!held.size && sweeper) { clearInterval(sweeper); sweeper = null; }
  return closed;
}
export async function closeAllHeld(): Promise<void> {
  const all = [...held.values()];
  held.clear();
  await Promise.all(all.map((h) => h.session.close().catch(() => {})));
}
let shutdownHooked = false;
// Told when held sessions are lost because their browser went away (crashed, killed, closed): the registrations waiting on them are
// expired by the caller (before a submit: start over; after one: uncertain). Their pages are gone, so nothing is closed here.
const lostListeners = new Set<(registrationIds: string[]) => void>();
export function onHeldLost(fn: (registrationIds: string[]) => void): void {
  lostListeners.add(fn);
}
export function dropHeldFor(session: RegistrationSession): string[] {
  const ids = [...held.entries()].filter(([, h]) => h.session === session).map(([id]) => id);
  for (const id of ids) held.delete(id);
  if (ids.length) for (const fn of lostListeners) { try { fn(ids); } catch {} }
  return ids;
}
// The shared browser's idle close (browserRead.ts, 2 minutes) never ends a page held for their code (up to 10 minutes).
// Nor ends a registration page that is open right now (reading or submitting).
let openPages = 0;
keepBrowserWhile(() => held.size > 0 || openPages > 0);
export function holdSession(registrationId: string, session: RegistrationSession, now = Date.now()): boolean {
  sweepHeld(now);
  if (!held.has(registrationId) && held.size >= LUMA_LIMITS.heldMax) return false;
  const before = held.get(registrationId)?.session;
  if (before && before !== session) void before.close();
  held.set(registrationId, { session, until: now + LUMA_LIMITS.heldMs });
  if (!sweeper) { sweeper = setInterval(() => sweepHeld(), 60_000); sweeper.unref?.(); }
  if (!shutdownHooked) {
    shutdownHooked = true;
    void import("../shutdown.js").then((S) => S.onShutdown(() => closeAllHeld())).catch(() => {});
  }

  return true;
}
// Whether a session is held for this registration now (an active code challenge), without taking it.
export const isHeld = (registrationId: string, now = Date.now()) => (held.get(registrationId)?.until ?? 0) >= now;
export function takeHeldSession(registrationId: string, now = Date.now()): RegistrationSession | null {
  const h = held.get(registrationId);
  if (!h) return null;
  held.delete(registrationId);
  if (h.until < now) { void h.session.close(); return null; }
  return h.session;
}
export const heldCount = () => held.size;

// ---------------------------------------------------------------- the driver

async function defaultDeps(): Promise<LumaDeps> {
  const B = await import("../browserRead.js");
  return { browser: B.sharedBrowser, slot: B.browserSlot, publicHost: B.publicHostChecker() };
}

export function lumaDriver(depsIn?: LumaDeps): RegistrationDriver {
  return {
    platform: "luma",
    handles: (url) => !!canonicalEventUrl(url),
    open: async (url) => openLuma(url, depsIn ?? (await defaultDeps())),
  };
}

async function openLuma(urlIn: string, deps: LumaDeps): Promise<RegistrationSession> {
  const url = canonicalEventUrl(urlIn);
  if (!url) throw new Error("not a Luma event page");
  const fixtureMode = !!deps.fixtures;
  const release = await deps.slot();
  let context: BrowserContext | null = null;
  let page: Page;
  let mode: "read" | "submit" = "read";
  // Signed in with their emailed code in this session (Luma's own sign-in): only then can the page say what Luma holds for their email.
  let signInStarted = false;
  let signedIn = false;
  let released = false;
  const free = () => { if (!released) { released = true; release(); } };
  let counted = true;
  openPages++;
  const uncount = () => { if (counted) { counted = false; openPages--; } };
  try {
    const browser = await deps.browser();
    context = await browser.newContext({ userAgent: UA, locale: "en-US", viewport: { width: 1280, height: 900 } });
    await context.route("**/*", async (route) => {
      const req = route.request();
      let u: URL;
      try { u = new URL(req.url()); } catch { return route.abort(); }
      const host = u.hostname.toLowerCase();
      if (fixtureMode) {
        if (req.method() !== "GET") return route.abort();
        const f = deps.fixtures!;
        if (typeof f === "function") {
          const r = f(u);
          return r ? route.fulfill({ status: 200, contentType: r.contentType ?? "text/html", body: r.body }) : route.abort();
        }
        const html = f[`${u.origin}${u.pathname}`.replace(/\/+$/, "")];
        return html !== undefined ? route.fulfill({ status: 200, contentType: "text/html", body: html }) : route.abort();
      }
      if (u.protocol !== "https:" || ["image", "font", "media"].includes(req.resourceType())) return route.abort();
      // Reading: GETs only, so nothing can register anyone. Submitting: a POST may go to Luma's own hosts only.
      if (req.method() !== "GET" && req.method() !== "HEAD" && !(mode === "submit" && LUMA_HOSTS.has(host))) return route.abort();
      if (deps.publicHost && !(await deps.publicHost(host))) return route.abort();
      return route.continue();
    });
    page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: LUMA_LIMITS.pageMs });
    await page.waitForTimeout(fixtureMode ? 100 : LUMA_LIMITS.settleMs);
  } catch (err) {
    await context?.close().catch(() => {});
    free();
    uncount();
    throw err;
  }
  const ctx = context!;
  // The browser going away (a crash, a kill, a close) loses this page: if it's held for their code, it's dropped and reported.
  const theBrowser = ctx.browser();
  const onGone = () => dropHeldFor(session);
  let button: string | null = null;
  let data: PageData = pageDataFrom(null);

  const readData = async () => {
    const raw = await page.$eval("script#__NEXT_DATA__", (s) => s.textContent ?? "").catch(() => "");
    try { data = pageDataFrom(raw ? JSON.parse(raw) : null); } catch { data = pageDataFrom(null); }
  };
  const formOpen = async () => (await page.$("[role=dialog] form, [role=dialog] input")) !== null;
  const openForm = async () => {
    if (await formOpen()) return;
    const b = page.getByRole("button", { name: REGISTER_BUTTON }).first();
    if (!(await b.count().catch(() => 0))) { button = null; return; }
    button = (await b.innerText().catch(() => "")).trim() || null;
    // The block the register button sits in (the event's RSVP/ticket card): where the page answers a submit when its dialog closes.
    await b.evaluate((el) => {
      const r = el.closest("section, [class*=card], [class*=rsvp], [class*=ticket], [class*=register]") ?? el.parentElement?.parentElement ?? el.parentElement;
      r?.setAttribute("data-cue-region", "1");
    }).catch(() => {});
    await b.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(fixtureMode ? 100 : LUMA_LIMITS.settleMs);
  };
  const raw = async (): Promise<RawForm> => {
    // Dropdowns list their options only while open: each is opened, read and closed (opening one never submits anything).
    for (const c of await page.$$("[role=dialog] [role=combobox]")) {
      await c.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(150);
      const opts = await page.$$eval("[role=listbox] [role=option]", (os) => os.map((o) => (o as HTMLElement).innerText.trim())).catch(() => [] as string[]);
      await c.evaluate((el, o) => el.setAttribute("data-cue-options", JSON.stringify(o)), opts).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
    }
    const r = (await page.evaluate(READ_FORM_JS)) as RawForm;
    const extra = await page.$$eval("[role=dialog] [role=combobox]", (cs) => cs.map((c) => c.getAttribute("data-cue-options"))).catch(() => [] as (string | null)[]);
    let i = 0;
    for (const f of r.fields) if (f.combo) { const o = extra[i++]; if (o && !f.options.length) try { f.options = JSON.parse(o); } catch {} }
    return r;
  };
  // The registration RESULT, read from its own region only (live test 2026-11-09: the whole page's text, header nav "Sign In" included,
  // read a successful signup as blocked). member: their email and name, to tie the result to them where the page shows it.
  const resultNow = async (member?: { email?: string | null; name?: string | null }): Promise<SubmitRead> => {
    const r = (await page.evaluate(regionCall({ email: member?.email ?? null, name: member?.name ?? null })).catch(() => null)) as RegionRead | null;
    return resultFrom(r, url);
  };
  // A field by the id its read gave it (READ_FORM_JS tags each one with data-cue-id), else by its name.
  const fieldLocator = (id: string) => page.locator(`[role=dialog] [data-cue-id=${JSON.stringify(id)}], [role=dialog] [name=${JSON.stringify(id)}]`).first();

  await readData();

  const session: RegistrationSession = {
    async read() {
      // The description, when the page's data didn't carry it: the "About Event" section's own text (never the nav or the form).
      if (!data.description) {
        data.description = await page.evaluate(() => {
          const h = Array.from(document.querySelectorAll("div, h2, h3, h4")).find((e) => (e as HTMLElement).innerText?.trim() === "About Event");
          const box = h?.parentElement?.parentElement;
          return box ? ((box as HTMLElement).innerText ?? "").replace(/^About Event\s*/, "").slice(0, 6000) : null;
        }).catch(() => null);
      }
      await openForm();
      return formReadFrom(url, data, await raw(), button);
    },
    async startSignIn(email) {
      // Not behind a sign-in wall: Luma's own "Sign In" opens the same emailed-code sign-in (for a reconcile read).
      if (!(await page.locator("[role=dialog] input[type=email]").count().catch(() => 0))) {
        const signIn = page.getByRole("button", { name: /^sign in$/i }).first();
        if (await signIn.count().catch(() => 0)) {
          await signIn.click({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(fixtureMode ? 150 : LUMA_LIMITS.settleMs);
        }
      }
      const box = page.locator("[role=dialog] input[type=email], [role=dialog] input[autocomplete=email]").first();
      if (!(await box.count())) return { ok: false, detail: "the sign-in form has no email box" };
      await box.fill(email);
      const go = page.locator("[role=dialog] button[type=submit]").first();
      if (!submitAllowed(fixtureMode)) return { ok: false, detail: "signing in on a live page isn't approved yet" };
      mode = "submit";
      signInStarted = true;
      await go.click({ timeout: 5_000 });
      await page.waitForTimeout(fixtureMode ? 150 : LUMA_LIMITS.settleMs);
      const r = await raw();
      return r.codeBox ? { ok: true, waitingFor: "code" } : { ok: true, waitingFor: "member_step" };
    },
    async enterCode(code) {
      if (!submitAllowed(fixtureMode)) return { ok: false, detail: "signing in on a live page isn't approved yet" };
      const boxes = page.locator("[role=dialog] input[autocomplete=one-time-code], [role=dialog] input[inputmode=numeric]");
      const n = await boxes.count();
      if (!n) return { ok: false, detail: "the page has no code box" };
      if (n === 1) await boxes.first().fill(code);
      else for (let i = 0; i < Math.min(n, code.length); i++) await boxes.nth(i).fill(code[i]);
      const go = page.locator("[role=dialog] button[type=submit]").first();
      if (await go.count()) await go.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(fixtureMode ? 150 : LUMA_LIMITS.settleMs);
      const after = await raw();
      if (after.codeBox) return { ok: false, detail: "the page didn't take the code" };
      if (signInStarted) signedIn = true;
      return { ok: true };
    },
    async fill(values, agreed) {
      for (const [id, value] of Object.entries(values)) {
        const el = fieldLocator(id);
        if (!(await el.count().catch(() => 0))) return { ok: false, detail: `a field on the form couldn't be found again (${id})` };
        const isCombo = (await el.getAttribute("role").catch(() => null)) === "combobox";
        if (isCombo) {
          for (const v of value.split(/\s*[,;]\s*/)) {
            await el.click({ timeout: 2_000 });
            const opt = page.getByRole("option", { name: v, exact: true }).first();
            if (!(await opt.count())) return { ok: false, detail: `the option "${v}" isn't on the form` };
            await opt.click();
          }
          await page.keyboard.press("Escape").catch(() => {});
        } else await el.fill(value, { timeout: 3_000 });
      }
      for (const id of agreed) {
        const box = fieldLocator(id);
        if (!(await box.count().catch(() => 0))) return { ok: false, detail: `a box they agreed to couldn't be found again (${id})` };
        if (!(await box.isChecked().catch(() => false))) await box.check({ timeout: 3_000 });
      }
      return { ok: true };
    },
    async submit(member) {
      if (!submitAllowed(fixtureMode)) throw new LiveSubmitDisabled();
      mode = "submit";
      // Whether the click happened decides what a crash means: before it, nothing was sent; after it, the result is unknown.
      let clicked = false;
      try {
        const go = page.locator("[role=dialog] button[type=submit]").first();
        if (!(await go.count())) return { state: "failed", detail: "the form has no submit button", link: url, linkKind: "event_page" };
        await go.click({ timeout: 5_000, noWaitAfter: true, trial: true });
        clicked = true;
        await go.click({ timeout: 5_000 });
        const until = Date.now() + (fixtureMode ? 1_500 : LUMA_LIMITS.resultMs);
        let r = await resultNow(member);
        while (r.state === "unknown" && Date.now() < until) {
          await page.waitForTimeout(LUMA_LIMITS.pollMs);
          r = await resultNow(member);
        }
        return r;
      } catch (err: any) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { clicked });
      }
    },
    async ownState() {
      // What Luma itself shows for their email on this event: only meaningful once signed in with their code in this session.
      if (!signedIn) return { state: "unknown", why: "not signed in to Luma in this session" };
      await page.reload({ waitUntil: "domcontentloaded", timeout: LUMA_LIMITS.pageMs });
      await page.waitForTimeout(fixtureMode ? 150 : LUMA_LIMITS.settleMs);
      // This guest's status block for this event, never the whole page: Luma's registered page also shows a "Registration ... Register"
      // block (inert), so a register button on the page says nothing by itself (captured 2026-11-09).
      return ownStateFromRegion((await page.evaluate(regionCall({ email: null, name: null })).catch(() => null)) as RegionRead | null);
    },
    async readResult(member) {
      return resultNow(member);
    },
    async pageText() {
      return page.evaluate(() => document.body.innerText ?? "").catch(() => "");
    },
    async close() {
      theBrowser?.off("disconnected", onGone);
      await ctx.close().catch(() => {});
      free();
      uncount();
    },
  };
  theBrowser?.on("disconnected", onGone);
  // A page held for the member's code doesn't keep a page slot from everyone else's reads.
  const hold = session.startSignIn;
  session.startSignIn = async (email) => {
    const r = await hold(email);
    free();
    return r;
  };
  return session;
}
