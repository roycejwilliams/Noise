# Voice-emotion pilot (Hume sunset, 2026-10)

Question: does tone add signal beyond the words? The text read (harness/emotion.ts, readTextEmotion) is the baseline;
Gemini's audio read and Hume's saved per-line scores are compared against it.

Pipeline (run from this folder, in order; all data stays local, never committed):
1. build.py   cut each scored member line out of the saved Hume recordings (afconvert + wave, no ffmpeg) -> clips/, lines.json
2. score.py   Gemini (gemini-3.8-flash, key CO_GEMINI_KEY in api/.env) scores each clip on Hume's 48 labels, audio only -> out/
3. analyze.py correlations by emotion family, top-moment overlap, biggest disagreements

Inputs: ~/copatible-backups/hume-2026-10-03 (chats.json, events/, audio/) and set27.json (call list with whose voice).
Only calls Royce approved went to Google (his own + a test account; plan A, 2026-10-03). Clips, scores and lists
are member voice/data: keep them out of git.

First pass (216 lines, 16 calls): Gemini vs Hume correlation 0.17 (anger), -0.14 (anxiety), 0.23 (warmth), top-family
match 17% vs ~12% chance. Hume looked noisy on short polite lines; Gemini looked biased by meaning. Listening test pending.

## Synthetic test (2026-10-03): does tone add signal beyond the words?

synthetic/: 4 stock ElevenLabs voices act 17 scripted lines each (68 clips) in a known feeling (ground truth = the acted
tone). No member or team voice. Three readers per clip: Co's text read (exact readTextEmotion prompt, Haiku), Gemini on
the words only, Gemini on the audio. Run: `python3 gen.py && python3 read.py && python3 analyze.py` (ROUND=2 for the
stronger acting: v3 tags plus audible cues, sighs/laughs/shouting/stammers). Audio and reads stay in data*/ (gitignored).

Round 1 (emotion tags only): the voices barely acted the feeling on calm words (loudness within ~1 dB, same pace), so
Gemini's "calm" was mostly right and the test didn't bite.

Round 2 (audible cues), accuracy against the acted feeling:
| condition | n | Co text read | Gemini words | Gemini audio |
|---|---|---|---|---|
| calm words, feeling only in voice (short) | 16 | 12% | 0% | 31% |
| calm words, feeling only in voice (long) | 16 | 19% | 0% | 31% |
| calm words, calm voice (no false alarm) | 8 | 62% | 100% | 88% |
| cheerful words, sad/sarcastic voice | 8 | 50% | 50% | 88% |
| words and voice agree (emotional) | 16 | 100% | 100% | 100% |

Reading: audio catches sighs (sad 5/8) and laughs (happy 4/8) that the words hide, and sarcasm (88% vs 50%); it missed
acted anger on calm words entirely (the voices didn't shout on neutral lines) and nearly all acted anxiety. Co's text
read gives the same answer for the same words whatever the voice (its "hits" above are coincidence) and sometimes reads
feeling into plain logistics ("promotion still deciding" -> anxious). Synthetic acting is cleaner than real calls, and
the real-call pass showed short per-line reads are noise, so this is an upper bound.

## Voice flags (built 2026-10-03): services/voiceFlags.ts

Removed 2026-10-29 (switched off since 10-04; the code and its evals are in git history before the efficiency phase 1a PR). The
voice_flag_runs and voice_flags tables are left in place.

What came of it: after a call, one Gemini pass listens for moments where the caller's voice says more than their words
(sigh, forced cheer, sarcasm, laugh). Kept flags reach Co beside the text read in its emotional-context block; they never
enter emotion_signals. VOICE_FLAGS=test runs it for test numbers only (no "on" yet). Every pass is logged in
voice_flag_runs and every flag, kept or dropped with why, in voice_flags. Checks: evals/voiceFlags/rules.ts (in evals:code).

Probe (evals/voiceFlags/probe.ts, real Gemini on 8 pretend calls stitched from the round-2 acted clips by synthetic/calls.py,
5 caller moments each): 15/24 voice-only moments caught, sarcasm 4/4, forced cheer 4/4, sighs 4-5/8, laughs 2-3/8;
0/16 false flags where the words already said it or the voice was calm, 0 flags on anything else (two runs, same).
The first prompt ("most calls have none or one") caught 12/24 with the same 0 false flags.
