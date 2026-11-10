// Registering a member for another host's Luma event, as Cue's tools (Royce, 2026-11-09). The action that follows an event Cue already
// found and sent them: never a general browsing assistant. Cue decides when to offer it; code guards the rest:
//   prepareEventRegistration  reads the event's whole public form (nothing submitted), plans what is filled from what they approved,
//                             and returns the one ask to send word for word: an answers ask (missing details, drafts to approve) or
//                             the submit question. Saves the record (event_registrations) with the scope the ask put in front of them.
//   saveRegistrationAnswers   keeps their answers for THIS registration (their own words, or a draft of Cue's they approved as shown),
//                             then returns the submit question. Never submits: approving a draft isn't a yes to register.
//   registerForEvent          their yes to the submit question (toolGuard's theirYes + a read scoped to this registration's question),
//                             then a fresh read of the page right before submitting: same scope, nothing newer from them, not withdrawn,
//                             live submission approved. One claim, one submit, the page's real answer. A sign-in or code step pauses it.
//   (their emailed code)      never a tool: caught before the ordinary reply (codeChallenge.ts, routes/sendblue.ts) and handed to
//                             continueWithCode, entered once in the held session; never stored, logged, traced or shown to a model.
//   stopEventRegistration     they took it back: withdrawn, the held session closed.
// None of these exist for anyone until live submission and the copy are both approved (eventRegistration/approvals.ts).
import { z } from "zod";
import { tool } from "ai";
import { toolUse } from "../services/capabilities.js";
import * as R from "../services/eventRegistration/registration.js";
import * as S from "../services/eventRegistration/registrationStore.js";
import * as C from "../services/eventRegistration/copy.js";
import type { RegistrationDriver, RegistrationSession } from "../services/eventRegistration/drivers.js";
import { lumaLinksIn, type FindLike, type ResolveDeps } from "../services/eventRegistration/lumaFromFind.js";
import type { CodeSource } from "../services/eventRegistration/codeSources.js";

export type SentFind = FindLike & { key: string };

// The fit line's own guidance (Royce, 2026-11-09, after the paid fit run): their specific reason, backed by both their own words and the
// event's page, or nothing. Pinned in evals/registration/conversation.ts.
export const FIT_DESCRIBE = "One short sentence naming their SPECIFIC reason, from their own words or what they've told you, that the event's own page backs. Never a vague one (\"lines up with where you are right now\") and never just a description of the event. No specific reason backed by both: leave it out. No guesses, nothing private.";

export type RegistrationEnv = {
  q?: S.Q;
  driver: () => Promise<RegistrationDriver>;
  // Their name and chosen email from their account, and factual details they gave (their home city).
  facts: (userId: string) => Promise<R.MemberFacts>;
  // Their own words (their texts and what they said on calls), the only ground a draft may stand on.
  theirWords: (userId: string) => Promise<string>;
  // What Cue sent them (the finds a registration may follow).
  sentFinds: (userId: string) => Promise<SentFind[]>;
  resolve: ResolveDeps;
  // When their latest message arrived (a "wait, no" after the yes stops the submit).
  latestFromThemAt: (userId: string) => Promise<Date | null>;
  codeSources: CodeSource[];
  liveSubmit: boolean;
  // Takes a used code out of the stored thread line it came in.
  redactCode: (userId: string, code: string) => Promise<void>;
  hold: (id: string, s: RegistrationSession) => boolean;
  takeHeld: (id: string) => RegistrationSession | null;
  now: () => Date;
};

export type RegistrationCtx = {
  userId: string;
  resolvedContent: string;
  recentExchange?: string | null;
  messageArrivedAt?: number;
  facts?: { add: (kind: "did_this_turn" | "known" | "not_done" | "hint", text: string) => void };
};

const SEND = "Send this to them as your reply, word for word, as its own text, with nothing added before or after it:";
const said = (text: string) => ({ sendThisWordForWord: text, note: SEND });

// Lowercase words, an email's @ and dots kept; a sentence's own full stop isn't part of the word before it.
const normText = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9@.' ]+/g, " ").replace(/\.(?=\s|$)/g, " ").replace(/\s+/g, " ").trim()} `;
const inTheirMessage = (value: string, message: string) => normText(value).trim().length >= 1 && normText(message).includes(normText(value));

export function registrationTools(ctx: RegistrationCtx, envIn: RegistrationEnv | (() => Promise<RegistrationEnv>), notDone: (what: string) => void) {
  return registrationFlow(ctx, envIn, notDone).tools;
}

// Pure: a page's words with the member's own name and email taken out (the outcome detail is kept; who they are isn't).
export function redactMember(text: string | null, values: (string | null | undefined)[], facts: R.MemberFacts = {}): string | null {
  if (text == null) return null;
  const known = [...values, facts.email?.value, facts.first_name?.value, facts.last_name?.value, facts.first_name && facts.last_name ? `${facts.first_name.value} ${facts.last_name.value}` : null]
    .filter((v): v is string => typeof v === "string" && v.trim().length >= 2)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of known) out = out.split(v).join("[member]");
  return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
}

