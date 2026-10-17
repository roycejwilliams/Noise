// Exa for test members only until Exa answers on data retention (Royce, 2026-10-17: "Test members only until retention is
// answered"). A real member's wants never reach Exa; they keep Anthropic's web search as before. Zero tokens, no database.
//   npx tsx evals/exa/testMembersOnly.ts
import { readFileSync } from "fs";
const X = await import("../../src/services/exaSearch.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};
const KEY = { EXA_API_KEY: "exa_test_key" } as NodeJS.ProcessEnv;
const testMember = async (id: string) => id === "test-member";
check("a test member's search uses Exa when the key is set", (await X.exaFor("test-member", KEY, testMember)) === true);
check("a real member's never does, key or not", (await X.exaFor("royce", KEY, testMember)) === false);
check("no member behind the search: no Exa", (await X.exaFor(null, KEY, testMember)) === false && (await X.exaFor(undefined, KEY, testMember)) === false);
check("no key: no Exa for anyone", (await X.exaFor("test-member", {} as NodeJS.ProcessEnv, testMember)) === false);
check("a member lookup that fails: no Exa (fails closed)", (await X.exaFor("test-member", KEY, async () => { throw new Error("db down"); })) === false);
{
  const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
  const callers = ["services/taskWeb.ts", "services/namedEventLookup.ts", "services/webOpportunitySearch.ts"];
  check("every caller asks exaFor(member), never exaConfigured alone", callers.every((f) => /await exaFor\(/.test(src(f)) && !/exaConfigured\(\)/.test(src(f))), callers.filter((f) => /exaConfigured\(\)/.test(src(f))));
  check("... with the member passed through (the web opportunity search and its caller)", /if \(await exaFor\(opts\.userId\)\)/.test(src("services/webOpportunitySearch.ts")) && /\{ source: "sweep", userId \}\)/.test(src("harness/memberThreads.ts")));
  check("a test member is the 555-01xx test range (services/testNumbers.ts)", /isTestNumber\(rows\[0\]\?\.phone_number\)/.test(src("services/exaSearch.ts")));
}
console.log(`exa test members only: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
