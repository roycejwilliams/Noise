// Model-free checks for the Jev twins of Co's classifiers (services/jev.ts,
// services/jevClassifiers.ts, services/jevRouter.ts). A fake client stands in
// for TypeSafe, so this makes no network call and needs no key:
//   npx tsx evals/jev/rules.ts
import "dotenv/config";
import { askJev, jevKey, jevShadowEnabled, setJevClientForTests, type JevAnswer, type JevClientLike, type JevQuestion } from "../../src/services/jev.js";
import { jevCallOffer, jevConsent, jevIssue, jevRelevance, jevSameAsk, shadow } from "../../src/services/jevClassifiers.js";
import { routeWithJev } from "../../src/services/jevRouter.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

const noul = (p: number): JevAnswer => ({ type: "noul", noul: p });
const choice = (c: string, conf = 0.95): JevAnswer => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf } });

let lastState: any = null;
let calls = 0;
const fake = (answers: Record<string, JevAnswer> | ((qs: Record<string, JevQuestion>) => Record<string, JevAnswer>)): JevClientLike => ({
  async systemOne(req) {
    calls++;
    lastState = req.state;
    return { answers: typeof answers === "function" ? answers(req.questions) : answers, usage: { input_tokens: 10, output_tokens: 2 } };
  },
});