// Their emailed code, caught before the ordinary reply (routes/sendblue.ts): entered once in the held session, and the line to send.
// Never throws and always has a line to send: their text was already taken in place of an ordinary reply.
export async function continueWithCode(ctx: RegistrationCtx, envIn: RegistrationEnv | (() => Promise<RegistrationEnv>), registrationId: string, code: string): Promise<{ text: string | null; result: Record<string, unknown> }> {
  let result: Record<string, unknown>;
  try {
    result = await registrationFlow(ctx, envIn, () => {}).withCode(registrationId, code);
  } catch {
    result = { ok: false, sendThisWordForWord: C.sessionExpired({ eventName: "the event", when: null, email: "your email", link: "" }, false) };
  }
  return { text: typeof result.sendThisWordForWord === "string" ? result.sendThisWordForWord : null, result };
}

function registrationFlow(ctx: RegistrationCtx, envIn: RegistrationEnv | (() => Promise<RegistrationEnv>), notDone: (what: string) => void) {
  // The environment is built on first use (a turn that never calls these tools never builds it).
  let env!: RegistrationEnv;
  let q: S.Q | undefined;
  const ready = async () => {
    if (!env) env = typeof envIn === "function" ? await envIn() : envIn;
    q = env.q;
  };
  const userId = ctx.userId;

  async function factsFor(rec: R.RegistrationRecord | null): Promise<R.MemberFacts> {
    const [mine, earlier] = await Promise.all([env.facts(userId), S.earlierSignups(userId, rec?.id ?? null, q)]);
    // Their account's name and email first; factual details approved on earlier signups fill only what's still unknown.
    return { ...R.factsFromEarlierSignups(earlier), ...mine };
  }
  const ctxFor = (rec: R.RegistrationRecord, plan: R.Plan | null, facts: R.MemberFacts): C.Ctx => ({
    eventName: rec.form?.eventName ?? rec.eventName ?? "the event",
    when: rec.form?.when ?? null,
    email: plan?.fill.find((f) => f.kind === "email")?.value ?? rec.answers.email?.value ?? facts.email?.value ?? "your email",
    link: rec.eventUrl,
  });

  // The ask that fits the plan now: a stop, an answers ask, or the submit question. Saves the record with what was asked.
  async function askFor(rec: R.RegistrationRecord, form: R.FormRead, facts: R.MemberFacts, o: { fit?: string | null; lead?: string | null } = {}): Promise<{ status: R.Status; text: string; record: R.RegistrationRecord | null }> {
    const plan = R.planFill(form, facts, rec.answers, rec.drafts);
    const c = ctxFor({ ...rec, form }, plan, facts);
    if (plan.blockers.length) {
      const b = plan.blockers[0];
      const text = C.blockerLine(c, b);
      const record = await S.moveRegistration(userId, rec.id, "blocked", { form, outcome: { state: "blocked", link: rec.eventUrl, linkKind: "event_page", detail: b.detail, blocker: b, at: env.now().toISOString() } }, q);
      return { status: "blocked", text, record };
    }
    const scope = R.scopeOf(form, plan);
    if (!R.readyForYes(plan)) {
      const text = `${o.lead ? `${o.lead} ` : ""}${C.answersAsk(c, plan, o.fit ?? null)}`;
      const record = await S.moveRegistration(userId, rec.id, "needs_answers", { form, scope, scopeHash: R.scopeHash(scope), askKind: "answers", askText: text, askedAt: env.now() }, q);
      return { status: "needs_answers", text, record };
    }
    const text = C.submitAsk(c, plan, scope, o.fit ?? null, o.lead ?? null);
    const record = await S.moveRegistration(userId, rec.id, "awaiting_yes", { form, scope, scopeHash: R.scopeHash(scope), askKind: "submit", askText: text, askedAt: env.now() }, q);
    return { status: "awaiting_yes", text, record };
  }

  // A held or fresh session's page, read, planned and (when everything holds) submitted once. Pauses for their code when the page
  // asks for one; goes back to them when the page now asks for something their yes didn't cover.
  async function runSubmit(rec: R.RegistrationRecord, session: RegistrationSession, o: { signedIn: boolean; yesAt: Date }): Promise<Record<string, unknown>> {
    let keep = false;
    try {
      const facts = await factsFor(rec);
      // Signed in: what Luma itself holds for their email comes first (a fresh read of the page). Already registered (or pending, or
      // waitlisted) is never registered again, whatever the record says.
      if (o.signedIn) {
        const own = await session.ownState().catch(() => ({ state: "unknown" as const, why: "the page couldn't be read" }));
        if (own.state === "registered" || own.state === "pending_approval" || own.state === "waitlisted") {
          return settleFound(rec, ctxFor(rec, null, facts), own.state);
        }
      }
      const form = await session.read();
      const plan = R.planFill(form, facts, rec.answers, rec.drafts);
      const scopeNow = R.scopeOf(form, plan);
      const c = ctxFor(rec, plan, facts);
      const check = R.submitCheck({ record: rec, yesAt: o.yesAt, latestFromThemAt: await env.latestFromThemAt(userId), planNow: plan, scopeNow, liveAllowed: env.liveSubmit, signedIn: o.signedIn });
      if (!check.go) {
        if (check.why === "sign_in") {
          const claimed = await S.claimSubmit(userId, rec.id, rec.scopeHash ?? "", { resuming: rec.status !== "awaiting_yes" }, q);
          if (!claimed) return { ok: false, error: "Another reply already has this registration in hand, or it moved. Don't say it's done." };
          const email = c.email;
          const st = await session.startSignIn(email);
          if (!st.ok) {
            await S.moveRegistration(userId, rec.id, "blocked", { outcome: { state: "blocked", link: rec.eventUrl, linkKind: "event_page", detail: st.detail, blocker: { kind: "login", detail: st.detail }, at: env.now().toISOString() } }, q);
            return { ok: false, ...said(C.blockerLine(c, { kind: "login", detail: st.detail })) };
          }
          return await waitForCode(claimed, session, c, st.waitingFor, "sign_in", () => { keep = true; });
        }
        if (check.why === "changed" || check.why === "incomplete") {
          const n = R.newlyOutside(rec.scope, plan, scopeNow);
          const lead = o.signedIn && n.ask.length ? C.revealedLead(n.ask.length) : check.why === "changed" ? C.changedLead(check.changes ?? []) : null;
          const a = await askFor(rec, form, facts, { lead });
          if (o.signedIn && a.status !== "blocked") keep = env.hold(rec.id, session);
          return { ok: false, error: "Not submitted: the page asks for something their yes didn't cover.", ...said(a.text) };
        }
        if (check.why === "blocked") {
          const a = await askFor(rec, form, facts);
          return { ok: false, error: "Not submitted.", ...said(a.text) };
        }
        if (check.why === "newer_message") return { ok: false, error: "Not submitted: they sent something after their yes. Answer what they said; if it still reads as a yes to registering, call this again." };
        if (check.why === "live_off") return { ok: false, error: "Not submitted: registering on a live page isn't approved yet. Say plainly you can't sign them up yet and share the event's link." };
        if (check.why === "already_final") return { ok: true, ...said(C.outcomeLine(c, rec.status === "already_registered" ? "already_registered" : (rec.status as any))) };
        return { ok: false, error: `Not submitted: ${check.detail}.` };
      }
      const claimed = await S.claimSubmit(userId, rec.id, rec.scopeHash ?? "", { resuming: rec.status === "needs_member_code" || rec.status === "needs_member_step" }, q);
      if (!claimed) return { ok: false, error: "Not submitted: another reply already has this registration, or it moved on. Never say it's done." };
      const values = Object.fromEntries(plan.fill.map((f) => [f.fieldId, f.value]));
      const filled = await session.fill(values, plan.attestations.map((a) => a.fieldId));
      if (!filled.ok) {
        // Nothing submitted yet: the claim is released as blocked, with the real link.
        const b: R.Blocker = { kind: "unreadable", detail: filled.detail };
        await S.recordOutcome(userId, rec.id, { state: "blocked", link: rec.eventUrl, linkKind: "event_page", detail: filled.detail, blocker: b, at: env.now().toISOString() }, "blocked", q);
        return { ok: false, ...said(C.blockerLine(c, b)) };
      }
      let res: Awaited<ReturnType<RegistrationSession["submit"]>>;
      try {
        // Their email and name, so the result is tied to them where the page shows them.
        res = await session.submit({ email: c.email, name: plan.fill.find((f) => f.kind === "name")?.value ?? null });
      } catch (err: any) {
        // The browser died or the page broke mid-submit. Before the click nothing was sent: it stops, with the real link. After it the
        // result is unknown: uncertain, reconciled before anything else, never retried on a guess.
        if (err?.clicked === false) {
          const b: R.Blocker = { kind: "unreadable", detail: "the browser stopped before submitting" };
          await S.recordOutcome(userId, rec.id, { state: "blocked", link: rec.eventUrl, linkKind: "event_page", detail: b.detail, blocker: b, at: env.now().toISOString() }, "blocked", q);
          return { ok: false, ...said(C.blockerLine(c, b)) };
        }
        res = { state: "unknown", detail: null, link: rec.eventUrl, linkKind: "event_page" };
      }
      return await settle(claimed, session, c, res, () => { keep = true; });
    } finally {
      if (!keep) await session.close();
    }
  }

  async function waitForCode(rec: R.RegistrationRecord, session: RegistrationSession, c: C.Ctx, waitingFor: "code" | "member_step", when: "sign_in" | "after_submit" | "reconcile", kept: () => void): Promise<Record<string, unknown>> {
    const to: R.Status = waitingFor === "code" ? "needs_member_code" : "needs_member_step";
    const moved = await S.moveRegistration(userId, rec.id, to, { outcome: { state: "uncertain", link: rec.eventUrl, linkKind: "event_page", detail: when, at: env.now().toISOString() } }, q);
    if (!env.hold(rec.id, session)) {
      const b: R.Blocker = { kind: "unreadable", detail: "too many signups waiting on a code right now" };
      await S.moveRegistration(userId, rec.id, when === "sign_in" ? "blocked" : "uncertain", {}, q);
      return { ok: false, ...said(when === "sign_in" ? C.blockerLine(c, b) : when === "reconcile" ? C.cannotConfirm(c) : C.outcomeLine(c, "uncertain")) };
    }
    kept();
    if (waitingFor === "member_step") return { ok: true, waiting: "member_step", ...said(C.memberStepAsk()) };
    // Authorized email first; the member only when that can't (codeSources.ts: no email access exists today, so they're asked).
    const found = await R_codeFrom(rec, env);
    if ("code" in found && moved) {
      const s = env.takeHeld(rec.id);
      if (s) return useCode({ ...moved, status: to }, s, found.code, c);
    }
    return { ok: true, waiting: "code", ...said(when === "reconcile" ? C.reconcileCodeAsk(c) : C.codeAsk(c, when)) };
  }

  // A held page that broke while their code went in (the browser died, the page closed): the session is released and the record
  // expires by stage, and they always get a line back (their text was already taken in place of an ordinary reply).
  async function expired(rec: R.RegistrationRecord, c: C.Ctx): Promise<Record<string, unknown>> {
    const now = (await S.registrationById(userId, rec.id, q).catch(() => null)) ?? rec;
    if (now.status === "submitting") {
      await S.moveRegistration(userId, rec.id, "uncertain", {}, q).catch(() => null);
      return { ok: false, ...said(C.outcomeLine(c, "uncertain")) };
    }
    if (R.FINAL.has(now.status)) return { ok: true, ...said(C.outcomeLine(c, now.status as any, { link: now.outcome?.link ?? rec.eventUrl })) };
    const detail = rec.outcome?.detail;
    const submitted = detail === "after_submit";
    const reconciling = detail === "reconcile";
    await S.moveRegistration(userId, rec.id, submitted || reconciling ? "uncertain" : "inspected", {}, q).catch(() => null);
    return { ok: false, ...said(reconciling ? C.cannotConfirm(c) : C.sessionExpired(c, submitted)) };
  }

  async function useCode(rec: R.RegistrationRecord, session: RegistrationSession, code: string, c: C.Ctx): Promise<Record<string, unknown>> {
    try {
      return await useCodeIn(rec, session, code, c);
    } catch {
      // Never the error's text in a log line or a reply: it can carry what the page echoed.
      await session.close().catch(() => {});
      return expired(rec, c);
    }
  }

  async function useCodeIn(rec: R.RegistrationRecord, session: RegistrationSession, code: string, c: C.Ctx): Promise<Record<string, unknown>> {
    const r = await session.enterCode(code);
    if (!r.ok) {
      env.hold(rec.id, session);
      return { ok: false, ...said(C.codeAgain) };
    }
    // Reconciling an unconfirmed submit: signed in, Luma's own page says what it holds for their email. Only "not registered" lets
    // the one retry they said yes to go; anything it can't tell stays uncertain, and nothing is sent again.
    if (rec.outcome?.detail === "reconcile") {
      const own = await session.ownState().catch(() => ({ state: "unknown" as const, why: "the page couldn't be read" }));
      if (own.state === "registered" || own.state === "pending_approval" || own.state === "waitlisted") {
        await session.close();
        return settleFound(rec, c, own.state);
      }
      if (own.state === "not_registered") return runSubmit(rec, session, { signedIn: true, yesAt: env.now() });
      await session.close();
      await S.moveRegistration(userId, rec.id, "uncertain", {}, q);
      notDone("Whether the first signup went through couldn't be confirmed: it was NOT submitted again.");
      return { ok: false, ...said(C.cannotConfirm(c)) };
    }
    const after = rec.outcome?.detail === "after_submit";
    if (after) {
      let keep = false;
      try {
        const res = await session.readResult({ email: c.email, name: null });
        return await settle(rec, session, c, res, () => { keep = true; });
      } finally {
        if (!keep) await session.close();
      }
    }
    // Signed in: the same yes carries on (the code is its continuation, not a new message to read), unless the page now asks for more.
    return runSubmit(rec, session, { signedIn: true, yesAt: env.now() });
  }

  // The page's answer to the submit, recorded once and said as it is.
  async function settle(rec: R.RegistrationRecord, session: RegistrationSession, c: C.Ctx, res: Awaited<ReturnType<RegistrationSession["submit"]>>, kept: () => void): Promise<Record<string, unknown>> {
    const at = env.now().toISOString();
    if (res.state === "needs_code") return waitForCode(rec, session, c, "code", "after_submit", kept);
    if (res.state === "unknown" || res.state === "uncertain") {
      await S.recordOutcome(userId, rec.id, { state: "uncertain", link: rec.eventUrl, linkKind: "event_page", detail: null, at }, "uncertain", q);
      notDone("The registration was submitted but the page never confirmed it: it is NOT confirmed.");
      return { ok: false, made: "a submitted signup the page didn't confirm", ...said(C.outcomeLine(c, "uncertain")) };
    }
    if (res.state === "blocked") {
      const b = R.resultBlocker(res.detail ?? "") ?? { kind: "unreadable" as const, detail: res.detail ?? "the page stopped it" };
      await S.recordOutcome(userId, rec.id, { state: "uncertain", link: rec.eventUrl, linkKind: "event_page", detail: res.detail, blocker: b, at }, "uncertain", q);
      return { ok: false, ...said(C.outcomeLine(c, "uncertain")) };
    }
    // The page's words are kept as the outcome's detail, but never the member's own name or email in them.
    const outcome: R.Outcome = { state: res.state, link: res.link ?? rec.eventUrl, linkKind: res.linkKind, detail: redactMember(res.detail, [c.email, ...Object.values(rec.answers).map((a) => a.value)], await factsFor(rec)), at };
    await S.recordOutcome(userId, rec.id, outcome, res.state as R.Status, q);
    const text = C.outcomeLine(c, res.state, { detail: res.detail, link: outcome.link });
    if (res.state === "failed") {
      notDone(`The registration for ${c.eventName} didn't go through.`);
      return { ok: false, ...said(text) };
    }
    ctx.facts?.add("did_this_turn", `Registration for ${c.eventName}: the page said ${res.state.replace(/_/g, " ")}.${res.state === "pending_approval" ? " Submitted, pending the host's approval: NOT confirmed." : res.state === "waitlisted" ? " On the waitlist: NOT confirmed." : ""}`);
    return { ok: true, status: res.state, ...said(text) };
  }

  // What Luma already holds for them (read signed in): recorded as it is, nothing submitted.
  async function settleFound(rec: R.RegistrationRecord, c: C.Ctx, state: "registered" | "pending_approval" | "waitlisted"): Promise<Record<string, unknown>> {
    const to: R.Status = state === "registered" ? "already_registered" : state;
    const outcome: R.Outcome = { state: to === "already_registered" ? "already_registered" : state, link: rec.eventUrl, linkKind: "event_page", detail: "Luma's own page, signed in", at: env.now().toISOString() };
    const settled = await S.recordOutcome(userId, rec.id, outcome, to, q);
    if (settled && R.FINAL.has(settled.status) && planHook) await planHook(settled).catch(() => {});
    ctx.facts?.add("did_this_turn", `Registration for ${c.eventName}: Luma's own page already shows ${state.replace(/_/g, " ")}; nothing was submitted again.`);
    return { ok: true, status: to, ...said(C.outcomeLine(c, to === "already_registered" ? "already_registered" : (state as any))) };
  }
  // Part 4 hooks the plan record here (services/eventRegistration/followThrough.ts); null until then.
  const planHook: ((r: R.RegistrationRecord) => Promise<unknown>) | null = null;

  // The event they mean: a find Cue sent them, by its link or its name, resolved to its Luma page.
  async function findFor(event: string): Promise<{ find: SentFind; url: string } | { error: string }> {
    const finds = await env.sentFinds(userId);
    const wanted = R.canonicalEventUrl(event);
    const byLink = finds.find((f) => (f.url && wanted && R.canonicalEventUrl(f.url) === wanted) || lumaLinksIn(f).includes(wanted ?? "\u0000"));
    const byName = byLink ?? finds.find((f) => normText(f.name).trim() === normText(event).trim()) ?? finds.find((f) => event.trim().length >= 4 && normText(f.name).includes(normText(event)));
    if (!byName) {
      // A Luma event link they brought themselves (in this message or what they said before): the same checked flow, from its page.
      const theirs = wanted && `${ctx.resolvedContent}\n${await env.theirWords(userId)}`.match(/https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/[A-Za-z0-9_/-]+/gi)?.some((u) => R.canonicalEventUrl(u) === wanted);
      if (theirs && wanted) return { find: { key: `link:${R.eventKeyOf(wanted)}`, name: "", url: wanted, details: null }, url: wanted };
      return { error: "That isn't an event Cue sent them or a Luma link they shared. Registering follows one of those; share the link instead." };
    }
    const { lumaPageForFind } = await import("../services/eventRegistration/lumaFromFind.js");
    const r = await lumaPageForFind(byName, env.resolve);
    if (!r.url) return { error: `Registering isn't available for this one (${r.why}). Share its link as usual.` };
    return { find: byName, url: r.url };
  }

  const tools = {
    prepareEventRegistration: tool({
      description: toolUse("prepareEventRegistration"),
      inputSchema: z.object({
        event: z.string().describe("The event's link, or its name exactly as Cue sent it."),
        fit: z.string().optional().describe(FIT_DESCRIBE),
        drafts: z.array(z.object({ fieldId: z.string(), text: z.string(), basis: z.string().describe("Their own words the draft rests on, copied exactly.") })).optional(),
      }),
      execute: async ({ event, fit, drafts }) => {
        await ready();
        const found = await findFor(event);
        if ("error" in found) return { ok: false, error: found.error };
        const eventKey = R.eventKeyOf(found.url)!;
        let rec = await S.openRegistration(userId, { eventKey, eventUrl: found.url, itemKey: found.find.key.startsWith("link:") ? null : found.find.key, eventName: found.find.name || null }, q);
        const facts = await factsFor(rec);
        const status = S.effectiveStatus(rec, env.now().getTime());
        // Already on the list (or waiting on the host or a spot): never again, said as it is.
        if (R.FINAL.has(status)) return { ok: true, status, ...said(C.outcomeLine(ctxFor(rec, null, facts), status as any, { link: rec.outcome?.link ?? rec.eventUrl })) };
        if (status === "submitting") return { ok: false, error: "A submit for this is under way right now. Don't start another; say you're on it only if they ask." };
        if (status === "uncertain") {
          const t = C.retryAsk(ctxFor(rec, null, facts));
          await S.moveRegistration(userId, rec.id, "uncertain", { askKind: "submit", askText: t, askedAt: env.now() }, q);
          return { ok: true, status: "uncertain", ...said(t) };
        }
        if (status === "needs_member_code") return { ok: true, status, ...said(rec.outcome?.detail === "reconcile" ? C.reconcileCodeAsk(ctxFor(rec, null, facts)) : C.codeAsk(ctxFor(rec, null, facts), rec.outcome?.detail === "after_submit" ? "after_submit" : "sign_in")) };
        if (status === "blocked" || status === "failed" || status === "withdrawn") rec = (await S.moveRegistration(userId, rec.id, "inspected", {}, q)) ?? rec;
        const session = await (await env.driver()).open(found.url);
        let form: R.FormRead;
        try {
          form = await session.read();
        } finally {
          await session.close();
        }
        // Drafts rest on their own words; fit only on the event's page and the find.
        const words = await env.theirWords(userId);
        const bad = (drafts ?? []).map((d) => ({ d, why: R.draftProblem(d, words) })).filter((x) => x.why);
        if (bad.length) return { ok: false, error: `Fix the draft${bad.length > 1 ? "s" : ""} and call again: ${bad.map((b) => `${b.d.fieldId}: ${b.why}`).join("; ")}. Only from what they said; never invent motivation, credentials or agreement.` };
        const verified = [form.eventName, form.when, found.find.name, found.find.postText, found.find.read?.excerpt, found.find.details && JSON.stringify(found.find.details)].filter(Boolean).join("\n");
        const fitWhy = fit ? C.fitProblem(fit, verified) : null;
        if (fitWhy) return { ok: false, error: `Rewrite or drop the fit line and call again: ${fitWhy}.` };
        const known = new Set(form.fields.map((f) => f.id));
        rec = { ...rec, drafts: (drafts ?? []).filter((d) => known.has(d.fieldId)) };
        await S.moveRegistration(userId, rec.id, rec.status === "inspected" ? "inspected" : rec.status, { drafts: rec.drafts }, q);
        const a = await askFor(rec, form, facts, { fit: fit ?? null });
        const plan = R.planFill(form, facts, rec.answers, rec.drafts);
        return {
          ok: a.status !== "blocked",
          registrationId: rec.id,
          ask: a.status === "awaiting_yes" ? "submit" : a.status === "needs_answers" ? "answers" : "stopped",
          openQuestionsToDraft: plan.open.filter((o) => !o.draft).map((o) => ({ fieldId: o.fieldId, question: o.label })),
          ...said(a.text),
        };
      },
    }),

    saveRegistrationAnswers: tool({
      description: toolUse("saveRegistrationAnswers"),
      inputSchema: z.object({
        registrationId: z.string(),
        answers: z.array(z.object({ fieldId: z.string(), value: z.string(), from: z.enum(["their_words", "draft_as_shown"]) })).min(1),
        theirApproval: z.string().optional().describe("For a draft approved as shown: their words approving it, copied exactly."),
      }),
      execute: async ({ registrationId, answers, theirApproval }) => {
        await ready();
        const rec = await S.registrationById(userId, registrationId, q);
        if (!rec?.form) return { ok: false, error: "No registration like that is waiting on answers." };
        if (rec.status !== "needs_answers" && rec.status !== "awaiting_yes" && rec.status !== "needs_member_code") return { ok: false, error: `This registration is ${rec.status.replace(/_/g, " ")}; nothing to answer.` };
        const fieldIds = new Set(rec.form.fields.map((f) => f.id));
        const kept: R.Answers = { ...rec.answers };
        const refused: string[] = [];
        for (const a of answers) {
          if (!fieldIds.has(a.fieldId)) { refused.push(`${a.fieldId}: not on the form`); continue; }
          const f = rec.form.fields.find((x) => x.id === a.fieldId)!;
          if (f.kind === "marketing" || f.kind === "terms" || f.kind === "attestation") { refused.push(`${a.fieldId}: boxes aren't answers (terms need their yes to the submit question; mailing lists stay unchecked)`); continue; }
          if (a.from === "their_words") {
            if (!inTheirMessage(a.value, ctx.resolvedContent)) { refused.push(`${a.fieldId}: that value isn't in their message`); continue; }
            kept[a.fieldId] = { value: a.value.trim(), source: "member" };
          } else {
            const d = rec.drafts.find((x) => x.fieldId === a.fieldId);
            if (!d || normText(d.text) !== normText(a.value)) { refused.push(`${a.fieldId}: that isn't the draft they were shown`); continue; }
            const { yesIsTheirs } = await import("../services/theirYes.js");
            if (!yesIsTheirs(theirApproval, ctx.resolvedContent, userId)) { refused.push(`${a.fieldId}: their approval of the draft isn't in their message`); continue; }
            kept[a.fieldId] = { value: d.text, source: "draft_approved" };
          }
        }
        if (Object.keys(kept).length === Object.keys(rec.answers).length && refused.length) return { ok: false, error: `Nothing kept: ${refused.join("; ")}.` };
        const updated = (await S.moveRegistration(userId, rec.id, rec.status === "needs_member_code" ? "needs_member_code" : "needs_answers", { answers: kept }, q)) ?? { ...rec, answers: kept };
        const facts = await factsFor(updated);
        const held = env.takeHeld(rec.id);
        if (held) env.hold(rec.id, held);
        const a = await askFor(updated, rec.form, facts);
        return { ok: true, kept: Object.keys(kept).length, ...(refused.length ? { refused } : {}), registered: false, ...said(a.text) };
      },
    }),

    registerForEvent: tool({
      description: toolUse("registerForEvent"),
      inputSchema: z.object({ registrationId: z.string() }),
      execute: async ({ registrationId }) => {
        await ready();
        const rec = await S.registrationById(userId, registrationId, q);
        if (!rec) return { ok: false, error: "No registration like that." };
        const facts = await factsFor(rec);
        const status = S.effectiveStatus(rec, env.now().getTime());
        if (R.FINAL.has(status)) return { ok: true, status, ...said(C.outcomeLine(ctxFor(rec, null, facts), status as any, { link: rec.outcome?.link ?? rec.eventUrl })) };
        if (status === "needs_answers") {
          // Their answers were approved, but the submit question wasn't asked: ask it now. Never submit on a draft's approval.
          const a = rec.form ? await askFor(rec, rec.form, facts) : null;
          return { ok: false, error: "Not registered: approving an answer isn't a yes to register.", ...(a ? said(a.text) : {}) };
        }
        const yesAt = ctx.messageArrivedAt ? new Date(ctx.messageArrivedAt) : env.now();
        // The question their yes answers has to be in what Cue actually sent (its last sentence: the question itself).
        const asked = (text: string) => normText(ctx.recentExchange ?? "").includes(normText(text.split(/(?<=[.?])\s+/).filter((x) => /\?$/.test(x)).pop() ?? text));
        if (status === "uncertain") {
          // A retry only after they were told it's unconfirmed and said yes to trying again (asked after the first submit). Anything else
          // (a second yes to the old ask, a lost reply) gets the retry question, never a second submit.
          const retryAsked = rec.askKind === "submit" && rec.askedAt && rec.submitStartedAt && rec.askedAt > rec.submitStartedAt && rec.askText && asked(rec.askText);
          if (!retryAsked) {
            const t = C.retryAsk(ctxFor(rec, null, facts));
            await S.moveRegistration(userId, rec.id, "uncertain", { askKind: "submit", askText: t, askedAt: env.now() }, q);
            return { ok: false, error: "Not submitted again: the first try was never confirmed.", ...said(t) };
          }
          // Their yes to a retry is necessary, not sufficient: Luma's own state for their email is read first (signed in with their
          // emailed code), and only "not registered" lets the retry go.
          const session = await (await env.driver()).open(rec.eventUrl);
          let keep = false;
          try {
            const c = ctxFor(rec, null, facts);
            const st = await session.startSignIn(c.email);
            if (!st.ok || st.waitingFor !== "code") {
              notDone("Whether the first signup went through couldn't be confirmed: it was NOT submitted again.");
              return { ok: false, ...said(C.cannotConfirm(c)) };
            }
            return await waitForCode(rec, session, c, "code", "reconcile", () => { keep = true; });
          } finally {
            if (!keep) await session.close();
          }
        }
        if (!rec.askText || !C.SUBMIT_QUESTION.test(rec.askText)) return { ok: false, error: "Not registered: they haven't been asked the submit question." };
        if (!asked(rec.askText)) return { ok: false, error: "Not registered: the question their yes would answer isn't in the conversation. Send the ask first." };
        if (status !== "awaiting_yes") return { ok: false, error: `Not registered: the registration is ${status.replace(/_/g, " ")}.` };
        const session = await (await env.driver()).open(rec.eventUrl);
        return runSubmit(rec, session, { signedIn: false, yesAt });
      },
    }),

    stopEventRegistration: tool({
      description: toolUse("stopEventRegistration"),
      inputSchema: z.object({ registrationId: z.string() }),
      execute: async ({ registrationId }) => {
        await ready();
        const rec = await S.registrationById(userId, registrationId, q);
        if (!rec) return { ok: false, error: "No registration like that." };
        if (R.FINAL.has(rec.status) || rec.status === "submitting" || rec.status === "uncertain") return { ok: false, error: `It was already submitted (${rec.status.replace(/_/g, " ")}); Cue can't take it back. Say so plainly and share the event link so they can cancel there.` };
        env.takeHeld(rec.id)?.close();
        await S.moveRegistration(userId, rec.id, "withdrawn", {}, q);
        return { ok: true, note: "Stopped; nothing was submitted. Say so in a few words of your own." };
      },
    }),
  };

  // The code, once: never a tool input, never stored. The stored line it came in never had it (the route kept a placeholder).
  async function withCode(registrationId: string, code: string): Promise<Record<string, unknown>> {
    await ready();
    const rec = await S.registrationById(userId, registrationId, q);
    if (!rec) return { ok: false, error: "No signup is waiting on a code." };
    const facts = await factsFor(rec);
    const c = ctxFor(rec, null, facts);
    // It moved on since the code was caught (settled, expired): they still get the line for where it stands.
    if (rec.status !== "needs_member_code") return expired(rec, c);
    const session = env.takeHeld(rec.id);
    if (!session) {
      const submitted = rec.outcome?.detail === "after_submit";
      const reconciling = rec.outcome?.detail === "reconcile";
      await S.moveRegistration(userId, rec.id, submitted || reconciling ? "uncertain" : "inspected", {}, q);
      return { ok: false, ...said(reconciling ? C.cannotConfirm(c) : C.sessionExpired(c, submitted)) };
    }
    return useCode(rec, session, code, c);
  }

  return { tools, withCode };
}

