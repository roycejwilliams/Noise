// Their state outranks the agenda (Royce, 2026-10-06: told Co he was "tired and drained" and Co answered with two events and a
// recap of what it was carrying). The prompt says to close warm in two sentences; Haiku keeps going. So on a call the endpoint
// (services/callLlmProxy.ts) reads the member's last words for that signal and, when it is there:
//   - puts a short note at the END of the prompt (the part a model follows most closely) for this turn only, and
//   - caps what is said at two sentences, in code.
// The model still writes the words and still decides what is warm; code only sets the length and reminds it whose turn it is.
// A false match ("tired of waiting on the VC") costs one short, kind reply, and the note tells the model to ignore it when the
// words weren't about how they are.
const SIGNAL = /\b(?:i'?m|i am|we'?re|feeling|feel|kinda|kind of|so|pretty|really|just|bit|little)\s+(?:\w+\s+){0,2}?(?:tired|drained|exhausted|overwhelmed|burn(?:ed|t)\s?out|burned out|wiped(?: out)?|worn out|fried|stressed(?: out)?|spent|depleted)\b(?!\s+(?:of|with|by|about)\b)|\b(?:long|rough|hard|tough|brutal|exhausting) (?:day|week|month|night)\b|\b(?:tired and drained|drained and tired|burn(?:ed|t) out|mental health|need(?:ed)? (?:a )?(?:break|rest)|can'?t (?:keep up|do (?:any|much) more)|too much (?:going on|right now)|so much going on)\b/i;

export const memberStateSignal = (said: string): boolean => SIGNAL.test(said);

export const DRAINED_NOTE = `# This turn: they said they are drained
They just told you they are tired, drained or overwhelmed. That outranks everything on your list. Reply in two short sentences and stop: the first says you heard it, the second lets them go warmly. No pitch, no events, no recap of the call or of what you are carrying, no list, no question, no new idea. What you found keeps; if they asked for something, one clause is enough ("I'll have something easy for you.") and nothing more. If what they said was not about how they are right now, ignore this note.`;

export const DRAINED_MAX_SENTENCES = 2;
