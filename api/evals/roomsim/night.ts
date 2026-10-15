// The room simulation (Royce, 2026-10-14: "Room sim first because everything after it gets tested there"). A whole event night at
// realistic size, through the REAL in-room code path (eventScoring -> the share gate -> nudge -> reply -> direct ask -> intro), on the
// fake world the in-room flow eval uses (evals/inroom/world.ts: an in-memory database, stubbed Luma, Anthropic and Sendblue; nothing
// is sent, no database is touched). Invented people only, test-range numbers, zero tokens.
//
// What it plants (deterministic from a seed):
//   - true pairs: someone seeking X and someone offering X, with a specific, true reason; the stub scorer rates them high
//   - near misses: the same words in a different sense (a climate policy writer is not a climate hardware investor); rated below the bar
//   - hard traps: near misses the scorer is fooled by (rated just over the bar), to see what the gates after the score do with them
//   - members who must never be named or quoted: private asks (not shareable), opted out of texts, archived
//   - members with no ask at all, and members who decline or never answer
// Then the night runs in arrival waves, each wave re-scoring the room, and every open question is answered at once (Promise.all), some
// yeses sent twice. The fake database answers every query in one tick (locks and transactions are no-ops), so replies interleave in
// lock-step: this finds ordering holes, not races that need real database or model latency. One seed per room size.
// The other person only answers a direct ask they were actually sent. The scorecard counts what Cue did against what was planted.
//
//   npx tsx evals/roomsim/night.ts            (layer 1: nights of 25, 60 and 120)
//
// check()    = must hold today (a FAIL is a regression).
// baseline() = a number the strict double opt-in work must move (Royce's order: no name before both say yes, the why lives in the
//              connection, one decline store, the quality gate everywhere). Printed, never failing, until that work lands.
import { W, reset, addMember, addEvent, ask, check, finding, results, latency, memberTurn, lockStats, type Member } from "../inroom/world.js";

// Every ask in the room is unique (a short reference on the end), so the stub scorer always knows exactly who is asking and a
// private ask can never be mistaken for someone else's identical public one.
const uniq = (text: string, i: number) => `${text} (ref ${i})`;

// The clock is pinned to 18:00 UTC (as evals/inroom/flow.ts): members with no zone may be texted 16:00-24:00 UTC.
// advance(ms) moves the pinned clock forward (the end of the night runs later than the arrivals).
const clock = { offset: 0 };
const advance = (ms: number) => {
  clock.offset += ms;
};
{
  const RealDate = Date;
  const pinned = new RealDate();
  pinned.setUTCHours(18, 0, 0, 0);
  clock.offset = pinned.getTime() - RealDate.now();
  class PinnedDate extends RealDate {
    constructor(...a: any[]) {
      super(...((a.length ? a : [RealDate.now() + clock.offset]) as [any]));
    }
    static now() {
      return RealDate.now() + clock.offset;
    }
  }
  (globalThis as any).Date = PinnedDate;
}

const S = await import("../../src/services/eventScoring.js");
const H = await import("../../src/services/eventGuestMatchHandoff.js");
const WK = await import("../../src/services/eventWalkinCheckin.js");
const U = await import("../../src/services/eventUnmatchedFollowUp.js");
const RM = await import("../../src/services/roomMatching.js");

// ---------------------------------------------------------------- deterministic randomness
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the room: domains, each with a seeking side, an offering side, and a
// near miss that shares its words but not its meaning.
const DOMAINS = [
  { seek: "a seed investor for a climate hardware startup", offer: "backing climate hardware founders at seed", near: "writing about climate policy for a newsletter" },
  { seek: "a product designer for a fintech app", offer: "design work on fintech apps", near: "a fintech app to manage my own budget" },
  { seek: "a technical cofounder with machine learning depth", offer: "joining an early machine learning startup as a cofounder", near: "learning machine learning basics on weekends" },
  { seek: "a ceramics studio to share", offer: "spare studio space for a ceramicist", near: "buying handmade ceramics for a new apartment" },
  { seek: "a running partner for weekend long runs", offer: "company on weekend long runs", near: "running a weekend market stall" },
  { seek: "a sommelier for a monthly supper club", offer: "pairing wine for small private dinners", near: "a supper club to join as a guest" },
  { seek: "an angel investor in edtech", offer: "investing in early edtech founders", near: "an edtech tool for my kids" },
  { seek: "a growth marketer for a consumer app", offer: "growth work on consumer apps", near: "growing my personal following" },
  { seek: "a photographer for a book launch", offer: "shooting launches and portraits", near: "a book club about photography" },
  { seek: "a mentor who has scaled a marketplace", offer: "mentoring marketplace founders", near: "selling furniture on a marketplace" },
  { seek: "a speaker on urban housing policy", offer: "giving talks on housing policy", near: "finding a house to rent in the city" },
  { seek: "a jazz pianist to sit in on sessions", offer: "hosting jazz jam sessions that need a pianist", near: "jazz records for a listening party" },
];
const NAMES = ["Jordan", "Noor", "Ellis", "Sarah Hao", "Rina", "Theo", "Mara", "Dev", "Lena", "Omar", "Ivy", "Kai", "Bea", "Felix", "Zara", "Quinn", "Hugo", "Ada", "Remy", "Tess", "Nico", "Juno", "Ezra", "Lark"];

