// Expressive delivery on calls (Royce, 2026-10-04): Co's call model may put
// one ElevenLabs bracket cue in front of a phrase ("[softly] That sounds like a
// lot."), so how Co sounds can fit the moment. This is about Co's voice, not
// reading the member's feeling.
//
// Checked first (2026-10-04, six probe calls on the dev agent, eleven_v4_turbo
// inside Agents): no cue was spoken aloud as a word (cues the model doesn't act
// on are dropped silently), [laughs] was clearly rendered, and the first audio
// came 7-49 ms later than a plain line. The cue does appear in ElevenLabs'
// transcript of what Co said, so it's stripped from every transcript Co stores
// and from every text it sends (services/sendblue.ts cleanCoMessage).
//
// Going live: the guide reaches an agent only through buildAgentConfig, so run
// src/scripts/pushElevenLabsAgent.ts after a change, once per environment
// (dev, then prod's own agent).
//
// Co's speech goes from ElevenLabs' model straight to its voice, so code can't
// edit a reply mid-call: the allowed set and one-per-reply live in the call
// prompt (CUE_GUIDE), and every call is audited after (cueAudit) so a cue
// outside the set, or two in one reply, shows up in the review.

// Chosen for Co's voice (composed, warm, never theatrical or flirtatious):
// warmth and quiet care, a considered pause, and a light laugh when something
// is genuinely funny. No [sighs] (it reads as weary or as acting out their
// feeling), no [excited] or [whispers] (theatrical).
export const VOICE_CUES = ["warmly", "softly", "thoughtful", "laughs"] as const;
export const MAX_CUES_PER_REPLY = 1;

// A bracketed cue standing as its own word: one to three lowercase words, after
// a space or the start and before a space, punctuation or the end, so a link
// ("?filter[city]=sf"), a markdown link ("[here](...)"), quoted text or a
// capitalized event tag ("[SOLD OUT]") never matches.
const CUE = /(^|[\s(])\[([a-z]+(?:[ -][a-z]+){0,2})\](?=$|[\s,.!?;:)])/g;

// Cues a text could carry by mistake: the allowed ones, ElevenLabs' other
// common tags, and the strays a model reaches for. A text only loses these
// (review of #62: stripping any lowercase bracket rewrote "Dinner [members
// only] Friday" and "Hi [name]"); a transcript of Co's call lines loses any cue.
export const KNOWN_CUES = new Set<string>([...VOICE_CUES, "sighs", "sigh", "laugh", "laughing", "chuckles", "chuckle", "whispers", "whisper", "excited", "slow", "pause", "softer", "gently", "warm", "soft", "calmly", "smiles", "smiling", "thoughtfully", "warmer"]);

// Pure: the cues in a line, in order.
export function cuesIn(text: string): string[] {
  return [...String(text ?? "").matchAll(CUE)].map((m) => m[2]);
}

// Pure: the line without its cues (any cue, or only known ones for a text),
// spacing tidied only where one was removed.
export function stripCues(text: string, which: "any" | "known" = "any"): string {
  const src = String(text ?? "");
  let removed = false;
  const out = src.replace(CUE, (whole, before: string, cue: string) => {
    if (which === "known" && !KNOWN_CUES.has(cue)) return whole;
    removed = true;
    return before;
  });
  if (!removed) return src;
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.!?])/g, "$1")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
}

export type CueAudit = { replies: number; cued: number; cues: Record<string, number>; outside: string[]; overOne: number };

// Pure: how Co used cues across its lines on a call, and anything outside the rules.
export function cueAudit(coLines: string[]): CueAudit {
  const out: CueAudit = { replies: 0, cued: 0, cues: {}, outside: [], overOne: 0 };
  for (const line of coLines) {
    if (!String(line ?? "").trim()) continue;
    out.replies++;
    const cs = cuesIn(line);
    if (cs.length) out.cued++;
    if (cs.length > MAX_CUES_PER_REPLY) out.overOne++;
    for (const c of cs) {
      out.cues[c] = (out.cues[c] ?? 0) + 1;
      if (!(VOICE_CUES as readonly string[]).includes(c)) out.outside.push(c);
    }
  }
  return out;
}

// The call prompt's section on cues (voice only; texts never get it).
export const CUE_GUIDE = `How you sound: on a call you may put one cue in square brackets right before a phrase, when it truly fits the moment. It shapes the next few words of your voice; it is never said aloud. The only cues you may use: ${VOICE_CUES.map((c) => `[${c}]`).join(", ")}.
- Most replies have no cue. Never more than one in a reply.
- [softly] for something heavy they've shared; [warmly] when you're glad for them or welcoming them; [thoughtful] before a considered question or reflection; [laughs] only when something is genuinely funny and they're laughing too, never at them and never to soften hard news.
- Stay composed and warm: never theatrical, never flirtatious.
- Never act out or mirror their feeling back at them (no sighing because they sighed), and never name it ("you sound stressed").`;
