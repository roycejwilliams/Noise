// No-shows are held out of matching until they arrive (Royce, 2026-10-14, from the room simulation: a guest sharing their
// location who never came was still proposed to others mid-night). Zero tokens, invented people, test-range numbers.
//   npx tsx evals/inroom/noShows.ts
import { W, reset, addMember, addEvent, ask, check, results } from "./world.js";

const S = await import("../../src/services/eventScoring.js");
const settle = () => new Promise((r) => setTimeout(r, 30));
const pass = async (ev: string) => {
  W.scoringDebounce.clear();
  await S.scoreGuestListForEvent(ev);
  await settle();
};
const nudge = (ev: string, personId: string) => W.nudges.find((n) => n.event_id === ev && n.person_id === personId && n.candidate_id);

{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: [ask("a seed investor for climate hardware")] });
  const noor = addMember({ first_name: "Noor", intent: [ask("backing climate hardware founders at seed", "offering")] });
  W.scorer = () => ({ score: 88, share: true });
  addEvent({ api_id: "ev", name: "Noise Supper" }, [{ m: jordan }, { m: noor }]);
  // Jordan doesn't share their location (counts as in the room); Noor shares and hasn't arrived.
  W.presence.set(`ev|${noor.id}`, { sharing_seen_at: new Date(), arrived_at: null });
  const roster = await S.inRoomPool("ev");
  check("a guest sharing their location who hasn't arrived is not in the room", !roster.some((g) => g.user_id === noor.id));
  check("a registered guest who doesn't share still is", roster.some((g) => g.user_id === jordan.id));
  await pass("ev");
  check("nobody is pointed at someone Cue can see isn't there yet", !nudge("ev", jordan.id) && W.sent.length === 0, W.sent);
  W.presence.set(`ev|${noor.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
  await pass("ev");
  check("once they arrive, they're matched like anyone", nudge("ev", jordan.id)?.candidate_id === noor.id && nudge("ev", noor.id)?.candidate_id === jordan.id);
}
{
  reset();
  const ada = addMember({ first_name: "Ada", intent: [ask("a seed investor for climate hardware")] });
  const remy = addMember({ first_name: "Remy", intent: [ask("backing climate hardware founders at seed", "offering")] });
  W.scorer = () => ({ score: 88, share: true });
  // Two hours in, still sharing and not there: a no-show stays out (the old hour-in fallback no longer puts them in the room).
  addEvent({ api_id: "ev2", name: "Noise Supper", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString() }, [{ m: ada }, { m: remy }]);
  W.presence.set(`ev2|${remy.id}`, { sharing_seen_at: new Date(Date.now() - 3 * 3_600_000), arrived_at: null });
  await pass("ev2");
  check("a no-show is never proposed, however late in the night", !nudge("ev2", ada.id) && !nudge("ev2", remy.id));
}

{
  reset();
  const ellis = addMember({ first_name: "Ellis", intent: [ask("a seed investor for climate hardware")] });
  const sarah = addMember({ first_name: "Sarah", intent: [ask("backing climate hardware founders at seed", "offering")] });
  W.scorer = () => ({ score: 88, share: true });
  addEvent({ api_id: "ev3", name: "Noise Supper" }, [{ m: ellis }, { m: sarah }]);
  // Sarah shared, then stopped before Cue saw her arrive: Cue can't see where she is, so she counts as in the room, like anyone
  // registered who doesn't share (review of #215).
  W.presence.set(`ev3|${sarah.id}`, { sharing_seen_at: new Date(Date.now() - 20 * 60_000), location_stopped_at: new Date(), arrived_at: null });
  const roster = await S.inRoomPool("ev3");
  check("a guest who stopped sharing before arriving is back in the room, not held all night", roster.some((g) => g.user_id === sarah.id));
  await pass("ev3");
  check("... and is matched like anyone", nudge("ev3", ellis.id)?.candidate_id === sarah.id);
  check("... and is told about her match right away, not held waiting for an arrival Cue can't see", nudge("ev3", sarah.id)?.candidate_id === ellis.id, W.nudges);
}
{
  const P = await import("../../src/services/eventPresence.js");
  const start = new Date().toISOString();
  check("the arrival wait: sharing and not arrived waits; stopped sharing doesn't", !P.arrivalWaitCheck({ sharing_seen_at: new Date(), arrived_at: null }, start, new Date()).pass && P.arrivalWaitCheck({ sharing_seen_at: new Date(), arrived_at: null, location_stopped_at: new Date() }, start, new Date()).pass);
}

const { total, failed } = results;
console.log(`no-shows held out: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