type Planted = {
  members: Member[];
  truePairs: [string, string][]; // [seekerId, offererId]
  oneSided: Set<string>; // true pairs only the seeker's side scores high: the other hears of it only by a direct ask
  nearPairs: [string, string][];
  hardTraps: [string, string][];
  privateAskText: Map<string, string>; // member id -> their non-shareable ask
  optedOut: Set<string>;
  noAsk: Set<string>;
};

function plant(size: number, seed: number): Planted {
  const r = rng(seed);
  const p: Planted = { members: [], truePairs: [], oneSided: new Set(), nearPairs: [], hardTraps: [], privateAskText: new Map(), optedOut: new Set(), noAsk: new Set() };
  const name = (i: number) => `${NAMES[i % NAMES.length]}${i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ""}`;
  let i = 0;
  const add = (m: Parameters<typeof addMember>[0]) => {
    const made = addMember(m);
    p.members.push(made);
    return made;
  };
  // About 40% of the room in true pairs, 15% near misses, 5% hard traps, the rest private asks, no asks and opt-outs.
  const pairs = Math.max(2, Math.round((size * 0.4) / 2));
  for (let k = 0; k < pairs; k++) {
    const d = DOMAINS[k % DOMAINS.length];
    const a = add({ first_name: name(i), intent: [ask(uniq(d.seek, i++))] });
    // Every third offering side keeps its ask private: a real match Cue may make, whose ask must never be quoted to the seeker.
    const secret = k % 3 === 2;
    const offerText = uniq(secret ? `${d.offer}, kept private` : d.offer, i);
    const b = add({ first_name: name(i++), intent: [ask(offerText, "offering", !secret)] });
    if (secret) p.privateAskText.set(b.id, offerText);
    p.truePairs.push([a.id, b.id]);
    if (k % 3 === 1) p.oneSided.add(`${a.id}|${b.id}`);
  }
  const nears = Math.max(1, Math.round(size * 0.15));
  for (let k = 0; k < nears && i < size; k++) {
    const d = DOMAINS[(k + 3) % DOMAINS.length];
    const offerer = p.members.find((m) => String((m.intent as any[])?.[0]?.text ?? "").startsWith(d.offer)) ?? add({ first_name: name(i), intent: [ask(uniq(d.offer, i++), "offering")] });
    const n = add({ first_name: name(i), intent: [ask(uniq(d.near, i++))] });
    p.nearPairs.push([n.id, offerer.id]);
  }
  const traps = Math.max(1, Math.round(size * 0.05));
  for (let k = 0; k < traps && i < size; k++) {
    const d = DOMAINS[(k + 7) % DOMAINS.length];
    const offerer = p.members.find((m) => String((m.intent as any[])?.[0]?.text ?? "").startsWith(d.offer)) ?? add({ first_name: name(i), intent: [ask(uniq(d.offer, i++), "offering")] });
    const t = add({ first_name: name(i), intent: [ask(uniq(d.near, i++))] });
    p.hardTraps.push([t.id, offerer.id]);
  }
  while (i < size) {
    const roll = r();
    if (roll < 0.35) {
      const text = uniq(`${DOMAINS[Math.floor(r() * DOMAINS.length)].seek}, kept private`, i);
      const m = add({ first_name: name(i++), intent: [ask(text, "seeking", false)] });
      p.privateAskText.set(m.id, text);
    } else if (roll < 0.55) {
      const m = add({ first_name: name(i), sms_opted_out: true, intent: [ask(uniq(DOMAINS[Math.floor(r() * DOMAINS.length)].seek, i++))] });
      p.optedOut.add(m.id);
    } else {
      const m = add({ first_name: name(i++) });
      p.noAsk.add(m.id);
    }
  }
  return p;
}

// The stub scorer reads the planted truth: true pairs high, hard traps just over the bar, near misses under it, the rest near zero.
function scorerFrom(p: Planted, r: () => number) {
  const key = (a: string, b: string) => `${a}|${b}`;
  const score = new Map<string, number>();
  for (const [a, b] of p.truePairs) {
    score.set(key(a, b), 80 + Math.floor(r() * 15));
    score.set(key(b, a), p.oneSided.has(key(a, b)) ? 20 + Math.floor(r() * 10) : 78 + Math.floor(r() * 15));
  }
  for (const [a, b] of p.hardTraps) score.set(key(a, b), 61 + Math.floor(r() * 4));
  for (const [a, b] of p.nearPairs) score.set(key(a, b), 40 + Math.floor(r() * 18));
  const byAsk = new Map<string, string>();
  for (const m of p.members) for (const it of (m.intent as any[]) ?? []) byAsk.set(String(it.text), m.id);
  W.scorer = (askText, cand) => {
    const asker = [...byAsk.entries()].find(([t]) => askText.includes(t))?.[1];
    return { score: asker ? score.get(key(asker, cand.id)) ?? Math.floor(r() * 20) : 0, share: true };
  };
}

