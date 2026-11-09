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
import { classifyField, readResultText, canonicalEventUrl, type FormField, type FormRead, type Ticket } from "./registration.js";
import type { RegistrationDriver, RegistrationSession, SubmitRead } from "./drivers.js";

import { LUMA_LIVE_SUBMIT_APPROVED } from "./approvals.js";
export { LUMA_LIVE_SUBMIT_APPROVED };

export const LUMA_LIMITS = { pageMs: 20_000, settleMs: 1_500, resultMs: 12_000, pollMs: 400, heldMs: 10 * 60_000, heldMax: 3 } as const;
const LUMA_HOSTS = new Set(["luma.com", "lu.ma", "api.lu.ma", "api.luma.com"]);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const REGISTER_BUTTON = /^(register|request to join|join waitlist|rsvp|one-click rsvp|get tickets?|sign in to register)$/i;

export type LumaDeps = {
  browser: () => Promise<Browser>;
  slot: () => Promise<() => void>;
  // Tests: every request is answered from these (url → html) and anything else is refused; submit works only here.
  fixtures?: Record<string, string>;
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
export type PageData = { name: string | null; startAt: string | null; zone: string | null; free: boolean | null; priceCents: number | null; flexible: boolean; ticketTypes: Ticket[]; requireApproval: boolean | null; soldOut: boolean | null; waitlist: boolean | null; terms: string[]; hosts: string[] };
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

// ---------------------------------------------------------------- held sessions (in memory only)

// A session waiting on the member (their emailed code), by registration id. In memory only: a restart drops it (the member is asked to
// start the sign-in again; nothing about it is ever written down). Closed when used, when it times out, or past heldMax.
const held = new Map<string, { session: RegistrationSession; until: number }>();
export function holdSession(registrationId: string, session: RegistrationSession, now = Date.now()): boolean {
  for (const [k, v] of held) if (v.until < now) { held.delete(k); void v.session.close(); }
  if (!held.has(registrationId) && held.size >= LUMA_LIMITS.heldMax) return false;
  held.get(registrationId)?.session !== session && held.get(registrationId)?.session.close();
  held.set(registrationId, { session, until: now + LUMA_LIMITS.heldMs });
  return true;
}
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
  let released = false;
  const free = () => { if (!released) { released = true; release(); } };
  try {
    const browser = await deps.browser();
    context = await browser.newContext({ userAgent: UA, locale: "en-US", viewport: { width: 1280, height: 900 } });
    await context.route("**/*", async (route) => {
      const req = route.request();
      let u: URL;
      try { u = new URL(req.url()); } catch { return route.abort(); }
      const host = u.hostname.toLowerCase();
      if (fixtureMode) {
        const key = `${u.origin}${u.pathname}`.replace(/\/+$/, "");
        const html = deps.fixtures![key];
        return html !== undefined && req.method() === "GET" ? route.fulfill({ status: 200, contentType: "text/html", body: html }) : route.abort();
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
    throw err;
  }
  const ctx = context!;
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
  const resultNow = async (): Promise<SubmitRead> => {
    const text = await page.evaluate(() => document.body.innerText ?? "").catch(() => "");
    if (/enter the code|verification code|code we (?:sent|emailed)/i.test(text) || (await page.$("input[autocomplete=one-time-code]"))) return { state: "needs_code", detail: "Luma sent a code to their email", link: null, linkKind: "event_page" };
    const state = readResultText(text);
    // The page's own ticket or confirmation link when it shows one (never made up); else the event page.
    const ticket = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href).find((h) => /^https:\/\/(?:lu\.ma|luma\.com)\/(?:ticket|e\/ticket|tickets?)\//i.test(h)) ?? null).catch(() => null);
    return { state, detail: state === "unknown" ? null : text.replace(/\s+/g, " ").slice(0, 200), link: ticket ?? url, linkKind: ticket ? "confirmation" : "event_page" };
  };
  // A field by the id its read gave it (READ_FORM_JS tags each one with data-cue-id), else by its name.
  const fieldLocator = (id: string) => page.locator(`[role=dialog] [data-cue-id=${JSON.stringify(id)}], [role=dialog] [name=${JSON.stringify(id)}]`).first();

  await readData();

  const session: RegistrationSession = {
    async read() {
      await openForm();
      return formReadFrom(url, data, await raw(), button);
    },
    async startSignIn(email) {
      const box = page.locator("[role=dialog] input[type=email], [role=dialog] input[autocomplete=email]").first();
      if (!(await box.count())) return { ok: false, detail: "the sign-in form has no email box" };
      await box.fill(email);
      const go = page.locator("[role=dialog] button[type=submit]").first();
      if (!submitAllowed(fixtureMode)) return { ok: false, detail: "signing in on a live page isn't approved yet" };
      mode = "submit";
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
      return after.codeBox ? { ok: false, detail: "the page didn't take the code" } : { ok: true };
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
    async submit() {
      if (!submitAllowed(fixtureMode)) throw new LiveSubmitDisabled();
      mode = "submit";
      const go = page.locator("[role=dialog] button[type=submit]").first();
      if (!(await go.count())) return { state: "failed", detail: "the form has no submit button", link: url, linkKind: "event_page" };
      await go.click({ timeout: 5_000 });
      const until = Date.now() + (fixtureMode ? 1_500 : LUMA_LIMITS.resultMs);
      let r = await resultNow();
      while (r.state === "unknown" && Date.now() < until) {
        await page.waitForTimeout(LUMA_LIMITS.pollMs);
        r = await resultNow();
      }
      return r;
    },
    async readResult() {
      return resultNow();
    },
    async pageText() {
      return page.evaluate(() => document.body.innerText ?? "").catch(() => "");
    },
    async close() {
      await ctx.close().catch(() => {});
      free();
    },
  };
  // A page held for the member's code doesn't keep a page slot from everyone else's reads.
  const hold = session.startSignIn;
  session.startSignIn = async (email) => {
    const r = await hold(email);
    free();
    return r;
  };
  return session;
}
