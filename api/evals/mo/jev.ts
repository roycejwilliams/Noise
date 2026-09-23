// Model-free checks for Mo's Jev layer (src/mo/jev.ts), with a stand-in Jev
// client: the thresholds, that Jev only ever drops a clear no, that any
// failure falls back to Claude, and that only strangers' text is sent.
//
//   npx tsx evals/mo/jev.ts
import "dotenv/config";
import { readFileSync } from "fs";
import { replyVerdict, screenPosts, screenVerdict, setJevClientForTests, readReplyWithJev, moJevEnabled, type JevClientLike } from "../../src/mo/jev.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- thresholds
check("a clear 'not doing anything themselves' is dropped", screenVerdict({ doing: 0.05, promo: 0.1, org: 0.1 }) === "drop");
check("clear promotion is dropped", screenVerdict({ doing: 0.6, promo: 0.95, org: 0.1 }) === "drop");
check("a promotion read can't drop someone clearly doing it themselves (the cofounder-search miss)", screenVerdict({ doing: 0.98, promo: 0.91, org: 0.09 }) === "keep");
check("a clear company account is dropped", screenVerdict({ doing: 0.6, promo: 0.2, org: 0.95 }) === "drop");
check("an unsure post is kept for Claude", screenVerdict({ doing: 0.4, promo: 0.5, org: 0.4 }) === "keep");
check("a clear builder is kept", screenVerdict({ doing: 0.95, promo: 0.05, org: 0.05 }) === "keep");
check("a clear yes reply", replyVerdict({ wants: 0.95, declines: 0.02, asks: 0.1 }) === "yes");
check("a clear no reply", replyVerdict({ wants: 0.05, declines: 0.9, asks: 0.05 }) === "no");
check("a question reply", replyVerdict({ wants: 0.4, declines: 0.1, asks: 0.9 }) === "question");
check("yes plus a question is a question, not a yes", replyVerdict({ wants: 0.85, declines: 0.05, asks: 0.85 }) === "question");
check("a yes that might also be a no goes to Claude", replyVerdict({ wants: 0.85, declines: 0.4, asks: 0.1 }) === null);
check("an unsure reply goes to Claude", replyVerdict({ wants: 0.55, declines: 0.3, asks: 0.3 }) === null);

// ---------------------------------------------------------------- with a stand-in Jev
const post = (id: string, text: string, name = "Noor Haddad", description: string | null = "designer") => ({ id, text, author: { username: `u${id}`, name, description } });
const posts = [post("1", "hosting a design-engineer dinner in the Mission"), post("2", "10 growth hacks thread, like and repost"), post("3", "hmm, maybe")];
const sent: unknown[] = [];
const fake = (answers: Record<string, Record<string, number>>, fail = false): JevClientLike => ({
  async systemOne(req) {
    sent.push(req.state);
    if (fail) throw new Error("boom");
    const t = (req.state as any).post?.text ?? (req.state as any).reply;
    const a = answers[t] ?? {};
    return { answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "noul", noul: a[k] ?? 0.5 }])) };
  },
});
{
  setJevClientForTests(
    fake({
      "hosting a design-engineer dinner in the Mission": { doing: 0.97, promo: 0.03, org: 0.02 },
      "10 growth hacks thread, like and repost": { doing: 0.2, promo: 0.97, org: 0.3 },
      "hmm, maybe": { doing: 0.4, promo: 0.4, org: 0.4 },
    }),
  );
  const r = await screenPosts(posts);
  check("Jev keeps the builder and the unsure post, drops the promo", r.keep.map((p) => p.id).join(",") === "1,3" && r.dropped.map((d) => d.post.id).join(",") === "2");
  check("only the post text, author name and bio are sent (no member data)", sent.every((s: any) => Object.keys(s).sort().join(",") === "author,post" && Object.keys(s.author).sort().join(",") === "bio,name"));
  setJevClientForTests(fake({}, true));
  const f = await screenPosts(posts);
  check("if Jev fails, every post goes to Claude", f.keep.length === 3 && f.dropped.length === 0 && !f.jevUsed);
  setJevClientForTests(fake({ "sure, send it over": { wants: 0.96, declines: 0.02, asks: 0.05 } }));
  check("a reply read by Jev", (await readReplyWithJev("sure, send it over")).verdict === "yes");
  setJevClientForTests(fake({}, true));
  check("a reply Jev can't read goes to Claude", (await readReplyWithJev("sure")).verdict === null);
  setJevClientForTests(null);
}
check("without a key, Jev is off", !moJevEnabled({} as any) && moJevEnabled({ TYPESAFE_API_KEY: "x" } as any) && !moJevEnabled({ TYPESAFE_API_KEY: "x", MO_JEV: "off" } as any));

// ---------------------------------------------------------------- wiring
{
  const o = src("mo/outreach.ts");
  check("a clear stop in code still wins before Jev reads a reply", /if \(clearStop\(text\)\) return "no";\s*if \(clearYes\(text\)\) return "yes";\s*\/\/ Jev next/.test(o));
  check("Claude reads any reply Jev isn't sure of", /if \(jev\.verdict\) return jev\.verdict;\s*const \{ text: out \}/.test(o));
  const f = src("mo/find.ts");
  check("Jev screens before Claude judges, and Claude still judges what's kept", /const screened = await screenPosts\(inSf\);[\s\S]{0,300}const posts = screened\.keep\.slice\(0, 25\);[\s\S]{0,300}await judge\(posts/.test(f));
  const j = src("mo/jev.ts");
  check("the SDK never logs request bodies", /logLevel: "error"/.test(j));
  check("errors log class and status only", /request failed \(non-fatal\): \$\{err\?\.constructor\?\.name/.test(j));
  check("every screen is logged with its probabilities, to tune thresholds from approvals", /decision: "mo\.jev\.screen"/.test(j) && /dropped: dropped\.map\(\(d\) => \(\{ handle: d\.post\.author\.username, post: d\.post\.text\.slice\(0, 200\), p: d\.p \}\)\)/.test(j));
}

console.log(`mo jev rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
