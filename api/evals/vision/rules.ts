// The vision check (Royce, 2026-09-22): Co is a genuine, ongoing life
// companion. Event curation is the near-term wedge, not the product. Fails
// when code drifts from that:
//   1. a proactive message type with no purpose (companion / offer / ops),
//      so nothing new can slip in unlabelled and skew the mix unseen
//   2. any prompt text that describes Co as an event finder, a matchmaker
//      or a networking tool ("not a matchmaker" is fine)
//   3. a prompt that puts an offer ahead of responding to what the person
//      said, or a reply prompt that loses its respond-first rule
// Model-free, no API calls, no database: npx tsx evals/vision/rules.ts
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { PROACTIVE_PURPOSE } from "../../src/harness/proactivePurpose.js";

const cases: [boolean, string][] = [];
const c = (ok: boolean, label: string) => cases.push([ok, label]);
const root = new URL("../..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------------------
// 1. Every proactive type has a purpose.
{
  const src = read("src/harness/proactive.ts");
  const union = (name: string) => {
    const m = src.match(new RegExp(`export type ${name} =([\\s\\S]*?);`));
    return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
  };
  const types = [...union("ProactiveType"), ...union("ExemptType"), "in_room"];
  c(types.length >= 17, `found the proactive and exempt type lists (${types.length} types)`);
  const purposes = PROACTIVE_PURPOSE as Record<string, string>;
  for (const t of types) c(t in purposes, `proactive type "${t}" has a purpose (companion, offer or ops) in harness/proactivePurpose.ts`);
  const companion = Object.values(purposes).filter((p) => p === "companion").length;
  c(companion >= 4, `there are real companion message types (${companion}), not just offers`);
}

// ---------------------------------------------------------------------------
// 2. Nothing describes Co as an event finder, a matchmaker, or a networking tool.
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const p = join(dir, name);
    const s = statSync(join(root, p));
    if (s.isDirectory()) files(p, out);
    else if (/\.(ts|md)$/.test(name)) out.push(p);
  }
  return out;
}
// String literals only (what a model or a person actually reads), never code comments.
function literals(text: string, isMarkdown: boolean): string[] {
  if (isMarkdown) return [text];
  const out: string[] = [];
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  for (const m of noComments.matchAll(/`((?:\\`|[^`])*)`|"((?:\\"|[^"\n])*)"|'((?:\\'|[^'\n])*)'/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out.filter((s) => s.length > 12);
}
const ROLE = "(?:an?\\s+|the\\s+|your\\s+)?(?:event[- ]finder|event[- ]finding (?:tool|app|service)|events? app|matchmak(?:er|ing (?:tool|app|service|platform))|networking (?:tool|app|platform|service)|recommendation (?:engine|bot))";
// "You are Co, an event finder" and "I'm Co, your matchmaker" name Co before the role.
const SELF = new RegExp(`\\b(?:you are|you're|i am|i'm|co is|cue is|co's just|cue's just|as)\\s+(?:(?:co|cue),?\\s+)?${ROLE}`, "gi");
const NEGATED = /\b(not|never|isn't|aren't|no longer|instead of|rather than)\b[^.]{0,40}$/i;
function selfDescriptions(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(SELF)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 50), m.index ?? 0);
    if (!NEGATED.test(before)) hits.push(m[0]);
  }
  return hits;
}
{
  // The detector itself behaves (so a pass below means something).
  c(selfDescriptions("You are Cue, an event finder for founders.").length === 1, "detector: 'an event finder' is caught");
  c(selfDescriptions("I'm a matchmaker who knows everyone").length === 1, "detector: 'a matchmaker' is caught");
  c(selfDescriptions("Cue is a networking tool").length === 1, "detector: 'a networking tool' is caught");
  c(selfDescriptions("I'm Cue, your matchmaker.").length === 1, "detector: 'I'm Cue, your matchmaker' is caught");
  c(selfDescriptions("Cue is not a matchmaker or an event finder; it's a companion.").length === 0, "detector: a negation is allowed");
  c(selfDescriptions("Never describe yourself as an event finder.").length === 0, "detector: an instruction not to say it is allowed");

  const scanned: string[] = [];
  const offenders: string[] = [];
  for (const f of [...files("src"), ...files("prompts")]) {
    if (/\.d\.ts$/.test(f)) continue;
    const text = read(f);
    for (const lit of literals(text, f.endsWith(".md"))) {
      for (const hit of selfDescriptions(lit)) offenders.push(`${relative(".", f)}: "${hit}"`);
    }
    scanned.push(f);
  }
  c(scanned.length > 50, `scanned the prompts and source (${scanned.length} files)`);
  c(offenders.length === 0, `no prompt describes Cue as an event finder, matchmaker or networking tool${offenders.length ? `: ${offenders.slice(0, 5).join("; ")}` : ""}`);
}

// ---------------------------------------------------------------------------
// 3. Respond to the person first; never lead with an offer.
{
  const reply = read("src/agent/conversationReply.ts");
  c(/Always respond genuinely to what they said first/.test(reply), "the reply prompt keeps its respond-first rule");
  c(/never let a gesture replace actually responding/.test(reply), "the reply prompt says a secondary gesture never replaces responding");

  const LEAD = /\b(?:lead with|start with|open with|begin with|put)\s+(?:the\s+|an?\s+)?(?:event|offer|recommendation|opportunit\w*|pitch)\b(?:\s+(?:first|before))?/gi;
  const leads = (lit: string) =>
    [...lit.matchAll(LEAD)].filter((m) => !/\b(don't|do not|never|not)\s*$/i.test(lit.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0))).map((m) => m[0]);
  c(leads("Lead with the event, then ask how they are.").length === 1, "detector: 'lead with the event' is caught");
  c(leads("Put the offer first.").length === 1, "detector: 'put the offer first' is caught");
  c(leads("Don't lead with the event; answer them first.").length === 0, "detector: an instruction not to lead with it is allowed");
  const offenders: string[] = [];
  for (const f of files("src")) {
    for (const lit of literals(read(f), false)) for (const hit of leads(lit)) offenders.push(`${relative(".", f)}: "${hit}"`);
  }
  c(offenders.length === 0, `no prompt tells Cue to lead with an offer${offenders.length ? `: ${offenders.slice(0, 5).join("; ")}` : ""}`);
}

const failed = cases.filter(([ok]) => !ok);
console.log(`vision rules: ${cases.length - failed.length}/${cases.length} passed`);
for (const [, label] of failed) console.log(`FAIL ${label}`);
if (failed.length) process.exitCode = 1;
