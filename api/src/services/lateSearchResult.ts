// A texted search that runs past the reply's time cap used to be thrown away,
// and the member heard "nothing" (2026-09-17: a Sep 24 search hit the 45s cap).
// Now the search keeps going and, when it lands, the best fitting result is
// sent as the answer to what they asked: through sendExempt (idempotent, local
// hours, opt-out) rather than the daily pick, because they asked for it.
import { draftEventReveal } from "../agent/eventDiscoverySurfacing.js";
import { recordDecision } from "../harness/core.js";
import { sendExempt } from "../harness/proactive.js";
import { enrichMatch } from "./eventDetails.js";
import { matchKey } from "./eventSurfacingSweep.js";
import { getTimezoneForCity } from "./geocoding.js";
import { recordRecommendationsSent, type RecommendationResult } from "./recommendation.js";

export async function sendLateSearchResult(
  person: { userId: string; firstName: string | null; phoneNumber: string; city: string | null },
  askText: string,
  result: RecommendationResult,
): Promise<void> {
  // Co told them it would send what turns up, so an empty result still gets
  // an honest follow-up rather than silence.
  const sendNothingNote = async (action: string, extra: Record<string, unknown> = {}) => {
    const sent = await sendExempt({
      userId: person.userId,
      phoneNumber: person.phoneNumber,
      type: "search_result",
      targetKey: `search_result:none:${Date.now()}`,
      messages: ["Came up empty on that one for now. I'll keep looking and send anything good my way."],
    });
    await recordDecision({ layer: 5, decision: "recommendation.lateResult", userId: person.userId, outcome: "skip", action: `${action}${sent.sent ? "_told_them" : ""}`, proposal: { askText, ...extra } });
  };
  if (!result.available || !result.matches?.length) {
    await sendNothingNote("nothing_found");
    return;
  }
  const timezone = person.city ? await getTimezoneForCity(person.city).catch(() => null) : null;
  // The first one that fits, trying at most three.
  for (const match of result.matches.slice(0, 3)) {
    const em = await enrichMatch(match, { userId: person.userId, firstName: person.firstName ?? "there", askText, city: person.city });
    if (em.fits === false) continue;
    const draft = await draftEventReveal({ firstName: person.firstName ?? "there" }, askText, false, em);
    if (!draft) continue;
    const sent = await sendExempt({
      userId: person.userId,
      phoneNumber: person.phoneNumber,
      type: "search_result",
      targetKey: `search_result:${matchKey(match)}`,
      messages: draft.messages,
      // They just texted asking for this; it's an answer, not an outreach.
      timezone,
      respectHours: false,
    });
    if (sent.sent) await recordRecommendationsSent(person.userId, [match]).catch(() => {});
    await recordDecision({
      layer: 5,
      decision: "recommendation.lateResult",
      userId: person.userId,
      outcome: sent.sent ? "act" : "skip",
      action: sent.sent ? "sent" : `not_sent: ${sent.reason ?? "unknown"}`,
      proposal: { askText, name: match.name, tier: match.tier },
    });
    return;
  }
  await sendNothingNote("none_fit", { found: result.matches.map((m) => m.name) });
}
