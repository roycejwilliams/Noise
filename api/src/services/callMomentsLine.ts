// The call-context line that carries the last call's moments: one header, used by the renderer (harness/emotion.ts
// renderEmotionalContext) and by the strip after a voice-read stop or no on a call (services/voiceReadConsent.ts stripVoiceReadLines).
// One constant so the two can't drift (merge of #304 into #310: the renderer said "a read of the call picked up:" while the strip
// still looked for "their voice showed:", so after a stop the moments would have stayed in the call prompt).
export const LAST_CALL_MOMENTS_HEADER = "a read of the call picked up:";
const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The whole line, as the renderer writes it: "On your call <when>, <header> <moments>".
export const LAST_CALL_MOMENTS_LINE = new RegExp(`^[ \\t]*On your call [^\\n]*?, ${escape(LAST_CALL_MOMENTS_HEADER)} [^\\n]*(\\r?\\n|$)`, "gm");