async function main() {
  const savedKey = process.env.TYPESAFE_API_KEY;
  const savedJev = process.env.jev_co;

  // Shadow is dev-only, opted in per classifier, keyed.
  const on = { RAILWAY_ENVIRONMENT_NAME: "dev", RAILWAY_SERVICE_NAME: "co-test", JEV_SHADOW: "relevance", TYPESAFE_API_KEY: "k" } as NodeJS.ProcessEnv;
  check("shadow on for the named classifier", jevShadowEnabled(on, "relevance"));
  check("shadow off for a classifier not named", !jevShadowEnabled(on, "router") && !jevShadowEnabled(on, "consent") && !jevShadowEnabled(on, "issue"));
  check("shadow off when no classifier is asked about", !jevShadowEnabled(on));
  check("names are case-insensitive and can be a list", jevShadowEnabled({ ...on, JEV_SHADOW: "Relevance, callOffer" } as NodeJS.ProcessEnv, "calloffer"));
  check("all enables every classifier", jevShadowEnabled({ ...on, JEV_SHADOW: "all" } as NodeJS.ProcessEnv, "router"));
  check("a bare true enables nothing", !jevShadowEnabled({ ...on, JEV_SHADOW: "true" } as NodeJS.ProcessEnv, "relevance"));
  check("shadow off in production", !jevShadowEnabled({ ...on, RAILWAY_ENVIRONMENT_NAME: "production" }, "relevance"));
  check("shadow off on another service", !jevShadowEnabled({ ...on, RAILWAY_SERVICE_NAME: "api" }, "relevance"));
  check("shadow off without the flag", !jevShadowEnabled({ ...on, JEV_SHADOW: undefined }, "relevance"));
  check("shadow off without a key", !jevShadowEnabled({ ...on, TYPESAFE_API_KEY: undefined }, "relevance"));
  check("shadow on with the key under its Railway name jev_co", jevShadowEnabled({ ...on, TYPESAFE_API_KEY: undefined, jev_co: "k" } as NodeJS.ProcessEnv, "relevance"));
  check("key lookup reads either name", jevKey({ jev_co: "a" } as NodeJS.ProcessEnv) === "a" && jevKey({ TYPESAFE_API_KEY: "b" } as NodeJS.ProcessEnv) === "b" && jevKey({} as NodeJS.ProcessEnv) === undefined);

  // Fails open.
  setJevClientForTests(null);
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.jev_co;
  check("no key: askJev returns null", (await askJev({}, { q: { type: "noul", instructions: "x" } })) === null);
  setJevClientForTests({
    async systemOne() {
      throw Object.assign(new Error("secret member text in message"), { status: 500 });
    },
  });
  check("client error: askJev returns null", (await askJev({}, { q: { type: "noul", instructions: "x" } })) === null);

  // Shadow wrapper does nothing off co-test (this process is not co-test).
  calls = 0;
  setJevClientForTests(fake({ a: noul(0.9) }));
  await shadow("t", null, { x: 1 }, async () => (await askJev({}, { a: { type: "noul", instructions: "x" } })), () => true);
  check("shadow wrapper makes no call when disabled", calls === 0);

  // Issue reports
  setJevClientForTests(fake({ is_issue: noul(0.9), category: choice("wrong_info"), severity: choice("high") }));
  let issue = await jevIssue("you made that up", "Co: it's at 7\nMe: you made that up", ["bug", "wrong_info", "other"]);
  check("issue: yes maps through", !!issue && issue.isIssue && issue.category === "wrong_info" && issue.severity === "high");
  setJevClientForTests(fake({ is_issue: noul(0.2), category: choice("other"), severity: choice("low") }));
  issue = await jevIssue("rough week", "", ["bug", "other"]);
  check("issue: low probability is not an issue", !!issue && !issue.isIssue);
  setJevClientForTests(fake({ is_issue: noul(0.5), category: choice("other"), severity: choice("low") }));
  check("issue: threshold is inclusive at 0.5", !!(await jevIssue("x", "", ["other"]))?.isIssue);
  setJevClientForTests(fake({}));
  check("issue: missing answer returns null (fails open)", (await jevIssue("x", "", ["other"])) === null);
  setJevClientForTests(fake({ is_issue: noul(0.9), category: choice("bug"), severity: choice("low") }));
  await jevIssue("x", "a".repeat(5000), ["bug"]);
  check("issue: conversation is trimmed before sending", String(lastState.recent_conversation).length <= 1500);

  // Call offer, same ask, consent, relevance
  setJevClientForTests(fake((qs) => Object.fromEntries(Object.keys(qs).map((k) => [k, noul(0.8)]))));
  check("call offer: yes", (await jevCallOffer("want me to call you?"))?.offers === true);
  check("same ask: yes", (await jevSameAsk("a", "b"))?.same === true);
  check("consent: violation", (await jevConsent("Sam wants to meet you", { recipient: "Ana", other: "Sam", otherOptedIn: false, otherStatedAsks: [] }))?.violation === true);
  check("relevance: fit", (await jevRelevance("chess", "Chess night", "SF", "weekly chess"))?.fit === true);
  setJevClientForTests(fake((qs) => Object.fromEntries(Object.keys(qs).map((k) => [k, noul(0.1)]))));
  check("call offer: no", (await jevCallOffer("here's the link"))?.offers === false);
  check("relevance: not fit", (await jevRelevance("chess", "Hackathon", "SF", "build all day"))?.fit === false);
  await jevRelevance("chess", "e", "SF", "d".repeat(9000));
  check("relevance: description is trimmed", JSON.stringify(lastState).length < 3000);

  // Router
  const items = [
    { id: "call_offer:1", kind: "call_offer" as const, description: "Co offered to call them", detail: {}, askedAt: null },
    { id: "match_nudge:2", kind: "match_nudge" as const, description: "Co suggested meeting Sam", detail: {}, askedAt: null },
  ];
  const base = { message: "yes", recentConversation: "Co: want me to call?\nMe: yes", openItems: items } as any;
  const answers = (over: Record<string, JevAnswer>) => fake({
    call: choice("none"), wants_recommendation: noul(0.02), wants_invite: noul(0.01), asks_for_updates: noul(0.01),
    reply_0: noul(0.05), value_0: choice("accept"), reply_1: noul(0.05), value_1: choice("yes"), ...over,
  });

  setJevClientForTests(answers({ reply_0: noul(0.97), value_0: choice("accept", 0.96) }));
  let r = await routeWithJev(base);
  check("router: picks the waiting call offer", r?.output.answers?.itemId === "call_offer:1" && r.output.answers.value === "accept");
  check("router: high confidence when everything is sure", r?.output.confidence === "high");
  check("router: no free-text fields invented", r?.output.reason === "jev");

  setJevClientForTests(answers({ reply_0: noul(0.9), reply_1: noul(0.88) }));
  r = await routeWithJev(base);
  check("router: two close replies are ambiguous, nothing answered", !!r && r.output.answers === null && r.output.ambiguousBetween.length === 2);

  setJevClientForTests(answers({ reply_0: noul(0.9), reply_1: noul(0.2) }));
  r = await routeWithJev(base);
  check("router: a clear winner is not ambiguous", !!r && r.output.ambiguousBetween.length === 0 && r.output.answers?.itemId === "call_offer:1");

  setJevClientForTests(answers({ reply_0: noul(0.3), reply_1: noul(0.2) }));
  r = await routeWithJev(base);
  check("router: no reply above threshold means no answer", !!r && r.output.answers === null && r.output.ambiguousBetween.length === 0);

  setJevClientForTests(answers({ reply_0: noul(0.9), value_0: choice("accept", 0.55) }));
  r = await routeWithJev(base);
  check("router: weak value confidence lowers overall confidence", r?.output.confidence === "low");

  setJevClientForTests(answers({ call: choice("explicit_request", 0.97), reply_0: noul(0.01), reply_1: noul(0.01) }));
  r = await routeWithJev({ ...base, message: "call me" });
  check("router: explicit call request maps", r?.output.call === "explicit_request" && r.output.confidence === "high");

  setJevClientForTests(answers({ wants_recommendation: noul(0.9), wants_invite: noul(0.8), asks_for_updates: noul(0.7) }));
  r = await routeWithJev(base);
  check("router: search, invite and updates flags map", !!r?.output.wantsRecommendation && !!r.output.wantsInvite && !!r.output.asksForUpdates);

  setJevClientForTests(fake({ call: choice("none") }));
  check("router: missing answers return null", (await routeWithJev(base)) === null);

  setJevClientForTests(answers({}));
  await routeWithJev({ ...base, recentConversation: "x".repeat(6000) });
  check("router: conversation is trimmed before sending", String(lastState.recent_conversation).length <= 1800);
  check("router: no items still works", !!(await routeWithJev({ ...base, openItems: [] })));

  setJevClientForTests(null);
  if (savedKey) process.env.TYPESAFE_API_KEY = savedKey;
  if (savedJev) process.env.jev_co = savedJev;
  console.log(failed ? `${failed} of ${total} jev checks FAILED` : `all ${total} jev checks passed`);
  process.exit(failed ? 1 : 0);
}
main();
