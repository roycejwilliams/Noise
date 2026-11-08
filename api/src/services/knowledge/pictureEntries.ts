// The picture's opt-in sections as dated, provenance-tagged entries (Cue Memory Spec step 6). One pure renderer for the member's own
// readers: the text reply's snapshot (services/memberSnapshot.ts) and the call's context (services/callContext.ts), so a call and a
// text see the same sections in the same shape: "- [id prov date] words".
//
// Input is a MemberKnowledge read with include of "transitions", "events", "people" and/or "learned". That read is already guarded
// (removals), name-stripped, and bounded by each section's own character budget; nothing here reads a store.
//
// Rules:
//   - every entry has an id, a source (the table or ref it came from), a date (null only when the source has none), and a provenance
//     tag: said (their words), seen (Cue observed it), did (Cue's own act), inferred (Cue's read);
//   - an inferred entry is written tentatively ("Seems to be ...", "Cue's read, not theirs: ..."): it never reads as settled fact;
//   - a section that could not be read says so ("Couldn't read X right now"), which is different from "none". A section that was read
//     and is empty renders nothing;
//   - names: a person's name is NOT rendered here at all, even after a double yes (no names in text or calls for now; names for double-yes
//     pairs come in a later PR). Their own quotes are cleaned field by field by the caller's policy (clean), so a stripped quote keeps
//     its entry;
//   - private knowledge is the member's own: these entries go to this member's own reply and call paths only (see the PR body).
//   - order within a section is relevance (open and in-flight first, then newest), as the section built it; the snapshot trims from the
//     end when over budget.
import { DateTime } from "luxon";
import { createHash } from "node:crypto";
import type { MemberKnowledge } from "../memberKnowledge.js";

export type PicProv = "said" | "seen" | "did" | "inferred";
export type PicSection = "transitions" | "events" | "people" | "learned";
export type PicEntry = { section: PicSection; id: string; src: string; date: string | null; prov: PicProv; text: string; open: boolean; kind: string };
export type PicRead = { entries: PicEntry[]; unread: PicSection[]; omitted: Partial<Record<PicSection, number>> };

const hash8 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 8);
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "").slice(0, 24) || hash8(s);
const one = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const q = (s: string) => `"${clip(one(s), 240)}"`;
const day = (iso: string | null | undefined, tz: string): string | null => {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const t = DateTime.fromISO(iso, { zone: "utc" });
  return t.isValid ? t.setZone(tz).toISODate() : null;
};

export const PIC_TITLES: Record<PicSection, string> = {
  transitions: "What they're going through",
  events: "Events: plans, attendance, outcomes",
  people: "People: introductions and how they went",
  learned: "What Cue has learned",
};
// The line a section says when its read failed. Never "none".
export const unreadLine = (s: PicSection) => `Couldn't read their ${PIC_TITLES[s].toLowerCase()} right now. That is not the same as there being none: don't say there is nothing, and don't guess.`;

export const picLine = (e: Pick<PicEntry, "id" | "prov" | "date" | "text">) => `- [${e.id} ${e.prov}${e.date ? ` ${e.date}` : ""}] ${e.text}`;

// Pure: the sections' entries from a knowledge read. Sections not asked for (undefined arrays) give nothing and no unread line.
// clean: applied to every free-text field of THEIR own words (quotes, corrected values, event and place names) on its own, before the
// entry is assembled, so a name in a quote is taken out of that quote and the entry (and its id) stays. The caller's policy (the
// snapshot's name fence, the same for calls) decides what clean does; nothing here writes its own strip.
// Labels are neutral and third person ("a plan to go to X, date"); Cue phrases them.
const RESULT_WORDS: Record<string, string> = { helped: "they said it helped", didnt_help: "they said it didn't help" };
const STAGE_WORDS: Record<string, string> = {
  suggested_no_answer: "Cue suggested them; no answer yet",
  asked_for_intro: "they asked for the introduction; not made yet",
  said_yes_no_answer_yet: "they said yes; the other side hasn't answered",
  declined_by_you: "they said no",
  closed: "it didn't go forward",
  both_yes: "both said yes; the introduction is on its way",
  introduced: "introduced",
  met: "they met",
  already_knew: "they already know them",
};
const KEPT_WORDS: Record<string, string> = { yes: "yes", not_yet: "not yet", no: "no" };

