// Fails (exit 1) if any prompt describes Co its own way instead of starting
// from services/coVoice.ts's CO_VOICE. Run: npm run check-co-voice
//
// Only scans template literals that look like model prompts (contain
// "You are" / "You're texting" / "Co" instructions), and skips comments,
// coVoice.ts itself, and the archived circles code.
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dirname, "..");
const SKIP = [/^_archive\//, /^services\/coVoice\.ts$/, /^scripts\/checkCoVoice\.ts$/];

const RULES: { pattern: RegExp; why: string }[] = [
  { pattern: /You are Co\b(?!\.\s*Co gets to know)/, why: 'own "You are Co" intro; start from ${CO_VOICE}' },
  { pattern: /\bconcierge\b/i, why: 'calls Co a "concierge"' },
  { pattern: /\bCo(Patible)?'s AI\b|\bAI behind CoPatible\b/i, why: "describes Co as CoPatible's AI" },
  { pattern: /\bShe's (learning|listening)\b/, why: 'refers to Co as "she"' },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const problems: string[] = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (SKIP.some((r) => r.test(rel))) continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const { pattern, why } of RULES) {
        if (pattern.test(line)) problems.push(`src/${rel}:${i + 1}  ${why}\n    ${line.trim().slice(0, 140)}`);
      }
    });
}

if (problems.length) {
  console.error(`Co voice drift (${problems.length}):\n\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("Co voice check passed.");
