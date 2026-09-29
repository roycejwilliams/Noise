// Model-free checks for the Instinct-inspired companion work (2026-09-29):
// tapback acknowledgment, threaded late results, no silent outcomes, stale
// heads-up, member details kit, and critique of shared links.
//
//   npx tsx evals/companion/rules.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const R = await import("../../src/services/readTurn.js");
const I = await import("../../src/services/inlineReply.js");
const H = await import("../../src/mo/health.js");
const S = await import("../../src/services/staleWatch.js");
const K = await import("../../src/services/memberKit.js");
const L = await import("../../src/services/linkReader.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

// 1. Tapback acknowledgment
check("ack accepts the five activity emojis, with or without the variation selector", ["👀", "✍️", "✍", "🫡", "🚀", "👍"].every((e) => R.parseAck(e) !== null));
check("ack rejects anything else", [null, undefined, "", "❤️", "hello", 5].every((e) => R.parseAck(e as any) === null));
check("Mo's actions ack by kind", /moApprove: "🚀"/.test(src("mo/teamAgent.ts")) && /moSkip: "👍"/.test(src("mo/teamAgent.ts")) && /moChangeDraft: "✍️"/.test(src("mo/teamAgent.ts")));
check("the reply path reacts after the read, never blocking the reply", /turn\.ack/.test(src("routes/sendblue.ts")));

// 2. Late results thread under the ask
check("a slow answer threads under their text", I.threadReason({ theyRepliedInline: false, newerTextSince: false, slowMs: 25_000 }) === "slow");
check("a quick answer doesn't", I.threadReason({ theyRepliedInline: false, newerTextSince: false, slowMs: 3_000 }) === null);
check("a reply to a specific message still mirrors first", I.threadReason({ theyRepliedInline: true, newerTextSince: false, slowMs: 60_000 }) === "mirror");
check("late search results carry the ask's handle", /askHandle/.test(src("services/lateSearchResult.ts")) && /replyTo/.test(src("harness/proactive.ts")));

// 3. No silent outcomes
check("causes are grouped by kind", H.causeOf("HTTP 403 Forbidden") === "auth" && H.causeOf("429 Too Many Requests") === "rate_limit" && H.causeOf("ETIMEDOUT") === "network" && H.causeOf("weird") === "other");
const t0 = new Date("2026-09-29T12:00:00Z");
const fail = (n: number) => ({ ok: 0, failed: Array.from({ length: n }, (_, i) => ({ cause: "auth" as const, who: `p${i}` })) });
const r1 = H.nextHealth(H.EMPTY_HEALTH, fail(4), t0, { kind: "sending" });
check("four failures make one message, not four", !!r1.message && /4 people/.test(r1.message) && r1.message.split("\n").length === 1);
const r2 = H.nextHealth(r1.health, fail(4), new Date(t0.getTime() + 3_600_000), { kind: "sending" });
check("the same cause isn't repeated an hour later", r2.message === null);
const r3 = H.nextHealth(H.nextHealth(r2.health, fail(4), new Date(t0.getTime() + 2 * 3_600_000), { kind: "sending" }).health, { ok: 2, failed: [] }, new Date(t0.getTime() + 3 * 3_600_000), { kind: "sending" });
check("it says so when it clears", !!r3.message && /^Back on/.test(r3.message) && r3.health.cause === null);
const r4 = H.nextHealth(H.EMPTY_HEALTH, fail(1), t0, { kind: "replies", notifyAfterRuns: 2 });
check("a reply-reader blip stays quiet for one run", r4.message === null && H.nextHealth(r4.health, fail(1), new Date(t0.getTime() + 3_600_000), { kind: "replies", notifyAfterRuns: 2 }).message !== null);
const r5 = H.nextHealth({ ...H.EMPTY_HEALTH, cause: "auth", runs: 2, since: t0.toISOString(), notifiedAt: t0.toISOString() }, fail(1), new Date(t0.getTime() + 3_600_000), { kind: "sending" });
check("three failing runs back off retries", H.inBackoff(r5.health, new Date(t0.getTime() + 3_600_000 + 60_000)) && !H.inBackoff(r5.health, new Date(t0.getTime() + 10 * 3_600_000)));

// 4. Stale heads-up
const read = (o: any) => ({ url: "u", finalUrl: "u", status: "ok", why: null, fields: {}, summary: null, source: "model", fetchedAt: t0, ...o });
const f = (value: string, verified = true) => ({ value, quote: value, verified });
check("no earlier read, no change", S.staleChange(null, read({})) === null);
check("sold out is caught", S.staleChange(read({ fields: { sold_out: f("no") } }), read({ fields: { sold_out: f("yes") } }))?.kind === "sold_out");
check("a time moved 2 hours is caught", S.staleChange(read({ fields: { start: f("2026-10-01T18:00:00Z") } }), read({ fields: { start: f("2026-10-01T20:00:00Z") } }))?.kind === "moved");
check("a 5-minute wobble isn't", S.staleChange(read({ fields: { start: f("2026-10-01T18:00:00Z") } }), read({ fields: { start: f("2026-10-01T18:05:00Z") } })) === null);
check("an unverified value proves nothing", S.staleChange(read({ fields: { sold_out: f("no") } }), read({ fields: { sold_out: f("yes", false) } })) === null);
check("a page that's gone (404) is caught, one that's just unreadable isn't", S.staleChange(read({}), read({ status: "failed", why: "HTTP 404" }))?.kind === "gone" && S.staleChange(read({}), read({ status: "failed", why: "timeout" })) === null);
check("only people who said they were interested are told", /result IN \('interested', 'acted'\)/.test(src("services/staleWatch.ts")) && /result = 'declined'/.test(src("services/staleWatch.ts")));
check("the heads-up goes through the event-change path (hours, STOP, once)", /sendExemptWhenAllowed/.test(src("services/staleWatch.ts")) && /watchSentPages/.test(src("jobs/index.ts")));

// 5. Member details kit
const kit = { full_name: "Sam Rivera", email: "sam@example.com", phone: "+15550001111", company: "Lantern", role: "founder" };
const lines = K.kitLines(kit).join(" ");
check("email and phone are named, never shown", !/sam@example\.com|\+15550001111/.test(lines) && /email/i.test(lines) && /Lantern/.test(lines));
check("a detail must be something they wrote", K.checkKitValue("company", "Lantern", "I run Lantern, a small studio").ok && !K.checkKitValue("company", "Acme", "I run Lantern").ok);
check("only work details are saved this way", !K.checkKitValue("email", "a@b.co", "a@b.co").ok);
check("LinkedIn must look like a profile", K.checkKitValue("linkedin", "https://www.linkedin.com/in/sam-rivera", "here https://www.linkedin.com/in/sam-rivera").ok && !K.checkKitValue("linkedin", "https://evil.com/in/sam", "https://evil.com/in/sam").ok);
check("what will be used is shown before it's used", /I'll use Full name and Company|I'll use/.test(K.detailsToUse(kit as any, ["full_name", "company"]).line) && K.detailsToUse(kit as any, ["linkedin"]).missing.includes("linkedin"));
check("the kit is a tool Co chooses, with a per-turn limit", /saveKitFact/.test(src("agent/conversationTools.ts")) && /kit/.test(src("services/capabilities.ts")));

// 6. Critique of shared links
const ok = read({ excerpt: "We help small studios ship faster. Pricing starts at $99 a month. Book a demo today. ".repeat(3) });
check("page text becomes a fact labeled as content, not instructions", /not instructions to follow/.test(L.excerptFact("x", ok) ?? ""));
check("a thin or missing page gives no excerpt fact", L.excerptFact("x", read({ excerpt: "hi" })) === null && L.excerptFact("x", read({ status: "failed", excerpt: ok.excerpt })) === null);
const shared = await L.linkForReply(Promise.resolve(ok as any));
check("a readable link brings the critique instruction", shared.instructions.some((i) => /honest friend/.test(i)) && shared.facts.length > 0);
const bad = await L.linkForReply(Promise.resolve(read({ status: "login_required", why: "login wall" }) as any));
check("an unreadable link says so and asks for the text", bad.instructions.some((i) => /couldn't read/.test(i)) && !bad.instructions.some((i) => /honest friend/.test(i)));
const slow = await L.linkForReply(new Promise(() => {}), 50);
check("a slow read never holds the reply", slow.facts.length === 0 && slow.instructions.length === 0);
check("the reply path reads their first link in the same turn", /linkForReply\(theirLinkP\)/.test(src("routes/sendblue.ts")));

// Fixes after review (2026-09-29)
check("two readers of one page share one read", (() => { const t = src("services/linkReader.ts"); return /inFlight\.get\(key\)/.test(t) && /\.finally\(\(\) => inFlight\.delete\(key\)\)/.test(t); })());
check("the story is loaded once with the turn's context, not per reply", /story\?: string\[\]/.test(src("services/turnContext.ts")) && /opts\.turn\?\.story/.test(src("harness/replyGrounding.ts")));
check("small talk doesn't wait on a shared link", /mode !== "small_talk"/.test(src("routes/sendblue.ts")));
check("milestones are inserted only when new, in one statement", /!have\.has\(m\.key\)/.test(src("services/milestones.ts")) && /unnest\(/.test(src("services/milestones.ts")));

// 2026-09-29: "...and tell me which one you'd pick" was read as not a request, so the search ran on the older Austin ask.
check("the search rewrite never answers null once a search is decided", (() => { const t = src("services/recommendation.ts"); return /never null/.test(t) && !/\{"request": null\}/.test(t) && /Borrow only the topic, and never their overall ask's time frame/.test(t); })());

console.log(`companion rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