// ---------------------------------------------------------------- one night
type Card = {
  size: number;
  nudges: number;
  namedBeforeYes: number;
  trueFound: number;
  trueProposed: number;
  trueTotal: number;
  nearProposed: number;
  trapsProposed: number;
  trapsIntroduced: number;
  intros: number;
  introsViaAsk: number;
  duplicateIntros: number;
  duplicateAsks: number;
  privateQuoted: number;
  privateProposed: number;
  optedOutTexted: number;
  textsMax: number;
  leftWithNothing: number;
  unknownSql: number;
  nudgedBeforeArrival: number;
  noShowsTexted: number;
  noShowsProposed: number;
  textedAfterStop: number;
  stoppers: number;
  walkIns: number;
  walkInsProposed: number;
  closeSent: number;
  closeOwed: number;
  closeDuplicates: number;
  closeToStopped: number;
  closeToNoShow: number;
  closeMatchTalk: number;
  roomClosed: boolean;
  openAfterClose: number;
  pairsWaitingAfterClose: number;
  lateTexts: number;
  lateIntros: number;
  debriefsScheduled: number;
  expiredAtClose: number;
};

async function night(size: number, seed: number, rates = { yes: 0.6, no: 0.2 }): Promise<Card> {
  reset();
  const r = rng(seed * 7 + 1);
  const p = plant(size, seed);
  scorerFrom(p, r);
  const evId = `evt-sim-${size}-${seed}`;
  const evName = "Noise Supper";
  const byId = new Map(p.members.map((m) => [m.id, m]));
  const asMNC = (m: Member) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number!, email: m.email });
  const answered = new Set<string>(); // `${person}|${candidate}`
  const viaAsk = new Set<string>(); // pairs where the other person answered a direct ask they were sent
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A direct ask from a to b, as b's phone got it (the stub drafter: "<a> from <event> would like an intro").
  const askedDirectly = (a: Member, b: Member) => W.sent.some((s) => s.to === b.phone_number && new RegExp(`^${esc(a.first_name)} from .* would like an intro`).test(s.content));

  // Real timing (sim gap A1): every query waits 0-6 seeded milliseconds, so a read and the write after it can interleave with
  // another reply's, the way two Postgres round trips can. Each member's own replies run one at a time (routes/sendblue.ts holds a
  // lock per phone); different members' replies, and the next arrival wave's scoring pass, all run at once.
  const lr = rng(seed * 13 + 5);
  latency.next = () => Math.floor(lr() * 7);
  // A reply is a text, handled the way the text route handles it (routes/sendblue.ts): their words are logged first (also the
  // end-of-night close's evidence they came), then the open question it answers is looked up (eventGuestMatchHandoff.ts
  // findPendingMatchNudge: their most recent open one; nothing once it expired or the room closed), and the yes or no goes to
  // that question, whoever it's about. No open question: it's just a text, and nothing in matching moves. The additive offer's
  // answer goes to its own handler. (Sim gap B1, the part that decides what a reply binds to; the reading of the words is the
  // classifier's, stubbed here as a clean yes or no.)
  let unbound = 0;
  const reply = (who: Member, _meant: Member, answer: "interested" | "not_interested") =>
    memberTurn(who.id, async () => {
      W.memoriesWritten.push({ user_id: who.id, memory_type: "text_exchange", content: `User said: ${answer === "interested" ? "yes" : "no thanks"}`, created_at: new Date() });
      const pending = await H.findPendingMatchNudge(who.id);
      if (!pending) {
        unbound++;
        return;
      }
      if (pending.kind === "additive") {
        await H.handleAdditiveReply(pending.event_id, pending.event_name, answer as any, asMNC(who), pending.candidate_ids ?? []);
        return;
      }
      await H.handleMatchNudgeReply(pending.event_id, pending.event_name, answer as any, asMNC(who), { user_id: pending.candidate_id, first_name: pending.candidate_first_name, phone_number: pending.candidate_phone, email: pending.candidate_email });
    });
  const stoppedAt = new Map<string, number>(); // member id -> W.sent length when they texted stop
  const silentAsks: [Member, Member][] = []; // [asked, asker]: a direct ask nobody answered tonight
  const answerOpen = (): Promise<void>[] => {
    // Everyone with an open nudge answers: yes, no, or silence. Someone who texted stop never answers again.
    const open = W.nudges.filter((n) => n.event_id === evId && n.candidate_id && !answered.has(`${n.person_id}|${n.candidate_id}`));
    const replies: Promise<void>[] = [];
    for (const n of open) {
      answered.add(`${n.person_id}|${n.candidate_id}`);
      const a = byId.get(n.person_id)!;
      const b = byId.get(n.candidate_id)!;
      if (stoppedAt.has(a.id)) continue;
      const roll = r();
      if (roll < rates.yes) {
        // Some yeses arrive twice at once (a double tap, a resend): the pair record, not luck, has to keep it one ask.
        const twice = r() < 0.3;
        const yes = () => reply(a, b, "interested"); // routed like the text route (findPendingMatchNudge)
        replies.push(
          Promise.all(twice ? [yes(), yes()] : [yes()]).then(async () => {
            await new Promise((res) => setTimeout(res, 5));
            // The other side answers only a direct ask that reached them: a true pair says yes at the same rate, anyone else mostly no,
            // and one in five never answers (it's still open when the room closes).
            if (!askedDirectly(a, b) || answered.has(`${b.id}|${a.id}`)) return;
            const isTrue = p.truePairs.some(([x, y]) => (x === a.id && y === b.id) || (x === b.id && y === a.id));
            const yesB = r() < (isTrue ? rates.yes : 0.25);
            const silent = r() < 0.2;
            if (stoppedAt.has(b.id)) return; // they texted stop: they answer nothing more
            answered.add(`${b.id}|${a.id}`);
            if (silent) {
              silentAsks.push([b, a]);
              return;
            }
            if (yesB) viaAsk.add([a.id, b.id].sort().join("|"));
            await reply(b, a, yesB ? "interested" : "not_interested");
          }),
        );
      } else if (roll < rates.yes + rates.no) {
        replies.push(reply(a, b, "not_interested"));
      }
    }
    return replies;
  };
  let inFlight: Promise<void>[] = [];
  // How the night really runs (sim gaps B2, B3, B9). Everyone on the RSVP list is registered from the start. Most share their
  // location when the night begins and arrive in four waves (nudges wait for them: eventPresence.ts arrivalWaitCheck); some never
  // share (they count as in the room); a few share and never come. A few walk in without an RSVP (the door QR) after the first
  // wave. A few text "stop" partway through: nothing reaches them after that. Each wave's scoring pass runs while the replies to
  // the last wave's nudges are still landing.
  const shuffled = [...p.members].sort(() => r() - 0.5);
  const cut = (f: number) => Math.round(shuffled.length * f);
  const walkIns = shuffled.slice(0, cut(0.05));
  const noShows = shuffled.slice(cut(0.05), cut(0.12));
  const nonSharers = shuffled.slice(cut(0.12), cut(0.45));
  const sharers = shuffled.slice(cut(0.45));
  const stoppers = sharers.filter((m) => !p.optedOut.has(m.id) && !p.noAsk.has(m.id)).slice(0, Math.max(1, cut(0.04)));
  const stopWave = new Map(stoppers.map((m, k) => [m.id, 1 + (k % 3)]));
  addEvent({ api_id: evId, name: evName }, p.members.filter((m) => !walkIns.includes(m)).map((m) => ({ m })));
  for (const m of [...sharers, ...noShows]) W.presence.set(`${evId}|${m.id}`, { sharing_seen_at: new Date(), arrived_at: null });
  const arrived = new Set<string>();
  let nudgedBeforeArrival = 0;
  const waveShare = [0.4, 0.7, 0.9, 1];
  for (let w = 0; w < waveShare.length; w++) {
    for (const m of sharers.slice(0, Math.ceil(sharers.length * waveShare[w]))) {
      if (arrived.has(m.id)) continue;
      arrived.add(m.id);
      W.presence.set(`${evId}|${m.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
    }
    if (w === 1) for (const m of walkIns) await WK.recordCheckin(evId, m.id);
    for (const m of stoppers) {
      if (stopWave.get(m.id) === w && !stoppedAt.has(m.id)) {
        // "stop" (routes/sendblue.ts): opted out at once; the members store is the users row the code reads at send time.
        W.members.get(m.id)!.sms_opted_out = true;
        stoppedAt.set(m.id, W.sent.length);
      }
    }
    const waiting = new Set([...sharers, ...noShows].filter((m) => !arrived.has(m.id)).map((m) => m.id));
    const nudgesBefore = W.nudges.length;
    W.scoringDebounce.clear();
    await Promise.all([S.scoreGuestListForEvent(evId), ...inFlight]);
    nudgedBeforeArrival += W.nudges.slice(nudgesBefore).filter((n) => n.event_id === evId && waiting.has(n.person_id) && !n.pending).length;
    await new Promise((res) => setTimeout(res, 20));
    inFlight = answerOpen();
  }
  await Promise.all(inFlight);
  // The last answers can open new direct asks: answer those too, until the room is quiet.
  for (let k = 0; k < 3; k++) await Promise.all(answerOpen());
  await new Promise((res) => setTimeout(res, 20));

  // ---------------------------------------------------------------- the end of the night (sim gaps A6, B5)
  // The event ends 2h after the first wave (addEvent's default). 35 minutes before the end the close is due (it goes 50 minutes
  // before the end, inside the in-room window): everyone in the room with evidence they came gets the same goodbye. Then the
  // clock passes the end and the room closes: every open question expires, pairs still waiting expire, the next-morning debrief is
  // scheduled. After that, late replies and a fresh scoring pass reach nobody.
  const ev = W.events.get(evId)!;
  const endAt = new Date(ev.end_at!).getTime();
  advance(endAt - 35 * 60_000 - Date.now());
  const roomAtClose = new Set((await RM.inRoomNow(evId)).people.map((g) => g.user_id));
  const beforeClose = W.sent.length;
  await U.processDueUnmatchedFollowUps();
  await new Promise((res) => setTimeout(res, 20));
  const closeTexts = W.sent.slice(beforeClose);
  advance(endAt + 20 * 60_000 - Date.now());
  await RM.scheduleRoomClose(evId, evName, { start_at: ev.start_at, end_at: ev.end_at, timezone: null });
  const closed = await RM.runRoomCloses(new Date());
  let openAtClose = 0;
  const afterClose = W.sent.length;
  const introsBeforeLate = W.memoriesWritten.filter((m) => m.memory_type === "event_intro_email_sent").length;
  // Late: everyone still holding an unanswered question says yes now, and a scoring pass runs.
  const stillOpen = W.nudges.filter((n) => n.event_id === evId && n.candidate_id && !answered.has(`${n.person_id}|${n.candidate_id}`) && !stoppedAt.has(n.person_id));
  openAtClose = W.offers.filter((o) => o.event_id === evId && o.status === "expired").length;
  await Promise.all([
    ...stillOpen.map((n) => reply(byId.get(n.person_id)!, byId.get(n.candidate_id)!, "interested")),
    ...silentAsks.filter(([b]) => !stoppedAt.has(b.id)).map(([b, a]) => reply(b, a, "interested")),
  ]);
  W.scoringDebounce.clear();
  await S.scoreGuestListForEvent(evId);
  await new Promise((res) => setTimeout(res, 20));
  latency.next = null;
  const lateTexts = W.sent.slice(afterClose);
  const lateIntros = W.memoriesWritten.filter((m) => m.memory_type === "event_intro_email_sent").length - introsBeforeLate;

  // ---------------------------------------------------------------- the scorecard
  const pairKey = (a: string, b: string) => [a, b].sort().join("|");
  // Intros from the pair record (exact ids): a pair is introduced when its intro_sent_at is set. Sends of the email are counted from
  // the intro memories each side gets (two per email), by the pair record's ids, never by first name.
  const introPairs = new Map<string, number>();
  for (const r of W.pairs.filter((x) => x.event_id === evId && x.intro_sent_at)) introPairs.set(pairKey(r.a_id, r.b_id), 0);
  const introMem = W.memoriesWritten.filter((m) => m.memory_type === "event_intro_email_sent");
  for (const k of introPairs.keys()) {
    const [x, y] = k.split("|");
    const nx = byId.get(x)!.first_name;
    const ny = byId.get(y)!.first_name;
    const exact = new RegExp(`connecting (${esc(nx)} and ${esc(ny)}|${esc(ny)} and ${esc(nx)}) ahead`);
    introPairs.set(k, introMem.filter((m) => (m.user_id === x || m.user_id === y) && exact.test(String(m.content))).length);
  }
  const nudgePairs = new Set(W.nudges.filter((n) => n.candidate_id).map((n) => pairKey(n.person_id, n.candidate_id)));
  const sentByPhone = new Map<string, string[]>();
  for (const s of W.sent) sentByPhone.set(s.to, [...(sentByPhone.get(s.to) ?? []), s.content]);
  const textsOf = (m: Member) => sentByPhone.get(m.phone_number ?? "") ?? [];
  const askers = p.members.filter((m) => !p.optedOut.has(m.id) && !p.noAsk.has(m.id) && !p.privateAskText.has(m.id));
  // A direct ask reads "<asker> from <event> would like an intro" (the stub drafter): counted by the asker's exact name at the start.
  const directAsks = new Map<string, number>();
  for (const m of p.members) for (const t of textsOf(m)) for (const o of p.members) if (o.id !== m.id && new RegExp(`^${esc(o.first_name)} from .* would like an intro`).test(t)) directAsks.set(`${m.id}|${o.id}`, (directAsks.get(`${m.id}|${o.id}`) ?? 0) + 1);

  return {
    size,
    nudges: W.nudges.filter((n) => n.event_id === evId).length,
    namedBeforeYes: W.nudges.filter((n) => n.event_id === evId && n.candidate_id && !n.anonymous).length,
    trueFound: p.truePairs.filter(([a, b]) => introPairs.has(pairKey(a, b))).length,
    trueProposed: p.truePairs.filter(([a, b]) => nudgePairs.has(pairKey(a, b))).length,
    trueTotal: p.truePairs.length,
    nearProposed: p.nearPairs.filter(([a, b]) => nudgePairs.has(pairKey(a, b))).length,
    trapsProposed: p.hardTraps.filter(([a, b]) => nudgePairs.has(pairKey(a, b))).length,
    trapsIntroduced: p.hardTraps.filter(([a, b]) => introPairs.has(pairKey(a, b))).length,
    intros: introPairs.size,
    introsViaAsk: [...introPairs.keys()].filter((k) => viaAsk.has(k)).length,
    duplicateIntros: [...introPairs.values()].filter((n) => n > 2).length,
    duplicateAsks: [...directAsks.values()].filter((n) => n > 1).length,
    // A private ask is quoted when its words reach anyone but someone who holds those words privately, with or without the "(ref N)"
    // tag. Only private asks say "kept private", but two members can hold the same private words (domains repeat in a big room), so
    // the words said back to their own owner never count as a leak.
    privateQuoted: [...p.privateAskText.entries()].filter(([, t]) => {
      const words = t.replace(/\s*\(ref \d+\)$/, "");
      const holders = new Set([...p.privateAskText.entries()].filter(([, u]) => u.replace(/\s*\(ref \d+\)$/, "") === words).map(([id]) => byId.get(id)?.phone_number));
      return W.sent.some((s) => !holders.has(s.to) && s.content.includes(words));
    }).length,
    privateProposed: p.truePairs.filter(([a, b]) => p.privateAskText.has(b) && nudgePairs.has(pairKey(a, b))).length,
    optedOutTexted: p.members.filter((m) => p.optedOut.has(m.id) && textsOf(m).length > 0).length,
    textsMax: Math.max(0, ...p.members.map((m) => textsOf(m).length)),
    leftWithNothing: askers.filter((m) => !noShows.includes(m) && !stoppedAt.has(m.id) && textsOf(m).length === 0).length,
    unknownSql: W.unknownSql.size,
    nudgedBeforeArrival,
    noShowsTexted: noShows.filter((m) => textsOf(m).length > 0).length,
    noShowsProposed: noShows.filter((m) => W.nudges.some((n) => n.event_id === evId && n.candidate_id === m.id && !n.pending)).length,
    textedAfterStop: [...stoppedAt.entries()].filter(([id, at]) => W.sent.slice(at).some((x) => x.to === byId.get(id)!.phone_number)).length,
    stoppers: stoppedAt.size,
    walkIns: walkIns.length,
    walkInsProposed: walkIns.filter((m) => W.nudges.some((n) => n.event_id === evId && n.candidate_id && (n.person_id === m.id || n.candidate_id === m.id))).length,
    ...(() => {
      // Who should get the goodbye: in the room at close time, with evidence they came (arrived, or texted Cue tonight), and
      // still reachable. One each, never to a no-show or someone who said stop.
      const evidence = (m: Member) => Boolean(W.presence.get(`${evId}|${m.id}`)?.arrived_at) || W.memoriesWritten.some((x) => x.user_id === m.id && /^User said:/.test(String(x.content)));
      const owed = p.members.filter((m) => roomAtClose.has(m.id) && evidence(m) && !stoppedAt.has(m.id) && !m.sms_opted_out);
      const closesTo = (m: Member) => closeTexts.filter((x) => x.to === m.phone_number).length;
      return {
        closeSent: closeTexts.length,
        closeOwed: owed.filter((m) => closesTo(m) !== 1).length,
        closeDuplicates: p.members.filter((m) => closesTo(m) > 1).length,
        closeToStopped: stoppers.filter((m) => closesTo(m) > 0).length,
        closeToNoShow: noShows.filter((m) => closesTo(m) > 0).length,
        closeMatchTalk: closeTexts.filter((x) => U.MATCH_TALK.test(x.content)).length,
      };
    })(),
    roomClosed: closed.some((c) => c.eventId === evId),
    openAfterClose: W.offers.filter((o) => o.event_id === evId && ["open", "queued", "sending"].includes(o.status)).length,
    pairsWaitingAfterClose: W.pairs.filter((x) => x.event_id === evId && ["suggested", "asked"].includes(x.state)).length,
    lateTexts: lateTexts.length,
    lateIntros,
    debriefsScheduled: W.checkinFollowups.filter((x) => x.event_api_id === evId).length,
    expiredAtClose: openAtClose,
  };
}

// ---------------------------------------------------------------- run the nights
const cards: Card[] = [];
for (const [size, seed] of [[25, 11], [60, 23], [120, 37]] as const) {
  const t0 = performance.now();
  const c = await night(size, seed);
  cards.push(c);
  console.log(
    `room ${String(size).padStart(3)}: nudges ${c.nudges}, intros ${c.intros}, true pairs proposed ${c.trueProposed}/${c.trueTotal}, introduced ${c.trueFound}/${c.trueTotal}, ` +
      `near misses proposed ${c.nearProposed}, hard traps proposed ${c.trapsProposed} (introduced ${c.trapsIntroduced}), most texts to one member ${c.textsMax}, ` +
      `askers left with nothing ${c.leftWithNothing}, ${Math.round(performance.now() - t0)}ms`,
  );
  console.log(`  the night: ${c.walkIns} walk-in(s), ${c.walkInsProposed} of them in a proposed pair; ${c.stoppers} texted stop partway through`);
  console.log(`  end of night: ${c.closeSent} goodbye(s), room closed ${c.roomClosed} (${c.expiredAtClose} unanswered question(s) expired), ${c.debriefsScheduled} debrief(s) scheduled; after close: ${c.lateTexts} text(s), ${c.lateIntros} intro(s) from late yeses`);
  // Must hold today.
  check(`room ${size}: everyone in the room who came gets exactly one goodbye`, c.closeSent > 0 && c.closeOwed === 0 && c.closeDuplicates === 0, c);
  check(`room ${size}: no goodbye to anyone who said stop`, c.closeToStopped === 0, c);
  check(`room ${size}: the goodbye says nothing about matching`, c.closeMatchTalk === 0, c);
  check(`room ${size}: the room closes, and nothing is left open (questions, waiting pairs)`, c.roomClosed && c.expiredAtClose > 0 && c.openAfterClose === 0 && c.pairsWaitingAfterClose === 0, c);
  check(`room ${size}: after the room closes, late yeses and a fresh scoring pass reach nobody (no texts, no intros)`, c.lateTexts === 0 && c.lateIntros === 0, c);
  check(`room ${size}: the next-morning debrief is scheduled for the room`, c.debriefsScheduled > 0, c);
  check(`room ${size}: nobody sharing their location is nudged before they arrive`, c.nudgedBeforeArrival === 0, c);
  // A no-show (shared their location, never came) is never texted (a direct ask or the goodbye) and never proposed to anyone: #215
  // holds them out of matching until they arrive, and a text is no evidence they came (Royce, 2026-10-14 and 2026-10-19). The old
  // check repeated the arrival check above, so it couldn't fail on its own (review of #213).
  check(`room ${size}: a no-show is never texted (no direct ask, no goodbye)`, c.noShowsTexted === 0, c);
  check(`room ${size}: a no-show is never proposed to someone mid-night`, c.noShowsProposed === 0, c);
  check(`room ${size}: a no-show never gets the goodbye (only arrival or a check-in is evidence they came)`, c.closeToNoShow === 0, c);
  // A walk-in who only scans the door QR is never in the room (inRoomPool counts walk-ins only once arrived). Ruled 10-14: the door
  // code counts as arriving (P2, #212). This sim's walk-ins still check in the old way (no door code), so they're counted, not checked.
  console.log(`  counted: ${c.walkIns - c.walkInsProposed} of ${c.walkIns} QR-only walk-in(s) (no door code) never matched`);
  // What this covers: someone who texts stop leaves the room's roster at once, so no later pass texts them. A text already being
  // drafted when they stop is not exercised here (the fake world drops opted-out members in its own roster reads; review of #213).
  check(`room ${size}: after someone texts stop, no later pass texts them`, c.stoppers > 0 && c.textedAfterStop === 0, c);

  check(`room ${size}: nobody opted out of texts is texted`, c.optedOutTexted === 0, c);
  check(`room ${size}: no private (not shareable) ask is quoted to anyone else`, c.privateQuoted === 0, c);
  console.log(`  private asks: ${c.privateProposed} true pair(s) whose offering side keeps their ask private were proposed`);
  check(`room ${size}: no pair is introduced twice`, c.duplicateIntros === 0, c);
  check(`room ${size}: nobody gets the same direct ask twice (replies answered all at once)`, c.duplicateAsks === 0, c);
  check(`room ${size}: a near miss scored under the bar is never proposed`, c.nearProposed === 0, c);
  // Per room only where the room is big enough to be steady (room 25 has one or two of these, and unrelated changes move it).
  if (size >= 60) check(`room ${size}: some intros come through a direct ask that reached the other person (not only two nudges crossing)`, c.introsViaAsk > 0, c);
  check(`room ${size}: every query the night runs is one the fake world knows (nothing silently unanswered)`, c.unknownSql === 0, { unknown: [...W.unknownSql].slice(0, 5) });
  // Baselines for the strict double opt-in work (printed, never failing yet).
  console.log(`  baseline (double opt-in must make this 0): ${c.namedBeforeYes} nudge(s) named the other person before they said yes`);
  console.log(`  baseline (quality gate everywhere): ${c.trapsProposed} hard trap(s) proposed, ${c.trapsIntroduced} introduced`);
}

check("across the nights: intros come through direct asks that reached the other person", cards.reduce((n, c) => n + c.introsViaAsk, 0) > 0, cards.map((c) => c.introsViaAsk));
// With real timing the replies land in a different order each run, so one small room can end with no introduction by chance.
// Across the three nights, some true pairs always are.
check("across the nights, some true pairs are introduced", cards.reduce((n, c) => n + c.trueFound, 0) > 0, cards.map((c) => c.trueFound));

// ---------------------------------------------------------------- sparse rooms (Royce, 2026-10-14: "never lower the bar, never force a
// match. Members get silence; the shortfall goes to the host read as what the room is thin on")
const PR = await import("../../src/services/partnerReadout.js");
async function sparseNight(label: string, trueCount: number, seed: number) {
  reset();
  const r = rng(seed);
  const members: Member[] = [];
  const truePairs: [string, string][] = [];
  const seekers: string[] = [];
  let i = 0;
  // Eight people looking for an investor, nobody offering one: the room is thin on investors.
  for (let k = 0; k < 8; k++) {
    const m = addMember({ first_name: `${NAMES[k % NAMES.length]} ${label}`, intent: [ask(uniq("an angel investor for a pre-seed consumer app", i++))] });
    members.push(m);
    seekers.push(m.id);
  }
  // A few others whose asks nobody in the room answers either.
  for (let k = 0; k < 4; k++) members.push(addMember({ first_name: `${NAMES[(k + 8) % NAMES.length]} ${label}`, intent: [ask(uniq(DOMAINS[k].near, i++))] }));
  // And trueCount real pairs that clear the bar.
  for (let k = 0; k < trueCount; k++) {
    const d = DOMAINS[(k + 4) % DOMAINS.length];
    const a = addMember({ first_name: `${NAMES[(k + 12) % NAMES.length]} ${label}`, intent: [ask(uniq(d.seek, i++))] });
    const b = addMember({ first_name: `${NAMES[(k + 16) % NAMES.length]} ${label}`, intent: [ask(uniq(d.offer, i++), "offering")] });
    members.push(a, b);
    truePairs.push([a.id, b.id]);
  }
  const high = new Set(truePairs.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  const byAsk = new Map<string, string>();
  for (const m of members) for (const it of (m.intent as any[]) ?? []) byAsk.set(String(it.text), m.id);
  W.scorer = (askText, cand) => {
    const asker = [...byAsk.entries()].find(([t]) => askText.includes(t))?.[1];
    // Everything but a planted pair scores under the bar, some of it just under.
    return { score: asker && high.has(`${asker}|${cand.id}`) ? 82 + Math.floor(r() * 10) : 30 + Math.floor(r() * 29), share: true };
  };
  const ev = `evt-sparse-${label}`;
  addEvent({ api_id: ev, name: "Noise Supper" }, members.map((m) => ({ m })));
  W.scoringDebounce.clear();
  await S.scoreGuestListForEvent(ev);
  await new Promise((res) => setTimeout(res, 20));
  const nudged = W.nudges.filter((n) => n.event_id === ev && n.candidate_id);
  const truePair = (x: string, y: string) => truePairs.some(([a, b]) => (a === x && b === y) || (a === y && b === x));
  // The host signal: the readout's themes, by the planted categories (the readout's own classifier is a model call).
  const theme = (id: string): any => (seekers.includes(id) ? "Investors or funding" : "Something else");
  const sought: Record<string, number> = {};
  const offered: Record<string, number> = {};
  for (const m of members) {
    const it = (m.intent as any[])[0];
    const t = truePairs.some(([a, b]) => a === m.id || b === m.id) ? "Community or friends" : theme(m.id);
    if (it.type === "offering") offered[t] = (offered[t] ?? 0) + 1;
    else sought[t] = (sought[t] ?? 0) + 1;
  }
  const d = PR.describe({ eventName: "Noise Supper", registered: members.length, arrived: members.length, walkins: 0, briefs: 0, nudged: nudged.length, interested: 0, intros: 0, debriefReplies: 0, metSomeone: 0, conversationsTold: 0, followThroughMembers: 0, themes: sought as any, askCount: Object.values(sought).reduce((x, y) => x + y, 0), offerThemes: offered as any, offerKnown: members.length, offerPool: members.length });
  // The same room when Cue doesn't know what most people there can offer: no claim at all.
  const unbacked = PR.describe({ eventName: "Noise Supper", registered: members.length, arrived: members.length, walkins: 0, briefs: 0, nudged: nudged.length, interested: 0, intros: 0, debriefReplies: 0, metSomeone: 0, conversationsTold: 0, followThroughMembers: 0, themes: sought as any, askCount: Object.values(sought).reduce((x, y) => x + y, 0), offerThemes: offered as any, offerKnown: 2, offerPool: members.length }).lines.filter((l) => l.startsWith("The room was thin on"));
  const thinLines = d.lines.filter((l) => l.startsWith("The room was thin on"));
  return { nudged, truePair, thinLines, unbacked, sent: W.sent.length, lines: d.lines, names: members.map((m) => m.first_name) };
}
{
  const z = await sparseNight("z", 0, 51);
  console.log(`sparse room, no good pairs: ${z.nudged.length} nudges, host signal: ${z.thinLines.join(" ") || "(none)"}`);
  check("sparse: a room with zero good pairs sends zero member nudges (silence, never a forced match)", z.nudged.length === 0 && z.sent === 0, { nudged: z.nudged.length, sent: z.sent });
  check("sparse: ... and gives the host exactly one signal of what the room was thin on", z.thinLines.length === 1 && /investors or funding/.test(z.thinLines[0]), z.thinLines);
  check("sparse: ... and says nothing when Cue doesn't know what most of the room can offer (silence over false signal)", z.unbacked.length === 0, z.unbacked);
  // On the night's own host read, with the thin line in it (review of #208: the old check passed no offers, so no thin line existed).
  check("sparse: the host signal names no member", z.thinLines.length === 1 && z.lines.every((l) => !z.names.some((n) => new RegExp(`\\b${n.split(" ")[0]}\\b`).test(l))), z.lines);
  const sp = await sparseNight("s", 2, 53);
  console.log(`sparse room, two good pairs: ${sp.nudged.length} nudges, all above the bar: ${sp.nudged.every((n) => sp.truePair(n.person_id, n.candidate_id))}`);
  check("sparse: a sparse room proposes only the pairs above the bar", sp.nudged.length > 0 && sp.nudged.every((n) => sp.truePair(n.person_id, n.candidate_id)), sp.nudged.map((n) => n.score));
}

const { total, failed } = results;
console.log(`room simulation: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