async function R_codeFrom(rec: R.RegistrationRecord, env: RegistrationEnv) {
  const { codeFromSources } = await import("../services/eventRegistration/codeSources.js");
  return codeFromSources(rec.userId, new Date(env.now().getTime() - 10 * 60_000), env.codeSources);
}

let lostHooked = false;
// The real dependencies. Every read is bound to this member.
export async function realRegistrationEnv(): Promise<RegistrationEnv> {
  const { default: pool } = await import("../db/db.js");
  const { lumaDriver, holdSession, takeHeldSession, onHeldLost } = await import("../services/eventRegistration/lumaDriver.js");
  const { realResolveDeps } = await import("../services/eventRegistration/lumaFromFind.js");
  const { DEFAULT_CODE_SOURCES } = await import("../services/eventRegistration/codeSources.js");
  const { LUMA_LIVE_SUBMIT_APPROVED } = await import("../services/eventRegistration/approvals.js");
  const { loadKit } = await import("../services/memberKit.js");
  const { loadSentItems } = await import("../services/turnContext.js");
  const { notToTeammate } = await import("../services/teamLines.js");
  return {
    driver: async () => lumaDriver(),
    // Their account's name and email (never the placeholder a new member has) and what they told Cue about their work, saved only
    // from their own words (services/memberKit.ts).
    facts: async (userId) => {
      const kit = await loadKit(userId);
      const f: R.MemberFacts = {};
      const [first, ...rest] = String(kit.full_name ?? "").split(/\s+/).filter(Boolean);
      if (first && rest.length) { f.first_name = { value: first, source: "account" }; f.last_name = { value: rest.join(" "), source: "account" }; }
      if (kit.email) f.email = { value: kit.email, source: "account" };
      if (kit.city) f.city = { value: kit.city, source: "they_said" };
      if (kit.company) f.company = { value: kit.company, source: "they_said" };
      if (kit.role) f.job_title = { value: kit.role, source: "they_said" };
      if (kit.linkedin) f.linkedin = { value: kit.linkedin, source: "they_said" };
      return f;
    },
    theirWords: async (userId) => {
      const { rows } = await pool.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 80`, [userId]).catch(() => ({ rows: [] as any[] }));
      return rows.map((r: any) => String(r.content).replace(/^User said:\s*/i, "")).join("\n");
    },
    sentFinds: async (userId) => (await loadSentItems(userId)).map((x) => ({ key: x.key, name: x.name, url: x.url, postText: x.postText, read: x.read ? { finalUrl: x.read.finalUrl, excerpt: x.read.excerpt ?? null } : null, details: x.details ? { startAt: x.details.startAt, timezone: x.details.timezone, hosts: x.details.hosts } : null })),
    resolve: await realResolveDeps(),
    latestFromThemAt: async (userId) => {
      const { rows } = await pool.query(`SELECT MAX(created_at) AS at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()}`, [userId]).catch(() => ({ rows: [] as any[] }));
      return rows[0]?.at ? new Date(rows[0].at) : null;
    },
    codeSources: DEFAULT_CODE_SOURCES,
    liveSubmit: LUMA_LIVE_SUBMIT_APPROVED,
    // The code is used once; the stored line it came in is rewritten so it isn't kept (their thread, the last half hour only).
    redactCode: async (userId, code) => {
      await pool.query(
        `UPDATE co_memories SET content = replace(content, $2, '[code used]') WHERE user_id = $1 AND memory_type = 'text_exchange' AND created_at > NOW() - INTERVAL '30 minutes' AND position($2 in content) > 0`,
        [userId, code],
      );
    },
    hold: (id, s) => {
      // A browser that goes away loses the pages held on it: those registrations expire by stage (registrationStore.ts expireLostHold).
      if (!lostHooked) {
        lostHooked = true;
        onHeldLost((ids) => { for (const id of ids) void S.expireLostHold(id).catch(() => {}); });
      }
      return holdSession(id, s);
    },
    takeHeld: (id) => takeHeldSession(id),
    now: () => new Date(),
  };
}
