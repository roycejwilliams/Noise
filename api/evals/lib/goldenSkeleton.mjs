// The golden replay's second key (Royce, 2026-10-29: "Stop requiring a full re-record for wording-only prompt changes"). A recording
// is found first by the exact request hash (evals/lib/goldenReplay.mjs keyOf). When that misses, the request's SKELETON is tried: the
// same request with its instruction wording masked out, so a call whose only change is how an instruction is worded still finds its
// recording, and is reported as "prompt moved" (a warning, never a silent pass).
//
// What is WORDING (masked, may move, and only with a moved-ledger entry: evals/golden/run.ts): the text of the literals in the
// declarations allowlisted in evals/golden/wording.ts (tone and style only), each masked as its own placeholder.
// What is BEHAVIOR (kept, any change is a miss and needs a re-record): everything else. The model and every request parameter; every
// tool, whole (name, description, schema: a tool's description tells the model when to call it); the message roles and order, the
// model's own earlier turns and every tool result; every fact line ("[F12] ...") and conversation line ("User said: ..."); every
// interpolated value and every literal outside the allowlist (safety, grounding, consent, facts, gates, checker prompts); which
// allowlisted literals are included at all. And within an allowlisted literal, a move is blocked when it changes the literal's
// GUARD TERMS (numbers, tool-like names, and the words that carry rules: never, always, only, must, call, offer, question, safe,
// member, share, private, invent, JSON...), or when it asks for an output format: the words may move, the rules they carry may not.
import { createHash } from "node:crypto";

export const SKELETON_VERSION = 2;
export const MIN_CHUNK = 40;
const sha = (s, n = 16) => createHash("sha256").update(s).digest("hex").slice(0, n);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

// The terms a tone rewrite must keep (as a multiset): a changed count of any is a changed rule, not a rewording.
const GUARD_WORDS = /\b(?:never|always|only|once|twice|must|every|each|no|not|don'?t|do not|call(?:s|ed|ing)?|phone|offer(?:s|ed)?|questions?|ask(?:s|ed)?|safe(?:ty)?|unsafe|hurt|harm|kill|emergency|crisis|members?|share[sd]?|sharing|private|privacy|invent(?:ed)?|plausible|guess|facts?|promise[sd]?|tasks?|tools?|links?|introduce[sd]?|consent|yes|json|one|two|three|four|five|six|seven|eight|nine|ten|several|few|couple|many|most|least)\b|\d+/gi;
// Tool-like names (startTask, sendReply): case-sensitive, or every word would match.
const TOOL_NAMES = /\b[a-z]+[A-Z]\w*\b/g;
export const guardTerms = (text) => [...(String(text ?? "").match(GUARD_WORDS) ?? []).map((w) => w.toLowerCase()), ...(String(text ?? "").match(TOOL_NAMES) ?? [])].sort().join(" ");

// A literal that tells the model what shape to answer in.
export const looksLikeFormat = (text) => /\bJSON\b|"\w+"\s*:\s*["{[\d<]/.test(String(text ?? ""));

// The registry's signature: a stamp made under another allowlist, or another algorithm, is never compared.
export const registrySignature = (allowlist) => sha(JSON.stringify({ v: SKELETON_VERSION, min: MIN_CHUNK, allowlist: [...allowlist].sort() }), 12);

// Lines that are data however they were built: the reply's facts, and the conversation as it happened.
const PROTECTED = /^(?:\[F\d+\] |(?:User said|Co replied|Cue replied|Member said|They said|Cue said|Co said):)/;

// Masks every wording chunk found in one string. `found` collects the ids seen.
export function maskText(s, chunks, found) {
  if (typeof s !== "string" || !s) return s;
  const kept = [];
  let t = s.split("\n").map((l) => (PROTECTED.test(l) ? (kept.push(l), `\u0000${kept.length - 1}\u0000`) : l)).join("\n");
  for (const c of chunks) {
    if (!t.includes(c.text)) continue;
    t = t.split(c.text).join(`⟦${c.id}⟧`);
    found.add(c.id);
  }
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

const maskContent = (content, role, chunks, found) => {
  // The model's own earlier turns are what it said: never masked.
  if (role !== "user" && role !== "system") return content;
  if (typeof content === "string") return maskText(content, chunks, found);
  if (!Array.isArray(content)) return content;
  // A tool result is what the code returned: behavior, never masked.
  return content.map((b) => (b && b.type === "text" ? { ...b, text: maskText(b.text, chunks, found) } : b));
};

// The skeleton of a request key ({ path, grader, beta, body }, as goldenReplay.mjs builds it) under the given wording chunks
// ({ id, text }[], longest first). Returns its hash, the wording ids it contains with each one's text hash (so a match can say what
// moved), the ids that ask for an output format, and a hash of the tool descriptions.
export function skeletonOf(key, chunks) {
  const found = new Set();
  const body = key.body && typeof key.body === "object" ? { ...key.body } : key.body;
  if (body && typeof body === "object") {
    delete body.metadata;
    // Tools are kept whole: their descriptions and schemas are behavior.
    if (typeof body.system === "string") body.system = maskText(body.system, chunks, found);
    else if (Array.isArray(body.system)) body.system = body.system.map((b) => (b && b.type === "text" ? { ...b, text: maskText(b.text, chunks, found) } : b));
    if (Array.isArray(body.messages)) body.messages = body.messages.map((m) => (m && typeof m === "object" ? { ...m, content: maskContent(m.content, m.role, chunks, found) } : m));
    if (typeof body.prompt === "string") body.prompt = maskText(body.prompt, chunks, found);
  }
  const text = JSON.stringify(canon({ path: key.path, grader: key.grader, beta: key.beta ?? null, body }));
  const byId = new Map(chunks.map((c) => [c.id, c.text]));
  const wording = Object.fromEntries([...found].sort().map((id) => [id, sha(byId.get(id), 8)]));
  const guard = Object.fromEntries([...found].sort().map((id) => [id, sha(guardTerms(byId.get(id)), 8)]));
  const format = [...found].filter((id) => looksLikeFormat(byId.get(id))).sort();
  return { hash: sha(text), wording, guard, format };
}

// What moved between a stamp and the request now, both with the same skeleton: each allowlisted literal whose text changed, from its
// stamped hash to its hash now. `blocked` holds the moved ones that may not move: an output-format literal (old or new), or one whose
// guard terms changed (a rule added, dropped or changed inside tone text), or one stamped without guard terms.
export function movedBetween(stamp, now) {
  const moved = Object.keys(now.wording).filter((id) => stamp.wording?.[id] !== now.wording[id]).map((id) => ({ id, from: stamp.wording?.[id] ?? null, to: now.wording[id] }));
  const blocked = moved.filter((m) => (stamp.format ?? []).includes(m.id) || now.format.includes(m.id) || !stamp.guard?.[m.id] || stamp.guard[m.id] !== now.guard[m.id]).map((m) => m.id);
  return { moved, blocked };
}
