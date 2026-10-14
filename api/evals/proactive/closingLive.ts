// Co writes the question after offers it sent first (harness/proactive.ts), 3 runs each.
import "../lib/requireMeter.js";
const { lineInVoice } = await import("../../src/services/voiceLine.js");
for (const names of [["Grok Bot x Notion for Product Builders night (SF)"], ["daytonaio AI Builders Demo Night", "Founder Dinner (Filipino Tech Startups)"]]) {
  for (let i = 0; i < 3; i++) {
    const r = await lineInVoice({ purpose: `End a run of ${names.length === 1 ? "one thing" : `${names.length} things`} you just texted them with one short, natural question asking whether ${names.length === 1 ? "it" : "any of them"} interests them. Only the question, nothing else.`, facts: [`Cue just sent them: ${names.join("; ")}.`], examples: [], fallback: "(stock)" });
    console.log(`${r.written ? "written" : "STOCK"}: ${r.text}`);
  }
}
