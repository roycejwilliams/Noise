// Model-free checks for event page member actions (services/eventPages/*, routes/eventPageActions.ts): sealed per-member page
// tokens, view-only for non-members, structured actions only, every action in the member's own record, no cross-member leaks,
// the flag, and Co-only page updates. Every store is injected (in memory): no database, no model, no outside call. The HTTP
// checks run the real router on a local port.
//   npx tsx evals/eventPages/actions.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const ID = await import("../../src/services/eventPages/identity.js");
const A = await import("../../src/services/eventPages/actions.js");
const M = await import("../../src/services/eventPages/memory.js");
const V = await import("../../src/services/eventPages/actionsView.js");
const { createEventPageActionsRouter } = await import("../../src/routes/eventPageActions.js");
const { memberKnowledge } = await import("../../src/services/memberKnowledge.js");
const { addMemberKnowledge } = await import("../../src/harness/replyGrounding.js");
type ActionRow = import("../../src/services/eventPages/actions.js").ActionRow;
type ActionStore = import("../../src/services/eventPages/actions.js").ActionStore;
type CoFact = import("../../src/services/coFacts.js").CoFact;
type EventPageRecord = import("../../src/services/eventPages/contract.js").EventPageRecord;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- fixtures (invented members)
const KEY = Buffer.alloc(32, 7); // a test key, not a secret
const OTHER_KEY = Buffer.alloc(32, 9);
const JORDAN = "0b7a6c1e-3f2d-4c5b-8a9e-1d2c3b4a5f60";
const ELLIS = "1c8b7d2f-4e3a-4d6c-9b0f-2e3d4c5b6a71";
const NOOR = "2d9c8e3a-5f4b-4e7d-8c1a-3f4e5d6c7b82";
const ARCHIVED = "3e0d9f4b-6a5c-4f8e-9d2b-4a5f6e7d8c93";
const NAMES: Record<string, [string, string]> = { [JORDAN]: ["Jordan", "Reyes"], [ELLIS]: ["Ellis", "Park"], [NOOR]: ["Noor", "Haddad"] };
const PAGE = "dinner-oct";
const NOW = new Date("2026-10-10T18:00:00Z");
const pages: Record<string, EventPageRecord> = {
  [PAGE]: { id: PAGE, version: 3, data: { title: "Supper at the Loft", startsAt: "2026-10-17T02:00:00Z", timezone: "America/Los_Angeles", venueName: "The Loft", notes: "Doors at 7." } },
  "rooftop-nov": { id: "rooftop-nov", version: 1, data: { title: "Rooftop", startsAt: "2026-11-01T02:00:00Z", timezone: "America/Los_Angeles" } },
  archived: { id: "archived", version: 1, archivedAt: "2026-10-01T00:00:00Z", data: { title: "Old", startsAt: "2026-09-01T02:00:00Z", timezone: "America/Los_Angeles" } },
};

// In-memory event_page_actions.
function memStore() {
  const rows: ActionRow[] = [];
  let seq = 0;
  const live = (r: ActionRow) => !r.retractedAt;
  const store: ActionStore = {
    insert: async (a) => {
      const r: ActionRow = { id: String(++seq), pageId: a.pageId, userId: a.userId, kind: a.kind, value: a.value, createdAt: a.at, retractedAt: null };
      rows.push(r);
      return r;
    },
    retract: async (w) => {
      const hit = rows.filter((r) => live(r) && r.pageId === w.pageId && r.userId === w.userId && (!w.kind || r.kind === w.kind) && (w.value === undefined || r.value === w.value) && (!w.id || r.id === w.id));
      for (const r of hit) r.retractedAt = NOW;
      return hit;
    },
    mine: async (pageId, userId) => rows.filter((r) => live(r) && r.pageId === pageId && r.userId === userId),
    countSince: async (userId, kind, since) => rows.filter((r) => r.userId === userId && r.kind === kind && r.createdAt > since).length,
    summary: async (pageId) => {
      const s = { going: 0, maybe: 0, cant: 0, reactions: {} as Record<string, number> };
      for (const r of rows.filter((x) => live(x) && x.pageId === pageId)) {
        if (r.kind === "rsvp") (s as any)[r.value]++;
        if (r.kind === "reaction") s.reactions[r.value] = (s.reactions[r.value] ?? 0) + 1;
      }
      return s;
    },
    othersComments: async (pageId, except) => rows.filter((r) => live(r) && r.pageId === pageId && r.kind === "comment" && r.userId !== except).map((r) => ({ firstName: NAMES[r.userId]?.[0] ?? "A member", text: r.value, at: r.createdAt })),
    memberTexts: async (pageId) => rows.filter((r) => r.pageId === pageId && (r.kind === "comment" || r.kind === "question")).map((r) => r.value),
    memberNames: async (pageId) => [...new Set(rows.filter((r) => r.pageId === pageId).flatMap((r) => NAMES[r.userId] ?? []))],
    question: async (pageId, id) => rows.find((r) => r.pageId === pageId && r.id === id && r.kind === "question") ?? null,
  };
  return { rows, store };
}

