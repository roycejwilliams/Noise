// Their state outranks the agenda (Royce, 2026-10-06: told Co he was "tired and drained" and Co answered with two events and a
// recap of what it was carrying). On a call the endpoint (services/callLlmProxy.ts) reads the member's last words for that signal
// and, when it is there, puts a short note at the END of the prompt (the part a model follows most closely) for this turn only.
// 2026-10-08: the note used to say "two sentences, then let them go" and code capped the reply at two sentences. Royce said he'd
// been "kinda stressed" and was figuring out what's next, and Co said get some rest and hung up on him. Co is a companion: when
// someone opens up, that is the call. The note now keeps the agenda out and Co with them; the model decides the words and length.
const SIGNAL = /\b(?:i'?m|i am|we'?re|feeling|feel|kinda|kind of|so|pretty|really|just|bit|little)\s+(?:\w+\s+){0,2}?(?:tired|drained|exhausted|overwhelmed|burn(?:ed|t)\s?out|burned out|wiped(?: out)?|worn out|fried|stressed(?: out)?|spent|depleted)\b(?!\s+(?:of|with|by|about)\b)|\b(?:long|rough|hard|tough|brutal|exhausting) (?:day|week|month|night)\b|\b(?:tired and drained|drained and tired|burn(?:ed|t) out|mental health|need(?:ed)? (?:a )?(?:break|rest)|can'?t (?:keep up|do (?:any|much) more)|too much (?:going on|right now)|so much going on)\b/i;

export const memberStateSignal = (said: string): boolean => SIGNAL.test(said);

export const DRAINED_NOTE = `# This turn: they told you how they are
They just told you they are tired, stressed, drained or having a hard time. That outranks everything on your list: no pitch, no events, no recap, nothing you are carrying for them. Stay with them. If they want to talk about it, that is what this call is for now: listen, follow what they actually said, and help them think it through. Never end the call or send them off to rest because of it; the call ends only when they say they want to go. If what they said was not about how they are right now, ignore this note.`;

