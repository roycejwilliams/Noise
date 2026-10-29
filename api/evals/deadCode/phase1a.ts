// Dead code removed in efficiency phase 1a (audit, 2026-10-29): files never imported, exports used nowhere, and the voice flags
// switched off since 10-04. Layer 1: reads the source tree; no model, no database.
//   npx tsx evals/deadCode/phase1a.ts
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
};
const api = new URL("../..", import.meta.url).pathname;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "dist" || f === "_archive") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|mjs|js)$/.test(f) ? [p] : [];
  });
const srcFiles = walk(join(api, "src"));
const all = [...srcFiles, ...walk(join(api, "evals")), ...walk(join(api, "../co-test/src"))].map((p) => ({ p, t: readFileSync(p, "utf8") }));

// Files never imported by anything that runs.
for (const f of ["services/namedEventLookup.ts", "services/entities.ts", "services/voiceFlags.ts"]) {
  check(`${f} is gone`, !existsSync(join(api, "src", f)));
  const mod = f.replace(/^services\//, "").replace(/\.ts$/, "");
  const importers = all.filter(({ t }) => new RegExp(`from ["'][^"']*/${mod}\\.js["']|import\\(["'][^"']*/${mod}\\.js["']\\)`).test(t)).map(({ p }) => p.slice(api.length));
  check(`nothing imports ${mod}`, importers.length === 0, importers);
}
check("the voice flags' own evals went with them", !existsSync(join(api, "evals/voiceFlags")) && !readFileSync(join(api, "evals/layer1.json"), "utf8").includes("voiceFlags"));

// Exports used nowhere, not even in their own file.
const removed = [
  "EventDiscoverySurfacingPerson", "CompanionCheckinPerson", "memberFailures", "hasAnyOffer", "userLinesFrom", "learnTextingStyle", "ENTITIES",
  "calendarConsentUrlFor", "moodBase", "menuUnknownIds", "writeConfirmation", "OutageAlert", "BacklogEntry", "loopLine", "rankTopByRelevance",
  "CallToolName", "COMPANY_NAME", "CallLesson", "imageryAvailable", "osmPin", "Lifetime", "NUDGE_KIND", "InboundHold", "GRAMMAR_NAMES",
  "liveShareCount", "flagVoiceMoments", "recentVoiceFlags", "renderVoiceFlags",
];
for (const name of removed) {
  const hits = all.filter(({ t }) => new RegExp(`\\b${name}\\b`).test(t)).map(({ p }) => p.slice(api.length));
  // This file names them; nothing else may.
  check(`${name}: removed and referenced nowhere`, hits.every((h) => h.endsWith("evals/deadCode/phase1a.ts")), hits);
}

// The emotional context no longer reads the voice-flag table on every call; what it renders is unchanged for everyone (the flags
// only ever showed for test numbers, from a pass switched off on 10-04, inside 7 days).
const E = await import("../../src/harness/emotion.js");
check("getEmotionalContext no longer queries voice_flags", !/voice_flags|VoiceFlags/.test(E.getEmotionalContext.toString()));
const now = new Date("2026-10-29T18:00:00Z");
const ctx = { current: { source: "text", emotion: "anxious", intensity: "medium", valence: "negative", about: "the move", quote: null, at: new Date(now.getTime() - 3_600_000) } as any, lastCall: null, recurring: [], needsCare: false, withCo: { frustrated: false, about: null, count: 0 } };
// A context still carrying an old voice-flag read (the shape the removed code attached) renders exactly as one without it: the voice
// line is gone and nothing else changed. Compared render to render, so it holds whatever the other lines' wording is.
const plain = E.renderEmotionalContext(ctx as any, now);
const withOldFlags = E.renderEmotionalContext({ ...ctx, voice: { at: new Date(now.getTime() - 3_600_000), flags: [{ quote: "it's fine", cue: "sigh", feeling: "tired", reading: "x" }] } } as any, now);
check("the emotional-context render ignores any voice-flag read: same output with or without one", withOldFlags === plain, { plain, withOldFlags });
check("and never carries the voice-flag line", !/their voice said more than their words/.test(withOldFlags) && plain.length > 0, withOldFlags);

console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
