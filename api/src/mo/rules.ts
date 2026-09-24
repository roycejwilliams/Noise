// Mo's rules, in code, with no model and no DB, so evals/mo/rules.ts
// can pin every one of them. The model only proposes; these decide.
//
// The flow (FigJam "Mo" section, 2026-09-22): find → fit check →
// shortlist → a person approves → warm-up reply → wait → DM (or email, or a
// LinkedIn note sent by hand) → their reply → code → they text Co.

export const MO = {
  city: process.env.MO_CITY ?? "San Francisco",
  dailyCap: Number(process.env.MO_DAILY_CAP ?? 5),
  shortlistPerRun: 8,
  warmToDmDays: 2,
  followUpAfterDays: 7,
  closeAfterFollowUpDays: 7,
  maxReplyChars: 200,
  maxDmChars: 280,
  // Jacqueline's full intro (who Mo is, where, what Co is, fit, ask) is ~320.
  maxIntroDmChars: 420,
};

export function squash(s: string): string {
  return (s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

// The evidence has to be their own words, copied, and long enough to mean
// something.
export function quoteIsTheirs(quote: string, postText: string): boolean {
  const q = squash(quote);
  return q.split(" ").filter(Boolean).length >= 4 && squash(postText).includes(q);
}

// Somewhere Co runs events. Their profile location or the post itself has to
// say so; a guess from the bio isn't enough.
const CITY_WORDS: Record<string, RegExp> = {
  "San Francisco": /\b(san francisco|sf|s\.f\.|bay area|soma|mission district|the mission|oakland|berkeley|palo alto|silicon valley)\b/i,
};
export function inCity(location: string | null, postText: string, city = MO.city): boolean {
  const re = CITY_WORDS[city] ?? new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(location ?? "") || re.test(postText);
}

// Where they are (2026-09-23 live run: posts that only mention SF in passing,
// "after trips to SF", "from SF and Zurich", let in people in Switzerland,
// Germany and LA). A profile location outside the city rules them out; a
// profile location in the city is enough unless the judge says they're
// elsewhere; with no location, the judge has to place them in the city.
export function locationInCity(location: string | null, city = MO.city): boolean {
  const re = CITY_WORDS[city] ?? new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(location ?? "");
}
export function placeOk(location: string | null, judgeSaysInCity: boolean | undefined, city = MO.city): boolean {
  const loc = (location ?? "").trim();
  if (loc && !locationInCity(loc, city)) return false;
  if (loc) return judgeSaysInCity !== false;
  return judgeSaysInCity === true;
}

// Name or "they", never a guessed "he" or "she" (standing rule). The judge is
// told so; this catches what slips through in the reason approvers read.
export function neutralPronouns(text: string): string {
  const swaps: [RegExp, string][] = [
    [/\b(he|she) is\b/gi, "they are"],
    [/\b(he|she) was\b/gi, "they were"],
    [/\b(he|she) has\b/gi, "they have"],
    [/\b(he|she)'s\b/gi, "they're"],
    [/\b(himself|herself)\b/gi, "themself"],
    [/\b(his|hers)\b/gi, "their"],
    [/\bher(?=\s+[a-z])/gi, "their"],
    [/\b(him|her)\b/gi, "them"],
    [/\b(he|she)\b/gi, "they"],
  ];
  let out = text;
  for (const [re, to] of swaps) out = out.replace(re, (m) => (m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to));
  return out;
}
export function hasGenderedPronoun(text: string): boolean {
  return /\b(he|she|his|him|her|hers|himself|herself)\b/i.test(text);
}

// No member's name in anything Mo sends: the first name only counts when
// it isn't also the prospect's own name or a word in their own post.
export function namesAMember(text: string, members: { first: string; last: string | null }[], prospect: { name: string | null; postText: string }): string | null {
  const t = ` ${squash(text)} `;
  const own = squash(`${prospect.name ?? ""} ${prospect.postText}`);
  for (const m of members) {
    const first = squash(m.first);
    const last = squash(m.last ?? "");
    if (first.length < 3) continue;
    if (last.length >= 2 && t.includes(` ${first} ${last}`)) return `${m.first} ${m.last}`;
    if (new RegExp(`[^a-z]${first}[^a-z]`).test(t) && !new RegExp(`\\b${first}\\b`).test(own)) return m.first;
  }
  return null;
}

export type DraftCheck = { name: string; pass: boolean; reason?: string };

export function checkMoDraft(kind: "reply" | "dm" | "email" | "why", text: string, opts: { dmMax?: number } = {}): DraftCheck[] {
  const checks: DraftCheck[] = [
    { name: `${kind}_not_empty`, pass: text.trim().length > 0 },
    { name: `${kind}_no_em_dash`, pass: !/[—–]/.test(text) },
    { name: `${kind}_no_exclamation_pileup`, pass: !/!{2,}/.test(text) },
  ];
  if (kind === "reply") {
    checks.push({ name: "reply_length", pass: text.length <= MO.maxReplyChars, reason: `${text.length} chars` });
    checks.push({ name: "reply_no_link", pass: !/https?:\/\/|www\./i.test(text) });
    // The warm-up is about their post, not a pitch.
    checks.push({ name: "reply_no_pitch", pass: !/\b(invite|invitation|club|member|join|dm me|check your dms)\b/i.test(text) });
  }
  if (kind === "dm") {
    checks.push({ name: "dm_length", pass: text.length <= (opts.dmMax ?? MO.maxDmChars), reason: `${text.length} chars` });
    checks.push({ name: "dm_no_link", pass: !/https?:\/\/|www\./i.test(text) });
    // The code only goes out after they say yes.
    checks.push({ name: "dm_no_code", pass: !/\b[A-HJ-NP-Z2-9]{8}\b/.test(text) });
    checks.push({ name: "dm_asks", pass: /\?\s*$/.test(text.trim()), reason: "ends by asking if they'd like an invite" });
    // Mo reaches out as itself (2026-09-24).
    checks.push({ name: "dm_says_its_mo", pass: /\bI['’]?m Mo\b/.test(text), reason: "introduces itself as Mo" });
  }
  if (kind === "why") {
    checks.push({ name: "why_length", pass: text.length <= 260, reason: `${text.length} chars` });
    checks.push({ name: "why_no_link", pass: !/https?:\/\/|www\./i.test(text) });
    checks.push({ name: "why_no_code", pass: !/\b[A-HJ-NP-Z2-9]{8}\b/.test(text) });
  }
  if (kind === "email") {
    checks.push({ name: "email_has_code_slot", pass: text.includes("{{CODE}}") });
    checks.push({ name: "email_has_phone_slot", pass: text.includes("{{PHONE}}") });
    // Their post goes into the draft prompt, so a planted link could come
    // back out; the only link an invite email carries is the opt-out we add.
    checks.push({ name: "email_no_link", pass: !/https?:\/\/|www\./i.test(text) });
    checks.push({ name: "email_length", pass: text.length <= 900, reason: `${text.length} chars` });
  }
  return checks;
}

// An approver's plain answer (2026-09-22: no command syntax). Anything that
// isn't clearly one of these is read by a model against what was asked, and
// a text about something else goes to Co as usual.
export function plainYes(text: string): boolean {
  return /^\s*(yes|yeah|yep|yup|sure|ok|okay|go|go ahead|do it|send it|approve|approved|looks good|love it|perfect|👍)\b[\s.!]*$/i.test(text) || /^\s*(yes|yeah|yep|sure|ok|okay)[,.!]?\s+(go ahead|send it|do it|reach out|looks good)[\s.!]*$/i.test(text);
}
export function plainNo(text: string): boolean {
  return /^\s*(no|nope|nah|skip|pass|skip (them|him|her|this one)|not this one|no thanks)\b[\s.!]*$/i.test(text);
}
export function plainDone(text: string): boolean {
  return /^\s*(sent|done|sent it|it'?s sent|i sent it|posted|all set)\b[\s.!]*$/i.test(text);
}

// Their DM reply. A clear stop always wins, in code, before any model read.
export function clearStop(text: string): boolean {
  return /\b(stop|unsubscribe|not interested|no thanks|no thank you|leave me alone|remove me|don'?t (message|dm|contact) me|pass)\b/i.test(text) || /^\s*no\.?\s*$/i.test(text);
}
export function clearYes(text: string): boolean {
  return !clearStop(text) && /^\s*(yes|yeah|yep|sure|absolutely|definitely|i'?m in|count me in|would love (one|that|to)|send (it|one)|please|down|let'?s do it)\b/i.test(text);
}

export type ProspectClock = {
  status: string;
  channel: string | null;
  warmedAt: Date | null;
  contactedAt: Date | null;
  followedUpAt: Date | null;
  lastInboundAt: Date | null;
};

// What the outreach tick should do next for one prospect.
export type NextStep = "warm" | "contact" | "follow_up" | "close_silent" | null;

export function nextOutreachStep(p: ProspectClock, now: Date): NextStep {
  const days = (d: Date | null) => (d ? (now.getTime() - d.getTime()) / 86400_000 : Infinity);
  if (p.status === "approved" && !p.warmedAt) return "warm";
  if (p.status === "warmed" && days(p.warmedAt) >= MO.warmToDmDays) return "contact";
  if (p.status === "contacted" && p.channel !== "manual" && !p.followedUpAt && !p.lastInboundAt && days(p.contactedAt) >= MO.followUpAfterDays) return "follow_up";
  if (p.status === "contacted" && p.followedUpAt && !p.lastInboundAt && days(p.followedUpAt) >= MO.closeAfterFollowUpDays) return "close_silent";
  return null;
}

// Keys on the do-not-contact list.
export function suppressionKeys(p: { x_user_id?: string | null; email?: string | null; linkedin_url?: string | null }): string[] {
  return [
    p.x_user_id ? `x:${p.x_user_id}` : null,
    p.email ? `email:${p.email.trim().toLowerCase()}` : null,
    p.linkedin_url ? `li:${p.linkedin_url.trim().toLowerCase().replace(/\/+$/, "")}` : null,
  ].filter((k): k is string => Boolean(k));
}
