// What Co knows about a person, live (harness/personSnapshot.ts and
// harness/callGrounding.ts). 2026-09-15: a call opened as if Royce were still
// a pre-seed cleantech founder after he'd texted he runs a Series A company.
//
//   npx tsx evals/knowledge/run.ts
//
// Hard: the snapshot keeps a contradicted older fact, drops a newer one,
// stores something about Co, or invents a feeling; the call audit misses an
// invented fact or an unkeepable promise.
import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { loadCases, runEval, type EvalCase } from "../lib.js";
import { parseSnapshot, snapshotPrompt, renderSnapshot, type PersonSnapshot } from "../../src/harness/personSnapshot.js";
import { callAuditPrompt, type CallClaim } from "../../src/harness/callGrounding.js";
import { parseModelJson } from "../../src/services/modelJson.js";
import { MODELS } from "../../src/models.js";

type Case = EvalCase & Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));

const stale: PersonSnapshot = {
  work: "solo pre-seed cleantech founder building Co", place: "Fargo", wantsNow: ["meet cleantech investors", "get into ERA Winter 2027"],
  weighingOn: ["lack of information from Co"], valuesInPeople: [], worked: [], didntWork: [], asOf: "2026-09-08T10:00",
};
const cases: Case[] = [
  {
    id: "k01_series_a_replaces_preseed", kind: "snapshot",
    input: {
      firstName: "Royce", previous: stale, openAsks: ["Series A-focused investors and operators", "a designer for logo and branding"], outcomes: [],
      recentStatements: [
        { at: "2026-09-15T19:24", text: "We are a series A company, building AI infrastructure for B2B companies. We recently just landed a 35 million dollar deal on a small team of 8 people" },
        { at: "2026-09-15T19:28", text: "In the mean time, I want to look for some friends" },
        { at: "2026-09-15T19:32", text: "Cool, calm, collected. Urgency is important with knowing the stakes. Also someone who can see a life beyond just the computer" },
      ],
    },
    mustMatch: { work: "series a", valuesInPeople: "calm|collected|urgency|beyond" },
    mustNotMatch: "pre-seed|preseed|cleantech|fargo|era winter|\\bco\\b|solo",
  },
  {
    id: "k02_no_invented_feelings", kind: "snapshot",
    input: { firstName: "Sam", previous: null, openAsks: ["pickup basketball group"], outcomes: [], recentStatements: [{ at: "2026-09-15T12:00", text: "I'd love to find a pickup basketball group" }, { at: "2026-09-15T12:05", text: "sounds good" }] },
    mustMatch: { wantsNow: "basketball" },
    mustNotMatch: "lonely|isolated|stressed|anxious|overwhelmed",
    weighingOnEmpty: true,
  },
  {
    id: "k03_outcomes_carried", kind: "snapshot",
    input: { firstName: "Jo", previous: null, openAsks: [], outcomes: ['event "Climate Founders Mixer": helped (met two investors)', 'intro "an intro to Dana": declined'], recentStatements: [{ at: "2026-09-14T09:00", text: "the mixer was great, met two investors" }] },
    mustMatch: { worked: "mixer" },
  },
  {
    id: "c01_call_audit", kind: "audit",
    known: "Who they are right now:\nWork: Series A AI infrastructure company\nWants right now: a designer for logo and branding",
    transcript: "user: I need a logo designer by Friday\nassistant: Friday is tight but doable. I'll look for a couple of designers after we hang up and text you if I find a fit.\nuser: Cool. Is the Tech Week mixer still on?\nassistant: Yeah, it starts at 6pm at Heavybit and 40 people are going.\nassistant: I'll have three designer intros in your inbox by Thursday.",
    expectTypes: { promise_keepable: 1, invented_fact: 1, promise_unkeepable: 1 },
  },
];

await runEval<Case, any>({
  name: "knowledge (live)",
  dir: here,
  cases: [...loadCases<Case>(here), ...cases],
  concurrency: 4,
  run: async (c) => {
    if (c.kind === "snapshot") {
      const { text } = await generateText({ model: anthropic(MODELS.sonnet), providerOptions: { anthropic: { effort: "low" } }, prompt: snapshotPrompt(c.input) });
      return parseSnapshot(text);
    }
    const { text } = await generateText({ model: anthropic(MODELS.sonnet), providerOptions: { anthropic: { effort: "low" } }, prompt: callAuditPrompt(c.transcript, c.known) });
    return parseModelJson<{ claims: CallClaim[] }>(text).claims ?? [];
  },
  score: (c, r) => {
    const hard: string[] = [];
    if (c.kind === "snapshot") {
      if (!r) return { hard: ["no snapshot"], soft: [] };
      const all = renderSnapshot(r).toLowerCase();
      for (const [field, pattern] of Object.entries(c.mustMatch ?? {})) {
        const value = JSON.stringify((r as any)[field] ?? "").toLowerCase();
        if (!new RegExp(pattern as string, "i").test(value)) hard.push(`${field} missing /${pattern}/: ${value}`);
      }
      if (c.mustNotMatch && new RegExp(c.mustNotMatch, "i").test(all)) hard.push(`kept stale, Co-related, or invented content: ${all.replace(/\n/g, " | ")}`);
      if (c.weighingOnEmpty && r.weighingOn.length) hard.push(`invented something weighing on them: ${r.weighingOn.join("; ")}`);
      for (const [k, v] of Object.entries(r)) if (Array.isArray(v) && v.length > 4) hard.push(`${k} has ${v.length} items`);
    } else {
      const counts: Record<string, number> = {};
      for (const cl of r as CallClaim[]) counts[cl.type] = (counts[cl.type] ?? 0) + 1;
      for (const [t, n] of Object.entries(c.expectTypes)) if ((counts[t] ?? 0) < (n as number)) hard.push(`audit found ${counts[t] ?? 0} ${t}, expected ${n}: ${JSON.stringify(r)}`);
    }
    return { hard, soft: [] };
  },
});
