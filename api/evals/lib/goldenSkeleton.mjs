// The golden replay's second key (Royce, 2026-10-29: "Stop requiring a full re-record for wording-only prompt changes"). A recording
// is found first by the exact request hash (evals/lib/goldenReplay.mjs keyOf). When that misses, the request's SKELETON is tried: the
// same request with its instruction wording masked out, so a call whose only change is how an instruction is worded still finds its
// recording, and is reported as "prompt moved" (a warning, never a silent pass).
//
// What is WORDING (masked, may move without a re-record):
//   - the text of string and template literals (40+ characters) in the prompt files listed in evals/golden/wording.ts, each masked as
//     its own placeholder: the file, the declaration it sits in, and its place there ("conversationReply.ts:system#3");
//   - a tool's description and the descriptions inside its input schema.
// What is BEHAVIOR (kept, any change is a miss and needs a re-record):
//   - the model, max_tokens, effort, thinking, temperature, tool_choice, stream and every other request parameter;
//   - the tool names and input schemas (types, required fields, enums);
//   - the message roles and order, the model's own earlier turns (assistant text, tool calls) and every tool result;
//   - every fact line ("[F12] ...") and conversation line ("User said: ...", "Co replied: ..."), even when its words come from a prompt file;
//   - every interpolated value (names, the member's words, the case's facts, the member's world, dates), and which instructions are
//     included at all: a literal added, dropped or swapped for another is a different placeholder, so the skeleton differs;
//   - a literal that asks for an output format (it mentions JSON or shows a "key": shape): a moved one is a miss, since the recorded
//     answer was written for the old format;
//   - literals under 40 characters, and any prompt text outside the listed files (the case's own judge prompts included).
import { createHash } from "node:crypto";

export const SKELETON_VERSION = 1;
export const MIN_CHUNK = 40;
const sha = (s, n = 16) => createHash("sha256").update(s).digest("hex").slice(0, n);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

// A literal that tells the model what shape to answer in.
export const looksLikeFormat = (text) => /\bJSON\b|"\w+"\s*:\s*["{[\d<]/.test(String(text ?? ""));

// The registry's signature: a stamp made under another set of files, or another algorithm, is never compared.
export const registrySignature = (files) => sha(JSON.stringify({ v: SKELETON_VERSION, min: MIN_CHUNK, files: [...files].sort() }), 12);

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

const withoutDescriptions = (v) => {
  if (Array.isArray(v)) return v.map(withoutDescriptions);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (k !== "description") out[k] = withoutDescriptions(x);
  return out;
};
const descriptionsOf = (v, out = []) => {
  if (Array.isArray(v)) v.forEach((x) => descriptionsOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "description" && typeof x === "string") out.push(x); else descriptionsOf(x, out); }
  return out;
};

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
  let tools = null;
  if (body && typeof body === "object") {
    delete body.metadata;
    if (Array.isArray(body.tools)) { tools = sha(JSON.stringify(descriptionsOf(body.tools)), 8); body.tools = withoutDescriptions(body.tools); }
    if (typeof body.system === "string") body.system = maskText(body.system, chunks, found);
    else if (Array.isArray(body.system)) body.system = body.system.map((b) => (b && b.type === "text" ? { ...b, text: maskText(b.text, chunks, found) } : b));
    if (Array.isArray(body.messages)) body.messages = body.messages.map((m) => (m && typeof m === "object" ? { ...m, content: maskContent(m.content, m.role, chunks, found) } : m));
    if (typeof body.prompt === "string") body.prompt = maskText(body.prompt, chunks, found);
  }
  const text = JSON.stringify(canon({ path: key.path, grader: key.grader, beta: key.beta ?? null, body }));
  const byId = new Map(chunks.map((c) => [c.id, c.text]));
  const wording = Object.fromEntries([...found].sort().map((id) => [id, sha(byId.get(id), 8)]));
  const format = [...found].filter((id) => looksLikeFormat(byId.get(id))).sort();
  return { hash: sha(text), wording, format, tools };
}

// What moved between a stamp and the request now, both with the same skeleton: the wording ids whose text changed, and the tool
// descriptions. `blocked` holds the moved ids that ask for an output format (old or new): those never count as wording.
export function movedBetween(stamp, now) {
  const moved = Object.keys(now.wording).filter((id) => stamp.wording?.[id] !== now.wording[id]);
  const blocked = moved.filter((id) => (stamp.format ?? []).includes(id) || now.format.includes(id));
  if ((stamp.tools ?? null) !== (now.tools ?? null)) moved.push("tool descriptions");
  return { moved, blocked };
}