// In-memory co_facts (the member record), with retire.
function memFacts() {
  const facts: (CoFact & { retired: boolean })[] = [];
  return {
    facts,
    deps: {
      write: async (f: CoFact) => void facts.push({ ...f, retired: false }),
      retire: async (userId: string, ids: string[]) => {
        for (const f of facts) if (f.ownerUserId === userId && ids.includes(String(f.meta?.actionId))) f.retired = true;
      },
    },
    // The real loader's shape, scoped by owner the way loadPageActivity's SQL is.
    activity: (userId: string) =>
      facts.filter((f) => f.ownerUserId === userId && !f.retired).map((f) => ({ kind: f.meta!.kind as any, title: String(f.meta!.title), value: String(f.meta!.value), at: f.happenedAt ?? NOW })),
  };
}

function world() {
  const s = memStore();
  const f = memFacts();
  const queued: any[] = [];
  const updates: { id: string; data: any }[] = [];
  let clock = NOW.getTime();
  const actionDeps = {
    store: s.store,
    memory: f.deps,
    loadPage: async (id: string) => pages[id] ?? null,
    queueQuestion: async (q: any) => {
      queued.push(q);
      return { ok: true, taskId: queued.length };
    },
    now: () => new Date(clock),
  };
  const updateDeps = {
    store: s.store,
    loadPage: async (id: string) => pages[id] ?? null,
    updatePage: async (id: string, data: any) => {
      updates.push({ id, data });
      return { version: (pages[id]?.version ?? 0) + updates.length };
    },
  };
  return { ...s, ...f, queued, updates, actionDeps, updateDeps, tick: (ms: number) => (clock += ms) };
}

// ---------------------------------------------------------------- 1. tokens: one page, one member, expiring, opaque
{
  const t = ID.issueMemberToken(PAGE, JORDAN, { key: KEY, now: NOW, expiresAt: new Date(NOW.getTime() + 86_400_000) });
  const ok = ID.verifyMemberToken(t, PAGE, { key: KEY, now: NOW });
  check("token: a genuine token names its member", ok?.userId === JORDAN);
  check("token: expired is refused", ID.verifyMemberToken(t, PAGE, { key: KEY, now: new Date(NOW.getTime() + 2 * 86_400_000) }) === null);
  check("token: another page is refused", ID.verifyMemberToken(t, "rooftop-nov", { key: KEY, now: NOW }) === null);
  check("token: another server key is refused", ID.verifyMemberToken(t, PAGE, { key: OTHER_KEY, now: NOW }) === null);
  const flipped = Buffer.from(t, "base64url");
  flipped[flipped.length - 1] ^= 1;
  check("token: a tampered token is refused", ID.verifyMemberToken(flipped.toString("base64url"), PAGE, { key: KEY, now: NOW }) === null);
  check("token: junk and missing are refused, never thrown", ID.verifyMemberToken("abc", PAGE, { key: KEY }) === null && ID.verifyMemberToken(undefined, PAGE, { key: KEY }) === null && ID.verifyMemberToken(t, PAGE, { key: null }) === null);
  check("token: no user id inside it, readable or as hex", !t.includes(JORDAN) && !Buffer.from(t, "base64url").toString("hex").includes(JORDAN.replace(/-/g, "")));
  check("token: two links for the same member differ (random iv)", t !== ID.issueMemberToken(PAGE, JORDAN, { key: KEY, now: NOW }));
  process.env.JWT_SECRET_KEY = "eval-only-placeholder";
  const link = ID.memberEventLink(PAGE, JORDAN, { baseUrl: "https://co.example" })!;
  check("link: /e/<page>?m=<token>, no user id, no phone number", /^https:\/\/co\.example\/e\/dinner-oct\?m=[A-Za-z0-9_-]{60,70}$/.test(link) && !link.includes(JORDAN) && !/\d{10}/.test(link.replace(/\?m=.*/, "")));
  check("link: it verifies with the server key", ID.verifyMemberToken(new URL(link).searchParams.get("m"), PAGE)?.userId === JORDAN);
  delete process.env.JWT_SECRET_KEY;
  check("link: no server secret, no link (never an unsigned one)", ID.memberEventLink(PAGE, JORDAN, { baseUrl: "https://co.example" }) === null);
  check("token: refuses to seal a non-member id", (() => { try { ID.issueMemberToken(PAGE, "+14155550123", { key: KEY }); return false; } catch { return true; } })());
}