export function pictureEntries(k: MemberKnowledge, o: { skip?: (kind: "lesson" | "correction" | "avoid" | "availability", key: string) => boolean; clean?: (s: string) => string } = {}): PicRead {
  const tz = k.identity.timeZone;
  const entries: PicEntry[] = [];
  const unread: PicSection[] = [];
  const skip = o.skip ?? (() => false);
  const cl = (s: string | null | undefined) => one(o.clean ? o.clean(one(s)) : one(s));
  // Their words, cleaned on their own: "" when nothing is left of them.
  const said = (s: string | null | undefined) => {
    const c = cl(s);
    return c ? ` (their words: ${q(c)})` : "";
  };
  const add = (e: PicEntry) => {
    if (one(e.text)) entries.push({ ...e, text: one(e.text) });
  };

  // ---- transitions (member_threads rows of kind transition)
  if (k.transitions) {
    if (k.guardsUnread || k.transitionsUnread) unread.push("transitions");
    for (const t of k.transitions) {
      const open = t.status === "open" || t.status === "waiting";
      const prov: PicProv = t.source === "inferred" ? "inferred" : "said";
      const lead = prov === "inferred" ? `Seems to be going through (${t.status})` : `Going through (${t.status}${t.closedOn ? ` ${t.closedOn}` : ""})`;
      const via = t.channel ? `, over ${t.channel === "call" ? "a call" : "text"}` : "";
      const corr = t.corrections.map((c) => `corrected ${day(c.at, tz) ?? "earlier"}: was ${q(cl(c.was))}${c.now === null ? ", now removed" : `, now ${q(cl(c.now))}`}${said(c.quote)}`);
      const more = t.correctionsOmitted ? `; ${t.correctionsOmitted} earlier correction${t.correctionsOmitted === 1 ? "" : "s"} not shown` : "";
      add({
        section: "transitions",
        id: `Tr${slug(t.id)}`,
        src: `member_threads:${t.id}`,
        date: day(t.verifiedAt, tz) ?? t.openedOn,
        prov,
        text: `${lead}${via}: ${t.text}${said(t.quote)}${corr.length ? ` [${corr.join("; ")}${more}]` : more ? ` [${more.slice(2)}]` : ""}`,
        open,
        kind: "transition",
      });
    }
  }

  // ---- events
  if (k.events) {
    if (k.eventsUnread) unread.push("events");
    for (const ev of k.events) {
      const base = `Ev${slug(ev.id)}`;
      const name = cl(ev.name);
      const nm = name ? q(name) : "an event";
      const upcoming = ev.when === "upcoming";
      const when = ev.date ? `, ${ev.date}` : "";
      if (ev.plan) {
        const inferred = ev.plan.prov === "inferred";
        add({ section: "events", id: `${base}p`, src: ev.plan.source, date: day(ev.plan.on, tz), prov: ev.plan.prov, text: `${inferred ? "Seems to be a plan to go to" : "A plan to go to"} ${nm}${when}${said(ev.plan.quote)}`, open: upcoming, kind: "plan" });
      }
      if (ev.offered) add({ section: "events", id: `${base}o`, src: ev.offered.source, date: day(ev.offered.on, tz), prov: "did", text: `Cue offered ${nm}${when}`, open: upcoming, kind: "offered" });
      if (ev.attendance) {
        const a = ev.attendance;
        const how = a.via === "door" ? "checked in at the door" : a.via === "location" ? "their location put them there" : a.via === "text" ? "said by text" : a.via === "said" ? "said so after it started" : "";
        add({ section: "events", id: `${base}a`, src: a.source, date: day(a.on, tz), prov: a.prov, text: `${a.state === "attended" ? "Attended" : "Not going to"} ${nm}${when}${how ? ` (${how})` : ""}${said(a.quote)}`, open: false, kind: a.state });
      }
      ev.outcomes.forEach((o2, i) => {
        const inferred = o2.prov === "inferred";
        const words = RESULT_WORDS[o2.result] ?? "an outcome was recorded";
        add({ section: "events", id: `${base}r${i + 1}`, src: o2.source, date: day(o2.on, tz), prov: o2.prov, text: `${inferred ? "Cue's read, not theirs: " : ""}about the suggestion ${nm}: ${words}${said(o2.quote)}`, open: false, kind: "outcome" });
      });
      if (ev.outcomesOmitted) add({ section: "events", id: `${base}more`, src: "event_outcomes", date: null, prov: "seen", text: `${ev.outcomesOmitted} more outcome${ev.outcomesOmitted === 1 ? "" : "s"} for ${nm} not shown`, open: false, kind: "omitted" });
      if (ev.met) add({ section: "events", id: `${base}m`, src: ev.met.source, date: day(ev.met.on, tz), prov: "said", text: `They said they met someone at ${nm}${said(ev.met.quote)}`, open: false, kind: "met" });
      if (ev.followedUp) add({ section: "events", id: `${base}f`, src: ev.followedUp.source, date: day(ev.followedUp.on, tz), prov: "did", text: `Cue followed up with ${ev.followedUp.people} ${ev.followedUp.people === 1 ? "person" : "people"} after ${nm}`, open: false, kind: "followed_up" });
    }
  }

  // ---- people (their side only; no names for now, even after a double yes)
  if (k.people) {
    if (k.peopleUnread) unread.push("people");
    for (const p of k.people) {
      const open = p.stage !== "met" && p.stage !== "closed" && p.stage !== "declined_by_you" && p.stage !== "already_knew";
      const o3 = p.outcome;
      const stated = !!(o3 && (o3.quote || o3.met || o3.useful || o3.keptTalking)) || p.stage === "already_knew";
      const at = cl(p.where) ? ` at ${cl(p.where)}` : "";
      const label =
        p.how === "matched_at_event" ? `Cue matched them with someone${at}`
        : p.how === "intro_via_network" ? "Cue suggested someone from the network"
        : p.how === "asked_for_intro" ? `They asked to be introduced to someone${at}`
        : p.how === "already_knew" ? "They told Cue they already know someone"
        : "Cue introduced them to someone";
      const outcome = o3 ? [o3.met ? `met ${o3.met}` : null, o3.useful ? `useful ${o3.useful}` : null, o3.keptTalking ? `kept talking ${KEPT_WORDS[o3.keptTalking]}` : null].filter(Boolean).join(", ") : "";
      const words = said(o3?.quote ?? p.quote);
      add({
        section: "people",
        id: `Pe${slug(p.id)}`,
        src: p.id.startsWith("pair:") ? `co_pairs:${p.id.split(":")[1] ?? ""}` : p.id.startsWith("knows:") ? `known_connections:${p.id.slice(6)}` : "people",
        date: o3?.on ?? day(p.verifiedAt, tz),
        prov: stated ? "said" : "did",
        text: `${label}. Status: ${STAGE_WORDS[p.stage] ?? p.stage}.${outcome ? ` They said: ${outcome}.` : ""}${p.moreLikeThem ? ` They want ${p.moreLikeThem === "yes" ? "more" : "fewer"} people like this.` : ""}${words}`,
        open,
        kind: "person",
      });
    }
  }

  // ---- what Cue learned (lessons, corrections, limits)
  const learnedOn = !!(k.learnedLessons || k.learnedCorrections || k.learnedLimits || k.learnedUnread);
  if (learnedOn) {
    if (k.learnedUnread) unread.push("learned");
    for (const l of k.learnedLessons ?? []) {
      if (skip("lesson", l.text)) continue;
      add({ section: "learned", id: `Ln${slug(l.id)}`, src: `co_memories:${l.source.memoryId}`, date: day(l.verifiedAt, tz), prov: "inferred", text: `Cue's read from their pushback, not their words: ${l.text}${l.qualifiedBy ? ` [qualified since: ${l.qualifiedBy}]` : ""}`, open: false, kind: "lesson" });
    }
    for (const c of k.learnedCorrections ?? []) {
      if (skip("correction", `${c.field}|${c.was}|${c.now ?? ""}`)) continue;
      add({
        section: "learned",
        id: `Lc${slug(c.id)}`,
        src: `profile_corrections:${c.id}`,
        date: day(c.verifiedAt, tz),
        prov: "said",
        text: `Corrected ${c.field}${c.item ? ` (${cl(c.item)})` : ""}: was ${q(cl(c.was))}, now ${c.now == null ? "(removed)" : q(cl(c.now))}${said(c.theirWords)}${c.qualifiedBy ? ` [qualified since: ${c.qualifiedBy}]` : ""}`,
        open: false,
        kind: "correction",
      });
    }
    const lim = k.learnedLimits;
    if (lim) {
      for (const a of lim.avoid) if (!skip("avoid", a.text)) add({ section: "learned", id: `Lv${hash8(a.text)}`, src: "co_profiles:avoid", date: null, prov: "said", text: `Not for them: ${a.text}`, open: false, kind: "limit" });
      for (const r of lim.rules) {
        add({ section: "learned", id: `Lr${slug(r.id)}`, src: `member_rules:${r.id}`, date: r.dated ? day(r.verifiedAt, tz) : null, prov: "said", text: `Rule (${r.area}): ${r.text}${r.basis ? ` [${r.basis}]` : ""}${r.expiresAt ? ` [until ${day(r.expiresAt, tz) ?? r.expiresAt}]` : ""}${r.dated ? "" : " [date unknown]"}`, open: false, kind: "rule" });
      }
      if (lim.availability && !skip("availability", lim.availability)) add({ section: "learned", id: "Lfree", src: "co_profiles:availability", date: null, prov: "said", text: `Usually free: ${lim.availability}`, open: false, kind: "limit" });
    }
  }

  const omitted: PicRead["omitted"] = {};
  if (k.transitionsOmitted) omitted.transitions = k.transitionsOmitted;
  if (k.eventsOmitted) omitted.events = k.eventsOmitted;
  if (k.peopleOmitted) omitted.people = k.peopleOmitted;
  const lo = (k.learnedLessonsOmitted ?? 0) + (k.learnedCorrectionsOmitted ?? 0);
  if (lo) omitted.learned = lo;
  return { entries, unread, omitted };
}
