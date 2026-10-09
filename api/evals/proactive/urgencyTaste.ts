// From the 2:45 send review (Royce, 2026-10-09). Zero tokens.
//   1. a find whose useful life ends before the next realistic send slot goes ahead of a debrief or follow-up that can wait
//   2. what kind of room a member says they want ranks what the picker sends them
//   (a) a find expiring today beats a pending debrief; (b) one with days left doesn't jump; (c) stated taste visibly shifts the
//   picker's ranking; (d) the debrief itself is unchanged: it asks, never assumes
//   npx tsx evals/proactive/urgencyTaste.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const P = await import("../../src/harness/proactive.js");
const SS = await import("../../src/services/sweepSelect.js");
const SC = await import("../../src/services/sweepSelectContext.js");
const MK = await import("../../src/services/memberKnowledge.js");
const RT = await import("../../src/services/roomTaste.js");
const R = await import("../../src/harness/proactiveRegistry.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const SF = "America/Los_Angeles";
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-09T21:45:00Z"); // 2:45pm Pacific, the real send
const cand = (id: string, type: any, o: { lastDay?: string; expiresAt?: string; priority?: number } = {}) => ({
  id, userId: "u", type, targetKey: id, topicKey: id, summary: id, priority: o.priority ?? 60, dueAt: at("2026-10-09T17:00:00Z"),
  expiresAt: o.expiresAt ? at(o.expiresAt) : null, payload: o.lastDay ? { lastDay: o.lastDay, picked: true } : { picked: true }, attempts: 0, createdAt: at("2026-10-09T17:00:00Z"),
}) as any;

// (a) A picked find whose end comes before its next realistic slot goes ahead of a debrief.
const fleetPayload = (o: { fromProfile?: boolean } = {}) => ({ lastDay: "2026-10-09", picked: true, askId: o.fromProfile ? "profile" : "8d557f32", fromProfile: !!o.fromProfile });
const withPayload = (c: any, payload: any) => ({ ...c, payload });
const sendRec = (type: string, iso: string, exempt = false) => ({ type, targetKey: `${type}:${iso}`, topicKey: null, sentAt: at(iso), exempt });
{
  const debrief = cand("275", "debrief", { priority: 80 });
  const fleet = withPayload(cand("278", "event_offer", { expiresAt: "2026-10-10T06:59:59Z", priority: 95 }), fleetPayload());
  const pitch = withPayload(cand("277", "event_offer"), { picked: true, askId: "a" });
  // The real 2:45: Fleet Week answers an ask (uncapped) and the debrief is an answer too, so a 5:45pm slot was still there.
  check("the honest 2:45 replay: Fleet Week still had a 5:45pm slot, so it doesn't jump (review of #132)", P.expiringFind([debrief, fleet, pitch], { now: NOW, zone: SF, sends: [] }) === null);
  // At 7pm the next slot (10pm) is past their hours: tomorrow 8am, after Fleet Week ends.
  const late = P.expiringFind([debrief, fleet, pitch], { now: at("2026-10-10T02:00:00Z"), zone: SF, sends: [] });
  check("at 7pm, Fleet Week on its last day goes ahead of the debrief", late?.pick.id === "278", late);
  check("its end is before the next realistic slot (tomorrow 8am)", !!late && late.endsAt.getTime() <= late.nextSlot.getTime() && late.nextSlot.toISOString() === "2026-10-10T15:00:00.000Z");
  // A counted find (from their profile) whose lane already used today's slot: its next slot is tomorrow, at 2:45.
  const profileFind = withPayload(cand("281", "event_offer", { expiresAt: "2026-10-10T06:59:59Z" }), fleetPayload({ fromProfile: true }));
  const used = P.expiringFind([debrief, profileFind], { now: NOW, zone: SF, sends: [sendRec("event_offer", "2026-10-09T17:00:00Z")] });
  check("a counted find whose room-lane slot is used today goes at 2:45 (tomorrow is too late)", used?.pick.id === "281", used);
  check("the debrief (an answer) doesn't use the find's slot; a counted send in another lane doesn't either", P.expiringFind([debrief, profileFind], { now: NOW, zone: SF, sends: [sendRec("companion", "2026-10-09T17:00:00Z")] }) === null);
  const lane = P.nextSendSlot({ now: NOW, zone: SF, findLane: "room", findCounted: true, countedToday: { room: 0, other: 0 }, other: { lane: "room", counted: true } });
  check("the other send counts against the find's slot only when it's counted and in the same lane", lane.toISOString() === "2026-10-10T15:00:00.000Z" && P.nextSendSlot({ now: NOW, zone: SF, findLane: "room", findCounted: true, countedToday: { room: 0, other: 0 }, other: { lane: "other", counted: true } }).toISOString() === "2026-10-10T00:45:00.000Z");
  check("an uncapped find waits only on spacing and hours (5:45pm)", P.nextSendSlot({ now: NOW, zone: SF, findLane: "room", findCounted: false, countedToday: { room: 5, other: 5 }, other: null }).toISOString() === "2026-10-10T00:45:00.000Z");
  check("a find's end is its own expiry or the end of its last day, whichever is first", P.findEndsAt(fleet, SF)?.toISOString() === "2026-10-10T06:59:59.000Z" && P.findEndsAt(cand("x", "event_offer", { lastDay: "2026-10-09" }), SF)?.toISOString() === "2026-10-10T06:59:59.999Z");
  const px = src("harness/proactive.ts");
  check("dispatch picks the expiring find before asking Co to choose, with the reason logged", /const urgent = expiringFind\(ev\.eligible, \{ now: state\.now, zone: person\.timezone, sends: state\.sends \}\);/.test(px) && /expires before the next send slot \(ends/.test(px) && /: await choosePick\(ev\.eligible/.test(px));
  check("the bundle still forms around it (leadPick), so its siblings ride along", /const c = leadPick\(picked\.pick, ev\.eligible\);/.test(px));
}

// (b) What doesn't jump.
{
  const debrief = cand("275", "debrief");
  const SEVEN = at("2026-10-10T02:00:00Z");
  const picked = (id: string, o: any) => withPayload(cand(id, "event_offer", o), { picked: true, askId: "a", ...(o.lastDay ? { lastDay: o.lastDay } : {}) });
  check("a find with days left doesn't jump the queue", P.expiringFind([debrief, picked("f", { lastDay: "2026-10-12" })], { now: SEVEN, zone: SF, sends: [] }) === null);
  check("a find ending tomorrow night doesn't jump (tomorrow 8am is still a slot for it)", P.expiringFind([debrief, picked("f", { lastDay: "2026-10-10" })], { now: SEVEN, zone: SF, sends: [] }) === null);
  check("a find with no end date doesn't jump", P.expiringFind([debrief, picked("f", {})], { now: SEVEN, zone: SF, sends: [] }) === null);
  for (const t of ["post_call", "pre_arrival", "event_brief", "brief_name_ask", "ask_solicitation", "membership_lapse"]) check(`never past a ${t}`, P.expiringFind([cand("x", t), picked("f", { lastDay: "2026-10-09" })], { now: SEVEN, zone: SF, sends: [] }) === null);
  check("never past something else that ends first", P.expiringFind([cand("w", "window_followup", { expiresAt: "2026-10-10T04:00:00Z" }), picked("f", { lastDay: "2026-10-09" })], { now: SEVEN, zone: SF, sends: [] }) === null);
  check("a find the daily picker didn't choose doesn't jump (taste was never weighed)", P.expiringFind([debrief, withPayload(cand("f", "event_offer"), { lastDay: "2026-10-09", askId: "a" })], { now: SEVEN, zone: SF, sends: [] }) === null);
  check("only finds ready: nothing to jump (Co picks, the bundle forms)", P.expiringFind([picked("f", { lastDay: "2026-10-09" }), picked("g", {})], { now: SEVEN, zone: SF, sends: [] }) === null);
  check("a find already past its end isn't picked", P.expiringFind([debrief, picked("f", { expiresAt: "2026-10-09T20:00:00Z" })], { now: SEVEN, zone: SF, sends: [] }) === null);
  const two = P.expiringFind([debrief, picked("late", { lastDay: "2026-10-09" }), picked("soon", { expiresAt: "2026-10-10T05:00:00Z" })], { now: SEVEN, zone: SF, sends: [] });
  check("two expiring: the one ending first leads", two?.pick.id === "soon", two);
}

// (c) Stated taste ranks the picks.
{
  const TASTE = RT.roomTasteLine({ wants: "a room where they can drop their guard", avoids: "performative networking", quote: "I feel like everything is performative. I'm looking to be in a room that I can drop my guard" });
  const pool = [
    { id: "C1", key: "k1", name: "Pitch Protocol", date: null, tier: 2, kind: "discovery" as const, asks: [] },
    { id: "C2", key: "k2", name: "Founder supper, eight people", date: null, tier: 2, kind: "discovery" as const, asks: [] },
    { id: "C3", key: "k3", name: "Pawn Shop Chess Club", date: null, tier: 2, kind: "discovery" as const, asks: [] },
    { id: "C4", key: "k4", name: "Builders who Run", date: null, tier: 2, kind: "discovery" as const, asks: [] },
  ];
  const ctx = (roomTaste?: string[]) => ({ firstName: "R", city: "SF", today: "2026-10-09", weekday: "Friday", asks: [{ id: "A1", text: "founders", since: "2026-10-08" }], texts: [], sent: [], outcomes: [], feeling: null, discoveryLeft: 4, pool, roomTaste }) as any;
  const send = (id: string, taste: string) => ({ id, verdict: "send" as const, whyMember: "fits", cites: ["A1"], whyNow: "this week", wow: true, lastDay: null, taste: taste as any });
  // The model ranks Pitch Protocol first, but says it clashes with the room they asked for.
  const verdicts = [send("C1", "clashes"), send("C2", "matches"), send("C3", "neutral"), send("C4", "matches")];
  const before = SS.guardVerdicts(ctx(), verdicts);
  const after = SS.guardVerdicts(ctx([TASTE]), verdicts);
  const sent = (j: any[]) => j.filter((x) => x.verdict === "send").map((x) => x.id).join(",");
  check("without stated taste, the model's order fills the slots (Pitch Protocol first)", sent(before) === "C1,C2,C3", before.map((x) => [x.id, x.verdict]));
  check("after they said what room they want, the matches take the slots and the clash is held", sent(after) === "C2,C3,C4" && after.find((x) => x.id === "C1")?.verdict === "hold", after.map((x) => [x.id, x.verdict, x.taste]));
  check("the held clash says why (visible in the picker's log)", /clashes with the room they said they want/.test(after.find((x) => x.id === "C1")?.guard ?? ""));
  check("every judgment carries its taste fit", after.filter((x) => x.verdict === "send").every((x) => x.taste === "matches" || x.taste === "neutral"));
  check("slotOrder: answers first, then within each kind matches, neutral, clashes", JSON.stringify(SS.slotOrder([{ at: 0, kind: "discovery", taste: "clashes" }, { at: 1, kind: "answer", taste: "neutral" }, { at: 2, kind: "discovery", taste: "matches" }, { at: 3, kind: "answer", taste: "matches" }])) === "[3,1,2,0]");
  check("the model's taste is read from its answer (unknown = neutral)", SS.parseVerdicts('{"verdicts":[{"id":"C1","verdict":"send","whyMember":"x","cites":["A1"],"whyNow":"y","wow":true,"taste":"clashes"},{"id":"C2","verdict":"send","whyMember":"x","cites":["A1"],"whyNow":"y","wow":true,"taste":"loves"}]}')?.map((v: any) => v.taste).join() === "clashes,neutral");
  const prompt = SS.selectPrompt(ctx([TASTE]));
  check("the picker is told the room they want, in their words, and to rank by it", /WHAT KIND OF ROOM THEY'VE TOLD CO THEY WANT/.test(prompt) && prompt.includes("drop my guard") && /Rank by it/.test(prompt));
  check("no stated taste, no section", !/WHAT KIND OF ROOM/.test(SS.selectPrompt(ctx())));
  check("new taste re-runs the picker the same day (its signature changes)", SS.selectSignature(ctx()) !== SS.selectSignature(ctx([TASTE])));
  const sh = src("services/sweepShadow.ts");
  check("the once-a-day guard lets a run through when a taste was saved after today's run", /AND NOT EXISTS \(SELECT 1 FROM co_memories m WHERE m\.user_id = \$1 AND m\.memory_type = 'room_taste' AND m\.created_at > d\.created_at\)/.test(sh));
  check("saving a taste re-runs the picker for them now, in the background", /recordRoomTaste\(ctx\.userId, taste\);\s*\/\/[^\n]*\n\s*void import\("\.\.\/services\/sweepShadow\.js"\)\.then\(\(m\) => m\.rerunPickerForTaste\(ctx\.userId\)\)/.test(src("agent/conversationTools.ts")) && /export async function rerunPickerForTaste[\s\S]{0,400}if \(!reviewEnabled\(\) \|\| !\(await shadowUserIds\(\)\)\.includes\(userId\)\) return;/.test(sh));
  // Through the shared layer: a stored taste reaches the picker and the daily pick.
  const k = await MK.memberKnowledge("u", { include: ["preferences"] }, {
    profile: async () => ({ firstName: "R", city: "SF", goals: [], intent: [], updatedAt: new Date() }), zone: async () => SF, linkedNames: async () => [],
    taste: async () => ({ text: "From what they've told Co about things it sent, they said weren't for them: Pitch Protocol.", at: new Date("2026-10-01T00:00:00Z") }),
    roomTaste: async () => [{ text: TASTE, at: new Date("2026-10-09T21:53:00Z") }],
  });
  check("member knowledge carries stated taste first, then how sends landed", k.preferences[0]?.source === "stated" && k.preferences[1]?.source === "taste", k.preferences);
  const facts = SC.factsFromKnowledge({ ...k, goals: [], exchanges: [], delivered: [], carrying: [], corrections: [], lessons: [], restraint: null } as any);
  check("the picker's facts carry it as its own section, not buried in learned", facts.roomTaste?.[0] === TASTE && !(facts.learned ?? []).some((l) => l.includes("drop my guard")), facts);
  const block = P.memberDraftBlock(k as any, MK.memberRules(k));
  check("Co's own drafts see it as what they want, not as what landed", /What kind of room they've said they want \(their words\)/.test(block) && /What has landed with them before/.test(block));
  // Capture: their words, through a tool, not the team log.
  check("room_taste is an allowed memory type (co_memories_memory_type_check), so the write can land", /"room_taste",\s*\];/.test(src("db/migrations.ts")) && RT.ROOM_TASTE_MEMORY === "room_taste");
  check("what they want or avoid has to come from their quote (review of #132)", RT.tasteUnbacked({ wants: "a room where they can drop their guard", avoids: "performative events", quote: "I feel like everything is performative. I'm looking to be in a room that I can drop my guard" }) === null && RT.tasteUnbacked({ avoids: "loud parties", quote: "I'm so tired lately" }) !== null && RT.tasteUnbacked({ wants: "small rooms", quote: "smaller" }) !== null);
  check("the tool refuses a taste its quote doesn't back", /const off = \(await import\("\.\.\/services\/roomTaste\.js"\)\)\.tasteUnbacked\(\{ wants, avoids, quote \}\);/.test(src("agent/conversationTools.ts")));
  check("a taste rerun is only for members the picker serves, at most 3 saves a day", /if \(!reviewEnabled\(\) \|\| !\(await shadowUserIds\(\)\)\.includes\(userId\)\) return;/.test(src("services/sweepShadow.ts")) && /tool: "noteRoomTaste",\s*limits: \{ perTurn: 1, perDay: 3 \}/.test(src("services/capabilities.ts")));
  check("the daily pick gets stated taste as its own line, not mixed into what landed", /const statedTaste = known\?\.preferences\.filter\(\(p\) => p\.source === "stated"\)/.test(src("harness/proactive.ts")) && /What kind of room they've said they want \(their words\): \$\{about\.statedTaste\}/.test(src("harness/proactive.ts")));
  check("a stored taste reads back; a malformed one is ignored", RT.parseRoomTaste(JSON.stringify({ wants: "small rooms", avoids: null, quote: "smaller, no pitching" }))?.wants === "small rooms" && RT.parseRoomTaste("not json") === null && RT.parseRoomTaste(JSON.stringify({ quote: "x" })) === null);
  const cap = src("services/capabilities.ts");
  check("noteRoomTaste is a capability Co chooses, and team feedback points room taste to it", /tool: "noteRoomTaste"/.test(cap) && /isn't feedback for the team: note it with noteRoomTaste/.test(cap));
  const ct = src("agent/conversationTools.ts");
  const tool = ct.slice(ct.indexOf("noteRoomTaste: tool({"), ct.indexOf("noteReaction: tool({"));
  check("the tool stores only their own words (quote checked, teammate talk skipped)", tool.includes("T.wordsAreTheirs(quote,") && tool.includes("notToTeammate()") && tool.includes("recordRoomTaste(ctx.userId, taste)") && tool.indexOf("wordsAreTheirs") < tool.indexOf("recordRoomTaste"));
}

// (d) The debrief is unchanged: it asks, never assumes.
{
  check("Royce's \"I haven't went to any of the events you've sent\" isn't attendance", !R.attendanceConfirmed({ eventName: "State of AI Report 2026 launch event", checkinFollowupIds: [], walkinCheckinIds: [] }, ["User said: I haven't went to any of the events you've sent"]));
  check("the 2:45 debrief's wording passes; a presumed one is still caught", !R.PRESUMES_THEY_WENT.test("Hey, did you end up making it to the State of AI Report 2026 launch event last night?") && R.PRESUMES_THEY_WENT.test("How was the State of AI launch?"));
  check("the debrief task for an unconfirmed event is unchanged", /nothing says they went\. Ask, lightly, whether they ended up making it/.test(src("harness/proactiveRegistry.ts")));
}

console.log(`urgency + taste: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
