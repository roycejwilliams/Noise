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
// GUARD TERMS (numbers, tool-like names, links and money, and the words that carry rules: never, always, only, must, call, offer,
// question, safe, member, share, private, invent, JSON, negations, permission, personal data, outreach, sales, care, conduct, order...), or when it asks for an output format: the words may move, the rules they carry may not.
import { createHash } from "node:crypto";

// 3: the guard terms widened (review round 2 of #318); a stamp made under 2 is never compared.
export const SKELETON_VERSION = 3;
export const MIN_CHUNK = 40;
const sha = (s, n = 16) => createHash("sha256").update(s).digest("hex").slice(0, n);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

// The terms a tone rewrite must keep (as a multiset): a changed count of any is a changed rule, not a rewording. Review round 2 of #318
// widened them past the rule words: negations, permission, personal data, outreach, sales and links, safety and care, conduct, numbers
// past ten and quantity (more, less), and order. What they can't see: the same words reordered ("Ask first, advise second" -> "Advise first, ask second") keeps the
// multiset, so it passes as a move (a known limit; the ledger entry and the quality run are what catch it).
const GUARD_WORDS = new RegExp("\\b(?:" + [
  // rules
  "never", "always", "only", "once", "twice", "must", "every", "each", "no", "not", "don'?t", "do not", "call(?:s|ed|ing)?", "phone", "offer(?:s|ed)?",
  "questions?", "ask(?:s|ed)?", "safe(?:ty)?", "unsafe", "hurt", "harm", "kill", "emergency", "crisis", "members?", "share[sd]?", "sharing", "private",
  "privacy", "invent(?:ed)?", "plausible", "guess", "facts?", "promise[sd]?", "tasks?", "tools?", "links?", "introduce[sd]?", "consent", "yes", "json",
  // negations
  "won'?t", "can'?t", "cannot", "without", "avoid(?:s|ed|ing)?", "skip(?:s|ped|ping)?", "stop(?:s|ped|ping)?", "nothing", "none", "nobody", "unless",
  "except", "instead",
  // permission
  "may", "can", "fine", "okay", "ok", "allow(?:s|ed)?", "free", "freely", "assum(?:e|es|ed|ing)",
  // personal data
  "people", "others", "anyone", "everyone", "names?", "address(?:es)?", "emails?", "birthdays?", "locations?",
  // outreach
  "voice", "chats?", "texts?", "texting", "messages?", "remind(?:s|ed|ers?)?", "follow(?:s|ed|ing)?", "check-ins?", "schedul(?:e|es|ed|ing)",
  // sales
  "buy(?:s|ing)?", "sell(?:s|ing)?", "tickets?", "pitch(?:es|ed|ing)?", "prices?", "pay(?:s|ing|ment)?",
  // safety and care
  "hotlines?", "therapists?", "therapy", "doctors?", "medical", "legal", "diagnos(?:e|es|is|ing)",
  // conduct
  "flirt\\w*", "romantic", "warm\\w*",
  // numbers
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundreds?", "thousands?",
  "millions?", "dozens?", "several", "few", "fewer", "couple", "many", "most", "least", "more", "less",
  // order
  "first", "last", "before", "after",
].join("|") + ")\\b|\\d+", "gi");
// Money and links: a dollar sign, a scheme, www, or a bare domain (noise.club/apply).
const LINKISH = /\$|https?:\/\/|\bwww\.|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
// Tool-like names (startTask, sendReply): case-sensitive, or every word would match.
const TOOL_NAMES = /\b[a-z]+[A-Z]\w*\b/g;
export const guardTerms = (text) => [...[...(String(text ?? "").match(GUARD_WORDS) ?? []), ...(String(text ?? "").match(LINKISH) ?? [])].map((w) => w.toLowerCase()), ...(String(text ?? "").match(TOOL_NAMES) ?? [])].sort().join(" ");

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
// The request key's canonical text with the given wording chunks masked (`found` collects the ids seen).
function maskedOf(key, chunks, found) {
  const body = key.body && typeof key.body === "object" ? { ...key.body } : key.body;
  if (body && typeof body === "object") {
    delete body.metadata;
    // Tools are kept whole: their descriptions and schemas are behavior.
    if (typeof body.system === "string") body.system = maskText(body.system, chunks, found);
    else if (Array.isArray(body.system)) body.system = body.system.map((b) => (b && b.type === "text" ? { ...b, text: maskText(b.text, chunks, found) } : b));
    if (Array.isArray(body.messages)) body.messages = body.messages.map((m) => (m && typeof m === "object" ? { ...m, content: maskContent(m.content, m.role, chunks, found) } : m));
    if (typeof body.prompt === "string") body.prompt = maskText(body.prompt, chunks, found);
  }
  return JSON.stringify(canon({ path: key.path, grader: key.grader, beta: key.beta ?? null, body }));
}

export function skeletonOf(key, chunks) {
  const found = new Set();
  const text = maskedOf(key, chunks, found);
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

// The text a moved literal had in a recording (for --ledger to show what moved): the recorded request with today's other wording masked,
// read at the moved literal's places in today's masked request. Both have the same skeleton, so everything around the moved text lines
// up. { id: text } for each id found; an id it can't line up is left out.
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function wordingBefore(recordedKey, nowKey, chunks, ids) {
  const want = new Set(ids);
  if (!want.size) return {};
  const now = maskedOf(nowKey, chunks, new Set());
  const old = maskedOf(recordedKey, chunks.filter((c) => !want.has(c.id)), new Set());
  const parts = now.split(new RegExp(`⟦(${[...want].map(reEscape).join("|")})⟧`));
  const out = {};
  // A scan, not one regex (a request is too long for one): the text between each pair of literal stretches is the old text.
  if (parts.length < 3 || !old.startsWith(parts[0])) return out;
  let at = parts[0].length;
  for (let i = 1; i < parts.length; i += 2) {
    const next = parts[i + 1];
    const last = i + 2 >= parts.length;
    const end = last ? (old.endsWith(next) && old.length - next.length >= at ? old.length - next.length : -1) : old.indexOf(next, at);
    if (end < 0) return {};
    if (!(parts[i] in out)) { try { out[parts[i]] = JSON.parse(`"${old.slice(at, end)}"`); } catch {} }
    at = end + next.length;
  }
  return out;
}
