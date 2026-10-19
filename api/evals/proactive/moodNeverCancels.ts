// A mood can never cancel a helper (Royce, 2026-10-19: "Fix every place where a mood or feeling decides whether something happens.
// Rule: feelings change timing and tone, never cancel."). The shared pin over the mood registry (services/moodHold.ts):
//   1. every place ruled (MOOD_RULES) is "timing only, capped" and has its own registered layer 1 test that proves it waits;
//   2. a place is either ruled or documented as not yet changed (FEELING_PICKS_NOT_CHANGED), never both;
//   3. one cap, a constant;
//   4. a census of every mood read in src/: each one is the capped hold, wording, a declaration, a plain carry marked as one, or a place
//      still documented as not changed. Anything else (an if, a ternary, a multi-line condition, an early return after a mood check)
//      fails, whatever its shape, because the census flags the read itself, not a pattern around it.
// Fixing a place moves it from FEELING_PICKS_NOT_CHANGED into MOOD_RULES. A line that only carries or words a mood read says so with a
// trailing "// mood: <why>" note.
// Layer 1: reads the registry and the source. Zero tokens, no DB.
//   npx tsx evals/proactive/moodNeverCancels.ts
import fs from "node:fs";
import path from "node:path";
const MH = await import("../../src/services/moodHold.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 3000)}` : ""}`); } };
const root = new URL("../../", import.meta.url).pathname;
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const layer1 = JSON.parse(read("evals/layer1.json")).files as string[];
const rules = Object.entries(MH.MOOD_RULES) as [string, { where: string; ruling: string; test: string }][];
const open = MH.FEELING_PICKS_NOT_CHANGED;

// ---- 1. every ruled place waits, capped, with its own test
for (const [rule, r] of rules) {
  check(`${rule}: ruled timing only, capped`, /timing only, capped/.test(r.ruling) && !/pending/i.test(r.ruling), r);
  check(`${rule}: its test exists and runs in layer 1`, fs.existsSync(path.join(root, r.test)) && layer1.includes(r.test), r.test);
  check(`${rule}: its test names the rule`, read(r.test).includes(rule), r.test);
}

// ---- 2. ruled or documented, never both
for (const o of open) {
  check(`documented, not changed: ${o.where}`, /documented, not changed: needs Royce/.test(o.status), o);
  check(`not also ruled: ${o.where}`, !rules.some(([, r]) => r.where === o.where), o.where);
}

// ---- 3. one cap
check("one cap, a constant (no env)", typeof MH.MOOD_HOLD_CAP_HOURS === "number" && MH.MOOD_HOLD_CAP_HOURS > 0 && !/process\.env/.test(read("src/services/moodHold.ts")));

// ---- 4. the census
// Code only: string, template and regex literals and comments become spaces (newlines kept, so line numbers hold).
export function codeOnly(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  let prev = ""; // the last code character that wasn't a space, for telling a regex from a division
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === "/" && d === "/") { while (i < n && text[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && d === "*") { while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; } out += "  "; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; out += q; i++;
      let depth = 0;
      while (i < n) {
        const e = text[i];
        if (e === "\\") { out += "  "; i += 2; continue; }
        if (q === "`" && e === "$" && text[i + 1] === "{") { depth++; out += "  "; i += 2; continue; }
        if (q === "`" && depth > 0 && e === "}") { depth--; out += " "; i++; continue; }
        if (e === q && depth === 0) break;
        if (e === "\n" && q !== "`") break;
        out += e === "\n" ? "\n" : " "; i++;
      }
      if (text[i] === q) { out += q; i++; }
      prev = q; continue;
    }
    if (c === "/" && /[(,=:[!&|?{};]|^$/.test(prev)) {
      out += "/"; i++;
      let inClass = false;
      while (i < n && text[i] !== "\n") {
        const e = text[i];
        if (e === "\\") { out += "  "; i += 2; continue; }
        if (e === "[") inClass = true;
        else if (e === "]") inClass = false;
        else if (e === "/" && !inClass) break;
        out += " "; i++;
      }
      if (text[i] === "/") { out += "/"; i++; }
      prev = "/"; continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}
// The mood reads: the hard-day read, the frustration read, the heavy moment, and any variable named for struggling.
const MOOD = /\bneedsCare\b|\bwithCo\b|\bfrustrated\w*|\bheavyMoment\b|\bheavyNow\b|\bstruggling\w*/gi;
// Through the capped hold (services/moodHold.ts and the functions built on it).
const CAPPED = /\b(?:heldForMood|moodHold|heavyHold|frustrationHold|firstMoodWait|firstDraftMoodWait|moodWaitRead|draftWaitRead|moodFallbackDecision|noteMoodHold|followUpMoodWait)\b/;
// A declaration: a field or parameter type.
const DECLARED = /(?:\bneedsCare|\bwithCo|\bfrustrated\w*|\bheavyNow|\bstruggling\w*)\??\s*:\s*(?:boolean|\{|EmotionalContext|Pick<)/;
// Wording: a ternary that yields text, or a literal default.
const WORDING = /\?\s*(["'`])\s*\1\s*:/;
const LITERAL = /(?:\bneedsCare|\bfrustrated\w*|\bheavyNow)\??\s*:\s*(?:false|true)\b/;
export type Flag = { file: string; line: number; read: string; text: string };
export function census(file: string, raw: string, documented: (file: string, read: string) => boolean): Flag[] {
  const code = codeOnly(raw).split("\n");
  const lines = raw.split("\n");
  const flags: Flag[] = [];
  code.forEach((l, i) => {
    const reads = [...new Set((l.match(MOOD) ?? []).map((m) => m.toLowerCase()))];
    if (!reads.length) return;
    if (/\/\/\s*mood:\s*\S/.test(lines[i])) return;
    if (CAPPED.test(l) || DECLARED.test(l) || WORDING.test(l) || LITERAL.test(l)) return;
    for (const r of reads) if (!documented(file, r)) flags.push({ file, line: i + 1, read: r, text: lines[i].trim().slice(0, 160) });
  });
  return flags;
}
// A place still documented as not changed may keep its gate: its file and the read are both named in the entry.
const norm = (r: string) => (r.startsWith("frustrated") ? "frustrated" : r.startsWith("struggling") ? "struggling" : r);
const documented = (file: string, readName: string) => open.some((o) => o.where.includes(file.replace(/^src\//, "")) && `${o.where} ${o.what}`.toLowerCase().includes(norm(readName.toLowerCase())));
const files: string[] = [];
const walk = (d: string) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
walk("src");
const flags = files.filter((f) => !/services\/moodHold\.ts$|harness\/emotion\.ts$/.test(f)).flatMap((f) => census(f, read(f), documented));
check("census: every mood read in src/ is the capped hold, wording, a declaration, a marked carry, or a documented place", flags.length === 0, flags.map((f) => `${f.file}:${f.line} ${f.read}`));

// The scan's own fixtures (review of the mood stack): gates in shapes a line pattern would miss must still fail.
const noDocs = () => false;
const FIXTURES: [string, string][] = [
  ["a ternary veto on the hard-day read", `export function steerDecision(o: any) {\n  const veto = (o as any).needsCare ? { steer: false, why: "x" } : null; if (veto) return veto;\n  return { steer: true };\n}`],
  ["a gate on the frustration read", `export function offerGate(s: any) {\n  if ((s as any).withCo?.frustrated) return "frustrated";\n  return null;\n}`],
  ["a multi-line condition with an early return", `export function pick(e: any) {\n  if (\n    e &&\n    e.needsCare\n  )\n    return null;\n  return 1;\n}`],
  ["a named struggling flag, then an early return", `export function pick(e: any) {\n  const struggling = !!e.hard;\n  if (struggling) return null;\n  return 1;\n}`],
  ["the bare heavy moment passed into a decision", `export function door(o: any) {\n  return doorDecision({ heavy: heavyMoment(o.emotional) });\n}`],
];
for (const [label, srcText] of FIXTURES) check(`census fixture fails: ${label}`, census("src/services/fixture.ts", srcText, noDocs).length > 0, srcText);
check("census fixture passes: wording, a declaration, the capped hold, a marked carry", census("src/services/fixture.ts", `type S = { needsCare?: boolean };\nconst a = r?.needsCare ? "they've been having a hard time lately" : null;\nconst b = heldForMood(state) && x.needsCare;\nconst c = { needsCare: !!raw.emotional?.needsCare }; // mood: carries the read\nconst d = "never when struggling";`, noDocs).length === 0, census("src/services/fixture.ts", `type S = { needsCare?: boolean };\nconst a = r?.needsCare ? "they've been having a hard time lately" : null;\nconst b = heldForMood(state) && x.needsCare;\nconst c = { needsCare: !!raw.emotional?.needsCare }; // mood: carries the read\nconst d = "never when struggling";`, noDocs));

console.log(`\nmood never cancels: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
