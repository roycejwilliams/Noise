// The company is Noise (Royce, 2026-10-14; it was Co from 2026-10-05): in any talk, legal and IP included. Cue is told that in its
// voice; this keeps it true in what actually goes out, without naming the retired words to the model.
// A member who says "CoPatible" or "BR3W" themselves (real history they bring up) can have it said back.
const OLD_NAMES = /\b(?:BR3W|CoPatible)\b/gi;

export function brandSafe(text: string, theirWords = ""): string {
  const said = new Set((theirWords.match(OLD_NAMES) ?? []).map((w) => w.toLowerCase()));
  return text.replace(OLD_NAMES, (w) => (said.has(w.toLowerCase()) ? w : "Noise"));
}