// ---------------------------------------------------------------- 2. structured actions, through takeAction
const ON = { EVENT_PAGE_ACTIONS_ENABLED: "true" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;
{
  const w = world();
  // RSVP change: one current value, the old fact retired.
  const r1 = await A.takeAction(PAGE, JORDAN, { kind: "rsvp", value: "going" }, w.actionDeps);
  const r2 = await A.takeAction(PAGE, JORDAN, { kind: "rsvp", value: "maybe" }, w.actionDeps);
  const r3 = await A.takeAction(PAGE, JORDAN, { kind: "rsvp", value: "maybe" }, w.actionDeps);
  const liveRsvps = (await w.store.mine(PAGE, JORDAN)).filter((r) => r.kind === "rsvp");
  check("rsvp: changing it leaves one current value", r1.ok && r2.ok && liveRsvps.length === 1 && liveRsvps[0].value === "maybe");
  check("rsvp: the same value again is a no-op", r3.ok && w.rows.filter((r) => r.kind === "rsvp").length === 2);
  const rsvpFacts = w.facts.filter((f) => f.relation === "event_page_rsvp");
  check("rsvp: each choice is a fact; the changed one is retired", rsvpFacts.length === 2 && rsvpFacts[0].retired && !rsvpFacts[1].retired && /RSVP'd a maybe/.test(rsvpFacts[1].label));
  check("rsvp: only going, maybe or can't", !(await A.takeAction(PAGE, JORDAN, { kind: "rsvp", value: "definitely" }, w.actionDeps)).ok);
  check("rsvp: \"can't\" from a form reads as cant", (await A.takeAction(PAGE, ELLIS, { kind: "rsvp", value: "Can't" }, w.actionDeps)).ok && (await w.store.mine(PAGE, ELLIS))[0]?.value === "cant");

  // Reactions: a fixed set, toggled.
  check("reaction: one of the set is added", (await A.takeAction(PAGE, JORDAN, { kind: "reaction", value: "🔥" }, w.actionDeps)).ok);
  check("reaction: anything else is refused", !(await A.takeAction(PAGE, JORDAN, { kind: "reaction", value: "💩" }, w.actionDeps)).ok && !(await A.takeAction(PAGE, JORDAN, { kind: "reaction", value: "<b>x</b>" }, w.actionDeps)).ok);
  await A.takeAction(PAGE, JORDAN, { kind: "reaction", value: "🔥" }, w.actionDeps);
  check("reaction: the same one again takes it back, and retires its fact", !(await w.store.mine(PAGE, JORDAN)).some((r) => r.kind === "reaction") && w.facts.filter((f) => f.relation === "event_page_reaction").every((f) => f.retired));

  // Markup stripped.
  const c = await A.takeAction(PAGE, JORDAN, { kind: "comment", text: '<script>alert("x")</script><b>Can\'t wait</b> &lt;img src=x onerror=alert(1)&gt; **see** [you](javascript:x) there' }, w.actionDeps);
  const stored = c.ok ? c.action!.value : "";
  check("comment: markup stripped to plain text", c.ok && !/[<>]/.test(stored) && !/script|onerror|\*\*/i.test(stored.replace(/javascript:x/, "")) && stored.startsWith("Can't wait") && /see you/.test(stored));
  check("plainText: entities can't come back as tags", A.plainText("&amp;lt;b&amp;gt;hi", 50) === "b hi" || !/[<>]/.test(A.plainText("&amp;lt;b&amp;gt;hi", 50)));
  check("plainText: capped by characters, emoji kept whole", [...A.plainText("🥂".repeat(600), A.TEXT_CAP.comment)].length === A.TEXT_CAP.comment);
  check("plainText: control and bidi characters gone", !/[\u0000-\u0008‮]/.test(A.plainText("hi\u0000there‮evil", 50)));
  check("comment: empty after stripping is refused", !(await A.takeAction(PAGE, JORDAN, { kind: "comment", text: "<p>  </p>" }, w.actionDeps)).ok);

  // A question: recorded, in memory, queued as a Co task for the asker only.
  const q = await A.takeAction(PAGE, NOOR, { kind: "question", text: "Is there <i>parking</i> nearby?" }, w.actionDeps);
  check("question: recorded and queued for Co to answer in their own thread", q.ok && q.queued === true && w.queued.length === 1 && w.queued[0].userId === NOOR && w.queued[0].text === "Is there parking nearby?" && w.queued[0].actionId === q.action!.id);
  const goal = A.questionGoal("Supper at the Loft", "https://co.example/e/dinner-oct", PAGE, q.ok ? q.action!.id : "0");
  const mk = goal.match(A.QUESTION_MARKER);
  check("question: the task goal carries the page and question for Co's page tool, under the goal cap", goal.length <= 200 && mk?.[1] === PAGE && mk?.[2] === (q.ok ? q.action!.id : "x"));
  check("question: a long title never cuts the marker", A.QUESTION_MARKER.test(A.questionGoal("x".repeat(300), "https://co.example/e/" + "p".repeat(40), "p".repeat(40), "123")));
  const failingQueue = { ...w.actionDeps, queueQuestion: async () => ({ ok: false, why: "five open tasks" }) };
  const q2 = await A.takeAction(PAGE, NOOR, { kind: "question", text: "What should I wear?" }, failingQueue);
  check("question: not queued still lands in their record (a reply shows it)", q2.ok && q2.queued === false && w.facts.some((f) => f.ownerUserId === NOOR && /What should I wear/.test(f.label)));

  // Memory per action: every action wrote one owner-only member fact.
  const live = w.rows.length;
  check("memory: one fact per action, owned by the member who acted, owner-only", w.facts.length === live && w.facts.every((f) => f.subject === "member" && f.visibility === "owner" && f.source === "event_page" && f.ownerUserId === w.rows.find((r) => r.id === f.meta?.actionId)?.userId));
  check("memory: comments and questions keep their own words; RSVP and reactions are engagement", w.facts.filter((f) => /comment|question/.test(f.relation)).every((f) => f.meta?.signal === "own_words") && w.facts.filter((f) => /rsvp|reaction/.test(f.relation)).every((f) => f.meta?.signal === "engagement"));
  const broken = { ...w.actionDeps, memory: { ...w.actionDeps.memory, write: async () => { throw new Error("db down"); } } };
  const before = (await w.store.mine(PAGE, ELLIS)).length;
  const nb = await A.takeAction(PAGE, ELLIS, { kind: "comment", text: "Looking forward to it" }, broken);
  check("memory: if the record can't take it, the action is taken back (no action without memory)", !nb.ok && nb.status === 503 && (await w.store.mine(PAGE, ELLIS)).length === before);

  // Retract: only their own, never an RSVP, never someone else's.
  const jc = (await w.store.mine(PAGE, JORDAN)).find((r) => r.kind === "comment")!;
  check("retract: someone else's comment can't be taken back", !(await A.takeAction(PAGE, ELLIS, { kind: "retract", id: jc.id }, w.actionDeps)).ok && !jc.retractedAt);
  check("retract: their own comment is taken back and its fact retired", (await A.takeAction(PAGE, JORDAN, { kind: "retract", id: jc.id }, w.actionDeps)).ok && !!jc.retractedAt && w.facts.find((f) => f.meta?.actionId === jc.id)?.retired === true);

  check("page: an archived or missing page takes nothing", (await A.takeAction("archived", JORDAN, { kind: "rsvp", value: "going" }, w.actionDeps)).ok === false && (await A.takeAction("nope", JORDAN, { kind: "rsvp", value: "going" }, w.actionDeps)).ok === false);
}

// ---------------------------------------------------------------- 3. rate limits, per member
{
  const w = world();
  const results = [] as boolean[];
  for (let i = 0; i < A.RATE_LIMITS.question.perHour + 1; i++) results.push((await A.takeAction(PAGE, ELLIS, { kind: "question", text: `Question number ${i} about the night` }, w.actionDeps)).ok);
  const last = await A.takeAction(PAGE, ELLIS, { kind: "question", text: "One more?" }, w.actionDeps);
  check("rate limit: questions stop at the hourly cap with a 429", results.slice(0, A.RATE_LIMITS.question.perHour).every(Boolean) && !results[A.RATE_LIMITS.question.perHour] && !last.ok && last.status === 429);
  check("rate limit: per member (another member still can)", (await A.takeAction(PAGE, NOOR, { kind: "question", text: "When do doors open?" }, w.actionDeps)).ok);
  w.tick(3_700_000);
  check("rate limit: an hour later it opens again", (await A.takeAction(PAGE, ELLIS, { kind: "question", text: "Is it outdoors?" }, w.actionDeps)).ok);
  check("rate limit: a day cap too", A.overLimit("comment", 0, A.RATE_LIMITS.comment.perDay) !== null && A.overLimit("comment", 0, 0) === null);
  let flips = 0;
  for (let i = 0; i < 12; i++) if ((await A.takeAction(PAGE, NOOR, { kind: "rsvp", value: i % 2 ? "going" : "maybe" }, w.actionDeps)).ok) flips++;
  check("rate limit: RSVP flipping is capped too", flips === A.RATE_LIMITS.rsvp.perHour);
}

// ---------------------------------------------------------------- 4. no cross-member leaks
{
  const w = world();
  const SECRET = "my divorce is final so I need this night";
  await A.takeAction(PAGE, JORDAN, { kind: "comment", text: SECRET }, w.actionDeps);
  await A.takeAction(PAGE, JORDAN, { kind: "question", text: "Can I bring my sister Maya?" }, w.actionDeps);
  await A.takeAction(PAGE, ELLIS, { kind: "rsvp", value: "going" }, w.actionDeps);
  const kdeps = (userId: string) => ({ profile: async () => null, zone: async () => null, linkedNames: async () => [] as string[], pageActivity: async (u: string) => w.activity(u) });
  const kE = await memberKnowledge(ELLIS, { now: NOW, include: ["pageActivity"] }, kdeps(ELLIS));
  const kJ = await memberKnowledge(JORDAN, { now: NOW, include: ["pageActivity"] }, kdeps(JORDAN));
  check("leak: member B's knowledge has none of member A's comment or question", !JSON.stringify(kE).includes("divorce") && !JSON.stringify(kE).includes("Maya") && kE.pageActivity.length === 1 && kE.pageActivity[0].kind === "rsvp");
  check("knowledge: member A's own words are there, kept word for word", kJ.pageActivity.some((p) => p.kind === "comment" && p.text === SECRET) && kJ.pageActivity.some((p) => p.kind === "question" && /sister Maya/.test(p.text)));
  const rfA = { facts: [] as any[], instructions: [] as string[] };
  addMemberKnowledge(rfA, kJ, null);
  check("knowledge: a text reply to A is told what A did on the page", JSON.stringify(rfA).includes("divorce") && JSON.stringify(rfA).includes("asked Co"));
  const rfE = { facts: [] as any[], instructions: [] as string[] };
  addMemberKnowledge(rfE, kE, null);
  check("leak: a text reply to B is told nothing of A's", !JSON.stringify(rfE).includes("divorce") && !JSON.stringify(rfE).includes("Maya") && /RSVP'd going/.test(JSON.stringify(rfE)));
  check("leak: the real loader reads the owner's rows only", /WHERE owner_user_id = \$1 AND subject = 'member' AND source = \$2/.test(src("services/eventPages/memory.ts")));

  // The page view: B never sees A's comment or question unless Royce opts in, and never A's question even then.
  const viewB = await A.memberView(PAGE, ELLIS, w.store);
  const htmlB = V.renderEventActions({ id: PAGE }, { kind: "member", ...viewB, policy: A.VISIBILITY }, ON);
  check("leak: by default B's page shows nothing of A's", !htmlB.includes("divorce") && !htmlB.includes("Maya") && !htmlB.includes("Jordan") && htmlB.includes("Only you and Co see your comments."));
  const viewA = await A.memberView(PAGE, JORDAN, w.store);
  const htmlA = V.renderEventActions({ id: PAGE }, { kind: "member", ...viewA, policy: A.VISIBILITY }, ON);
  check("view: A sees their own comment and question", htmlA.includes("divorce") && htmlA.includes("sister Maya"));
  const OPT_IN = { ...A.VISIBILITY, othersComments: true };
  const viewBOpt = await A.memberView(PAGE, ELLIS, w.store, OPT_IN);
  const htmlBOpt = V.renderEventActions({ id: PAGE }, { kind: "member", ...viewBOpt, policy: OPT_IN }, ON);
  check("opt-in: with comments shown, B sees A's comment by first name, never A's question", htmlBOpt.includes("divorce") && htmlBOpt.includes("Jordan") && !htmlBOpt.includes("Maya") && !htmlBOpt.includes("Reyes"));
  check("view: headcount hidden under the threshold (one going can point at a person)", viewB.page.headcountLine === null);
  await A.takeAction(PAGE, NOOR, { kind: "rsvp", value: "going" }, w.actionDeps);
  await A.takeAction(PAGE, JORDAN, { kind: "rsvp", value: "going" }, w.actionDeps);
  check("view: headcount shown once enough are going, as a count only", (await A.memberView(PAGE, ELLIS, w.store)).page.headcountLine === "3 members going");
  check("view: reaction totals are off by default", viewB.page.reactionCounts === null);
}

// ---------------------------------------------------------------- 5. non-member and flag-off views
{
  const pub = V.renderEventActions({ id: PAGE }, V.PUBLIC_VIEWER, ON);
  check("non-member: the members line, and no form to act with", pub.includes(V.MEMBERS_LINE) && !/<form/.test(pub) && !/<textarea/.test(pub));
  const w = world();
  const v = await A.memberView(PAGE, JORDAN, w.store);
  const off = V.renderEventActions({ id: PAGE }, { kind: "member", ...v, policy: A.VISIBILITY }, OFF);
  check("flag off: even a member sees only the members line", off.includes(V.MEMBERS_LINE) && !/<form/.test(off));
  const req: any = { query: {}, cookies: {} };
  check("non-member: no token is the public view", (await V.eventViewer(req, null, { id: PAGE }, { env: ON, identity: { isActiveMember: async () => true, key: KEY }, store: w.store })).kind === "public");
  const t = ID.issueMemberToken(PAGE, JORDAN, { key: KEY });
  check("flag off: a valid member token still gets the public view", (await V.eventViewer({ query: { m: t }, cookies: {} } as any, null, { id: PAGE }, { env: OFF, identity: { isActiveMember: async () => true, key: KEY }, store: w.store })).kind === "public");
  check("non-member: a token for another page is the public view", (await V.eventViewer({ query: { m: ID.issueMemberToken("rooftop-nov", JORDAN, { key: KEY }) }, cookies: {} } as any, null, { id: PAGE }, { env: ON, identity: { isActiveMember: async () => true, key: KEY }, store: w.store })).kind === "public");
  check("non-member: an archived member's link is the public view", (await V.eventViewer({ query: { m: ID.issueMemberToken(PAGE, ARCHIVED, { key: KEY }) }, cookies: {} } as any, null, { id: PAGE }, { env: ON, identity: { isActiveMember: async (u) => u !== ARCHIVED, key: KEY }, store: w.store })).kind === "public");
  const html = V.renderEventActions({ id: PAGE }, { kind: "member", state: { rsvp: null, reactions: [], comments: [{ id: "1", text: '"><script>x</script>', at: NOW }], questions: [] }, page: { headcountLine: null, reactionCounts: null, othersComments: [] }, policy: A.VISIBILITY }, ON);
  check("view: every value escaped", !html.includes("<script>x") && html.includes("&lt;script&gt;"));
  check("voice: no em dash or exclamation point in member-facing lines", ![V.MEMBERS_LINE, pub, html].some((s) => /[—–]/.test(s) || /![^=]/.test(s.replace(/<!doctype/gi, ""))));
}

// ---------------------------------------------------------------- 6. the router: flag, identity, cookie, Co-only content
{
  const w = world();
  const identity = { isActiveMember: async (u: string) => u !== ARCHIVED, key: KEY };
  const app = express();
  app.use(cookieParser());
  let envNow: NodeJS.ProcessEnv = OFF;
  // The router reads the flag per request, from envNow.
  const env = new Proxy({} as NodeJS.ProcessEnv, { get: (_t, k) => (envNow as any)[k] });
  app.use("/e", createEventPageActionsRouter({ actions: () => w.actionDeps, updates: () => w.updateDeps, identity, env }));
  // What the content layer's GET /e/:id will do: read the viewer (sets the cookie from ?m=), render the slot.
  app.get("/e/:id", async (req, res) => {
    const viewer = await V.eventViewer(req, res, { id: String(req.params.id) }, { env, identity, store: w.store });
    res.send(V.renderEventActions({ id: String(req.params.id) }, viewer, env));
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() });

  const token = ID.issueMemberToken(PAGE, JORDAN, { key: KEY });
  const cookie = `co_ep=${token}`;
  try {
    const offRes = await post(`/e/${PAGE}/actions/rsvp`, { value: "going" }, { cookie });
    check("flag off: action routes 404", offRes.status === 404 && w.rows.length === 0);
    const offPage = await fetch(`${base}/e/${PAGE}`);
    check("flag off: the page itself is untouched (not 404ed by this router)", offPage.status === 200 && (await offPage.text()).includes(V.MEMBERS_LINE));
    envNow = ON;
    const anon = await post(`/e/${PAGE}/actions/rsvp`, { value: "going" });
    check("router: no member token is a 401, nothing written", anon.status === 401 && w.rows.length === 0);
    const wrong = await post(`/e/rooftop-nov/actions/rsvp`, { value: "going" }, { cookie });
    check("router: a token for another page acts on nothing", wrong.status === 401 && w.rows.length === 0);
    const opened = await fetch(`${base}/e/${PAGE}?m=${token}`);
    const setCookie = opened.headers.get("set-cookie") ?? "";
    check("router: opening the link sets an httpOnly cookie scoped to this page", /co_ep=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /Path=\/e\/dinner-oct/.test(setCookie) && /SameSite=Lax/i.test(setCookie));
    check("router: the member's page has the forms", (await opened.text()).includes(`action="/e/${PAGE}/actions/rsvp"`));
    const ok = await post(`/e/${PAGE}/actions/rsvp`, { value: "going" }, { cookie });
    check("router: a form post redirects back to the page", ok.status === 303 && ok.headers.get("location") === `/e/${PAGE}#actions` && w.rows.length === 1 && w.rows[0].userId === JORDAN);
    const j = await post(`/e/${PAGE}/actions/comment`, { text: "<b>See you</b> there", title: "Hacked title", notes: "Hacked notes", userId: ELLIS, pageId: "rooftop-nov" }, { cookie, accept: "application/json" });
    const body = await j.json();
    const last = w.rows[w.rows.length - 1];
    check("router: JSON when asked; the member and page come from the token, never the body", j.status === 200 && body.ok === true && last.userId === JORDAN && last.pageId === PAGE && last.value === "See you there");
    check("Co-only: a member's post never changes the page's content", w.updates.length === 0 && pages[PAGE].data.title === "Supper at the Loft" && pages[PAGE].data.notes === "Doors at 7.");
    const cross = await post(`/e/${PAGE}/actions/rsvp`, { value: "going" }, { cookie, origin: "https://evil.example" });
    check("router: a cross-site post is refused", cross.status === 403);
    const unknown = await post(`/e/${PAGE}/actions/edit`, { title: "x" }, { cookie });
    check("router: there is no edit action", unknown.status === 404);
    const archived = await post(`/e/${PAGE}/actions/rsvp`, { value: "going" }, { cookie: `co_ep=${ID.issueMemberToken(PAGE, ARCHIVED, { key: KEY })}` });
    check("router: an archived member's token acts on nothing", archived.status === 401);
  } finally {
    server.close();
  }
  check("Co-only: the routes never write page content", !/updateEventPage|updatePage\(/.test(src("routes/eventPageActions.ts")));
}

// ---------------------------------------------------------------- 7. Co updates the page (Co's tool only)
{
  const w = world();
  const q = await A.takeAction(PAGE, NOOR, { kind: "question", text: "Is there street parking near the venue on a Friday night?" }, w.actionDeps);
  await A.takeAction(PAGE, JORDAN, { kind: "comment", text: "Excited to meet everyone at the loft" }, w.actionDeps);
  const qid = q.ok ? q.action!.id : "0";
  const apply = (question: string, answer: string, by: any = "co") => A.applyInteractionUpdates(PAGE, { answer: { by, questionId: qid, question, answer } }, w.updateDeps);
  check("Co-only: an answer not by Co is refused", !(await apply("Where can guests park?", "There's a garage on Pine.", "member")).ok && w.updates.length === 0);
  check("Co-only: a member's words pasted onto the page are refused", !(await apply("Is there street parking near the venue on a Friday night?", "Yes.")).ok && w.updates.length === 0);
  check("Co-only: a member's words pasted into the answer are refused", !(await apply("Where can guests park?", "Excited to meet everyone at the loft, and there's a garage.")).ok);
  check("Co-only: naming a member is refused", !(await apply("Where can guests park?", "Noor asked, and there's a garage on Pine.")).ok);
  check("Co-only: Co's voice (no dash, no exclamation point)", !(await apply("Where can guests park?", "There's a garage on Pine — easy.")).ok && !(await apply("Where can guests park?", "There's a garage on Pine!")).ok);
  check("Co-only: markup is refused", !(await apply("Where can guests park?", "<a href=x>Garage</a> on Pine.")).ok);
  check("Co-only: a question from another page is refused", !(await A.applyInteractionUpdates("rooftop-nov", { answer: { by: "co", questionId: qid, question: "Where can guests park?", answer: "A garage on Pine." } }, w.updateDeps)).ok);
  const good = await apply("Where can guests park?", "There's a garage on Pine Street a block away, open late.");
  check("Co updates the page: its own Q and A go into the notes, through the content layer, version bumped", good.ok && good.version !== null && w.updates.length === 1 && w.updates[0].data.notes.startsWith("Doors at 7.") && /Q: Where can guests park\?\nA: There's a garage on Pine Street/.test(w.updates[0].data.notes) && w.updates[0].data.title === "Supper at the Loft");
  pages[PAGE] = { ...pages[PAGE], data: w.updates[0].data };
  await apply("Where can guests park?", "There's a garage on Pine Street a block away, open late.");
  check("Co updates the page: the same question isn't added twice", w.updates.length === 1);
  const derived = await A.applyInteractionUpdates(PAGE, {}, w.updateDeps);
  check("derived: recomputes the headcount and writes nothing", derived.ok && w.updates.length === 1 && "headcountLine" in derived.derived);

  // The task turn's tool: only with the flag on and only for a page-question task.
  const goal = A.questionGoal("Supper at the Loft", "https://co.example/e/dinner-oct", PAGE, qid);
  check("tool: off with the flag off", Object.keys(A.eventPageTools({ goal }, OFF)).length === 0);
  check("tool: absent on an ordinary task", Object.keys(A.eventPageTools({ goal: "Find a venue for 20 by Friday" }, ON)).length === 0);
  const tools = A.eventPageTools({ goal }, ON, () => w.updateDeps);
  const res = await tools.answerOnEventPage.execute({ question: "What should guests wear?", answer: "Smart casual. It gets cool on the terrace, so bring a layer." }, { toolCallId: "t1", messages: [] });
  check("tool: Co's answer reaches the page through applyInteractionUpdates", res.ok === true && w.updates.length === 2 && /Q: What should guests wear\?/.test(w.updates[1].data.notes));
  check("tool: wired into the task turn", /\.\.\.eventPageTools\(task\)/.test(src("services/taskTurn.ts")));
}

check("flag: only the exact on-values turn it on", A.actionsEnabled({ EVENT_PAGE_ACTIONS_ENABLED: "true" } as any) && A.actionsEnabled({ EVENT_PAGE_ACTIONS_ENABLED: "1" } as any) && !A.actionsEnabled({ EVENT_PAGE_ACTIONS_ENABLED: "false" } as any) && !A.actionsEnabled({} as any));
check("migration: event_page_actions with the kind check, one live RSVP per member per page", /CREATE TABLE IF NOT EXISTS event_page_actions[\s\S]{0,400}kind IN \('rsvp','reaction','comment','question'\)[\s\S]{0,300}retracted_at TIMESTAMPTZ/.test(src("db/migrations.ts")) && /event_page_actions_one_rsvp ON event_page_actions \(page_id, user_id\) WHERE kind = 'rsvp' AND retracted_at IS NULL/.test(src("db/migrations.ts")));
check("text replies read page activity", /TEXT_KNOWLEDGE[^\n]*"pageActivity"/.test(src("services/turnContext.ts")));

console.log(`event page actions: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
