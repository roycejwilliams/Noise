// A mood can never cancel a helper (Royce, 2026-10-19: "Fix every place where a mood or feeling decides whether something happens.
// Rule: feelings change timing and tone, never cancel."). The shared pin over the mood registry (services/moodHold.ts):
//   1. every place ruled (MOOD_RULES) is "timing only, capped" and has its own registered layer 1 test that proves it waits;
//   2. a place is either ruled or documented as not yet changed (FEELING_PICKS_NOT_CHANGED), never both;
//   3. one cap, a constant;
//   4. a census of every mood read in src/: each one is the capped hold, wording, a declaration, a plain carry marked as one, a place
//      still documented as not changed, or a gate-shaped line pinned by its exact text with its reason (PINNED). Anything else (an if,
//      a ternary, a multi-line condition, an early return after a mood check, a variable that holds a read and is branched on later)
//      fails, whatever its shape, because the census flags the read itself, not a pattern around it.
// Fixing a place moves it from FEELING_PICKS_NOT_CHANGED into MOOD_RULES. A line that only carries or words a mood read says so with a
// trailing "// mood: <why>" note; a note never lets a gate-shaped line through (review of the mood stack: it did, four ways).
// Layer 1: reads the registry and the source. Zero tokens, no DB.
//   npx tsx evals/proactive/moodNeverCancels.ts
import fs from "node:fs";
import path from "node:path";
const MH = await import("../../src/services/moodHold.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 3000)}` : ""}`); } };
const root = new URL("../../", import.meta.url).pathname;
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const layer1 = JSON.parse(read("evals/layer1.json")).files as string[];
const rules = Object.entries(MH.MOOD_RULES) as [string, { where: string; ruling: string; test: string }][];
const open = MH.FEELING_PICKS_NOT_CHANGED;

// ---- 1. every ruled place waits, capped, with its own test
for (const [rule, r] of rules) {
  check(`${rule}: ruled timing only, capped`, /timing only, capped/.test(r.ruling) && !/pending/i.test(r.ruling), r);
  check(`${rule}: its test exists and runs in layer 1`, fs.existsSync(path.join(root, r.test)) && layer1.includes(r.test), r.test);
  check(`${rule}: its test names the rule`, read(r.test).includes(rule), r.test);
}

// ---- 2. ruled or documented, never both
for (const o of open) {
  check(`documented, not changed: ${o.where}`, /documented, not changed: needs Royce/.test(o.status), o);
  check(`not also ruled: ${o.where}`, !rules.some(([, r]) => r.where === o.where), o.where);
}

// ---- 3. one cap
check("one cap, a constant (no env)", typeof MH.MOOD_HOLD_CAP_HOURS === "number" && MH.MOOD_HOLD_CAP_HOURS > 0 && !/process\.env/.test(read("src/services/moodHold.ts")));

// ---- 4. the census
// Every mood read in src/ (moodHold.ts and emotion.ts make the reads, so they are not scanned) is one of: the capped hold, wording, a
// declaration, a plain carry marked "// mood: <why>", a place still documented as not changed, or a pinned line (PINNED, below).
// A line is gate-shaped when it, or the statement it continues (an open paren, a leading or trailing operator), has an if, a return,
// a ternary, &&, ||, a loop or switch word, or a filter/some/every/find over the read. A gate-shaped line is never let through by a
// note, by the capped hold's name on the same line, or by wording on the same line: it fails unless it is pinned or documented. A
// variable assigned from a mood read is itself a mood read for the rest of its block (so a ternary into a variable, then an if on
// that variable, fails like the if would).
// Code only: string, template and regex literals and comments become spaces (newlines kept, so line numbers hold).
export function codeOnly(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  let prev = ""; // the last code character that wasn't a space, for telling a regex from a division
  // A template literal's ${ … } is code (review of the mood stack: a gate hid inside one). Each open ${ keeps its own brace depth, so
  // the } that closes it (and not one inside it) returns to the template's text.
  const holes: number[] = [];
  const template = () => {
    while (i < n) {
      const e = text[i];
      if (e === "\\") { out += "  "; i += 2; continue; }
      if (e === "$" && text[i + 1] === "{") { out += "  "; i += 2; holes.push(0); prev = "("; return; }
      if (e === "`") { out += "`"; i++; prev = "`"; return; }
      out += e === "\n" ? "\n" : " "; i++;
    }
  };
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === "/" && d === "/") { while (i < n && text[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && d === "*") { while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; } out += "  "; i += 2; continue; }
    // A bracket read by a literal name (emo["needsCare"], emo?.[`current`]) is that field's read: written as .name, same length.
    if (c === "[" && /[\w$)\].]/.test(prev)) {
      const m = text.slice(i, i + 200).match(/^\[\s*(["'`])([A-Za-z_$][\w$]*)\1\s*\]/);
      if (m) { const name = (prev === "." ? "" : ".") + m[2]; out += name + " ".repeat(m[0].length - name.length); i += m[0].length; prev = m[2].slice(-1); continue; }
    }
    if (c === "`") { out += "`"; i++; template(); continue; }
    if (holes.length && c === "{") holes[holes.length - 1]++;
    if (holes.length && c === "}") {
      if (holes[holes.length - 1] === 0) { holes.pop(); out += " "; i++; template(); continue; }
      holes[holes.length - 1]--;
    }
    if (c === '"' || c === "'") {
      const q = c; out += q; i++;
      while (i < n) {
        const e = text[i];
        if (e === "\\") { out += "  "; i += 2; continue; }
        if (e === q || e === "\n") break;
        out += " "; i++;
      }
      if (text[i] === q) { out += q; i++; }
      prev = q; continue;
    }
    if (c === "/" && /[(,=:[!&|?{};]|^$/.test(prev)) {
      out += "/"; i++;
      let inClass = false;
      while (i < n && text[i] !== "\n") {
        const e = text[i];
        if (e === "\\") { out += "  "; i += 2; continue; }
        if (e === "[") inClass = true;
        else if (e === "]") inClass = false;
        else if (e === "/" && !inClass) break;
        out += " "; i++;
      }
      if (text[i] === "/") { out += "/"; i++; }
      prev = "/"; continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}
// The mood reads: the hard-day read, the frustration read, the heavy moment, any variable named for struggling, and the feeling's own
// fields (how strong, which way, when the hard stretch began, the feeling right now: emotion.ts EmotionalContext and EmotionSignal).
const MOOD_NAMED = /\bneedsCare\b|\bwithCo\b|\bfrustrated\w*|\bheavyMoment\b|\bheavyNow\b|\bstruggling\w*|\bmood\b|\bfeeling\b|\blabel\b/gi;
// "label" and "mood" name a feeling only in a file that reads feelings, and "label" only as a variable (not s.label): elsewhere they
// name a field, a button, a check, or a deck's or page's design mood (200+ lines of decks, pages and research fields, none a feeling).
const READS_FEELINGS = /\bemotion\w*|\bEmotionSignal\b|\bneedsCare\b|\bmoodHold\b|\bfeeling\b/;
// "current" only as a field (not "deps.current", the injected current-entry reader in services/memberStateNudges.ts).
const MOOD_FIELDS = /\bvalence\b|\bintensity\b|\bhardAt\b|\bhardSince\b|(?<=[\w$)\]]\??\.)(?<!\bdeps\??\.)current\b/g;
// An object or type key names a field; it doesn't read one ({ needsCare: false }, { frustrated?: boolean }). Its value still counts.
const stripKeys = (c: string) => c.replace(/(?<=(?:^|[{,(;])\s*)[A-Za-z_$][\w$]*\??\s*:(?!:)/g, (m) => " ".repeat(m.length));
// Through the capped hold (services/moodHold.ts and the functions built on it).
const CAPPED = /\b(?:heldForMood|moodHold|heavyHold|frustrationHold|firstMoodWait|firstDraftMoodWait|moodWaitRead|draftWaitRead|moodFallbackDecision|noteMoodHold|followUpMoodWait)\b/;
// A declaration: a field or parameter type.
const DECLARED = /(?:\bneedsCare|\bwithCo|\bfrustrated\w*|\bheavyNow|\bstruggling\w*|\bvalence|\bintensity|\bhardAt|\bhardSince|\bcurrent)\??\s*:\s*(?:boolean|\{|EmotionalContext|EmotionSignal|Valence|Intensity|Date|Pick<)/;
// Wording: a ternary that yields text, or a literal default.
const WORDING = /\?\s*(["'`])\s*\1\s*:/;
const WORDING_ALL = /\?\s*(["'`])\s*\1\s*:/g;
const LITERAL = /(?:\bneedsCare|\bfrustrated\w*|\bheavyNow)\??\s*:\s*(?:false|true)\b/;
// Branching: what makes a line decide something (a ternary is a lone "?", not ?. ?? or an optional field's ?:).
const BRANCH = /\bif\b|\breturn\b|\bwhile\b|\bswitch\b|\bcase\b|\bcontinue\b|\bbreak\b|\bthrow\b|&&|\|\||(?<!\?)\?(?![.?:=])|\.(?:filter|some|every|find|findIndex|findLast)\s*\(/;
const branches = (code: string) => BRANCH.test(code.replace(WORDING_ALL, " :"));
export type Flag = { file: string; line: number; read: string; text: string };
export type Pin = { file: string; line: string; why: string };
// A variable that holds a mood read, and the reads it came from.
type Taint = { name: string; from: Set<string>; depth: number };
const escape = (s: string) => s.replace(/[$]/g, "\\$");
// passOn: whether the use hands the read on to a new variable. Another field of an object that holds a read (turn.now) does not; the
// variable itself, or a method on it (negative.slice()), does.
function taintedIn(code: string, t: Taint, passOn = false): boolean {
  const re = new RegExp(`(?<![.\\w$])${escape(t.name)}(?![\\w$])`, "g");
  for (const m of code.matchAll(re)) {
    const before = code.slice(0, m.index).replace(/\s+$/, "");
    const after = code.slice(m.index! + t.name.length);
    if (/^\s*:(?!:)/.test(after) && /(?:^|[{,])$/.test(before)) continue; // an object key
    if (/^\s*=(?![=>])/.test(after)) continue; // assigned to, not read
    if (passOn && /^\??\.[A-Za-z_$][\w$]*(?!\s*\(|[\w$])/.test(after)) continue; // another field of it
    return true;
  }
  return false;
}
export function census(file: string, raw: string, documented: (file: string, read: string) => boolean, pins: Pin[] = [], usedPin: (p: Pin) => void = () => {}): Flag[] {
  const whole = codeOnly(raw);
  const code = whole.split("\n");
  const feelingFile = READS_FEELINGS.test(whole);
  const lines = raw.split("\n");
  const flags: Flag[] = [];
  // Paren depth at each line's start (an array literal's brackets don't join its lines), and brace depth (blocks), from the code alone.
  const parenAt: number[] = [], braceAt: number[] = [], braceMin: number[] = [];
  // Parens count within their own block: a callback's or an object argument's body is its own statements.
  let paren = 0, brace = 0;
  const outer: number[] = [];
  for (const l of code) {
    parenAt.push(paren); braceAt.push(brace);
    let min = brace;
    for (const ch of l) {
      if (ch === "(") paren++;
      else if (ch === ")") paren = Math.max(0, paren - 1);
      else if (ch === "{") { brace++; outer.push(paren); paren = 0; }
      else if (ch === "}") { brace = Math.max(0, brace - 1); min = Math.min(min, brace); paren = outer.pop() ?? 0; }
    }
    braceMin.push(min);
  }
  // The statement each line continues: its first line (the head).
  const head: number[] = [];
  code.forEach((l, i) => {
    const prev = i > 0 ? code[i - 1].trim() : "";
    const continues = i > 0 && (parenAt[i] > 0 || /(?:&&|\|\||\?\?|[?:=]|\()$/.test(prev) || /^(?:&&|\|\||\?|:(?!:)|\.(?!\.))/.test(l.trim()));
    head.push(continues ? head[i - 1] : i);
  });
  const end: number[] = [];
  for (let i = code.length - 1; i >= 0; i--) end[i] = i + 1 < code.length && head[i + 1] === head[i] ? end[i + 1] : i;
  let taints: Taint[] = [];
  const isMoodName = (w: string) => (feelingFile || !/^(?:label|mood)$/i.test(w)) && (new RegExp(`^(?:${MOOD_NAMED.source})$`, "i").test(w) || /^(?:valence|intensity|hardAt|hardSince|current)$/.test(w));
  // The mood reads on a line: the named reads and fields, and the variables that hold one (tainted: true).
  const readsOf = (c: string, passOn = false): Map<string, { from: Set<string>; tainted: boolean }> => {
    const k = stripKeys(c);
    const out = new Map<string, { from: Set<string>; tainted: boolean }>();
    // "label" counts as a variable that holds a feeling's label, not as another thing's field (s.label, r.label).
    const named = [...k.matchAll(MOOD_NAMED)].filter((m) => !/^(?:label|mood)$/i.test(m[0]) || (feelingFile && (!/^label$/i.test(m[0]) || !/\.\s*$/.test(k.slice(0, m.index))))).map((m) => m[0]);
    for (const m of [...named, ...(k.match(MOOD_FIELDS) ?? [])]) out.set(m.toLowerCase(), { from: new Set([m.toLowerCase()]), tainted: false });
    for (const t of taints) if (!out.has(t.name) && taintedIn(k, t, passOn)) out.set(t.name, { from: t.from, tainted: true });
    return out;
  };
  code.forEach((l, i) => {
    const reads = readsOf(l);
    // A declaration from a mood read: the variable carries the read for the rest of its block (not the capped hold's own result).
    if (head[i] === i) {
      const d = l.match(/^\s*(?:export\s+)?(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=(?![=>])/);
      if (d) {
        const rhs = [l.slice(d[0].length), ...code.slice(i + 1, end[i] + 1)].join("\n");
        const from = new Set<string>();
        for (const [, r] of readsOf(rhs, true)) for (const f of r.from) from.add(f);
        if (from.size && !(CAPPED.test(rhs) && !branches(rhs))) taints.push({ name: d[1], from, depth: braceAt[i] });
      }
      // A destructure: a mood field renamed ({ needsCare: care } = emo) puts the read in the new name; any name bound from a mood read
      // (const { hold } = struggling) carries it too.
      const ds = l.match(/^\s*(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=]*)?=(?![=>])/);
      if (ds) {
        const rhs = [l.slice(ds[0].length), ...code.slice(i + 1, end[i] + 1)].join("\n");
        const fromRhs = new Set<string>();
        for (const [, r] of readsOf(rhs, true)) for (const f of r.from) fromRhs.add(f);
        const capped = CAPPED.test(rhs) && !branches(rhs);
        for (const part of ds[1].split(",")) {
          const m = part.trim().match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/);
          if (!m) continue;
          const key = m[1], alias = m[2] ?? m[1];
          const from = new Set(capped ? [] : fromRhs);
          if (m[2] && isMoodName(key)) from.add(key.toLowerCase());
          if (from.size) taints.push({ name: alias, from, depth: braceAt[i] });
        }
      }
    }
    if (reads.size) {
      const pin = pins.find((p) => p.file === file && p.line === lines[i].trim());
      if (pin) usedPin(pin);
      else {
        const gate = branches(code.slice(head[i], i + 1).join("\n"));
        const passes = !gate && (/\/\/\s*mood:\s*\S/.test(lines[i]) || CAPPED.test(l) || DECLARED.test(l) || WORDING.test(l) || LITERAL.test(l));
        // A variable holding a read counts only where something branches on it; the read itself counts everywhere.
        for (const [r, { from, tainted }] of reads) {
          if (passes || (tainted && !gate) || [...from].some((f) => documented(file, f))) continue;
          flags.push({ file, line: i + 1, read: r, text: lines[i].trim().slice(0, 160) });
        }
      }
    }
    // A block that closes ends the variables declared in it.
    taints = taints.filter((t) => braceMin[i] >= t.depth);
  });
  return flags;
}
// A place still documented as not changed may keep its gate: its file and the read are both named in the entry.
const norm = (r: string) => (r.startsWith("frustrated") ? "frustrated" : r.startsWith("struggling") ? "struggling" : r);
const documented = (file: string, readName: string) => open.some((o) => o.where.includes(file.replace(/^src\//, "")) && `${o.where} ${o.what}`.toLowerCase().includes(norm(readName.toLowerCase())));
// Gate-shaped mood lines that are allowed, each by its exact text and why. Changing a pinned line (or adding a new gate-shaped one)
// fails the census until the pin is updated here, with its reason; a pin whose line is gone fails too.
export const PINNED: Pin[] = [
  { file: "src/harness/devReview.ts", line: "if (signalTarget({ source: e.source, about: e.about, target: e.target as any }) !== \"co\" || e.intensity === \"low\") continue;", why: "the internal dev review: which frustration-with-Cue reads become a flag for the team; never member-facing, holds or sends nothing" },
  { file: "src/harness/devReview.ts", line: "emotions: r.emotions.map((r: any) => ({ at: iso(r.created_at), source: r.source, emotion: r.emotion, intensity: r.intensity, about: r.about, quote: r.quote, target: r.target })),", why: "the internal dev review copies each read into its report; never member-facing, decides nothing" },
  { file: "src/harness/proactive.ts", line: "return !!s.needsCare && (s.moodHold ? s.moodHold.hold : true);", why: "heldForMood itself: a hard day holds only while the capped moodHold says hold (okay again, or the 48h cap, releases it)" },
  { file: "src/harness/proactive.ts", line: "if (!heldForMood(s)) return { state: s.needsCare ? s.moodHold?.state ?? \"none\" : \"none\", hold: false, heldHours };", why: "moodWaitRead once heldForMood has released: which state to report (released or none); decides nothing" },
  { file: "src/harness/proactive.ts", line: "if (HOLD_WHILE_STRUGGLING.has(p.candidate.type)) noteMoodHold(\"checkin_hold\", p.candidate.type, ref, state.needsCare ? state.moodHold ?? { state: \"held\", hold: true, heldHours: null } : { state: \"none\", hold: false, heldHours: null });", why: "the check-in hold's log line: which state to log; whether it waits is heldForMood (capped)" },
  { file: "src/harness/proactive.ts", line: "const read: MoodHold = member.state.needsCare ? member.state.moodHold ?? { state: \"held\", hold: true, heldHours: null } : { state: \"none\", hold: false, heldHours: null };", why: "the stop note's log line: which state to log; whether the note rides is noteMayRide(heldForMood), capped" },
  { file: "src/services/coldStart.ts", line: "if (o.frustrated) return { steer: false, why: \"frustrated with Cue right now\" }; // mood: the caller decides the hold (replyGrounding.ts)", why: "steerDecision decides nothing about mood itself: replyGrounding.ts passes frustrated and owns the wait (documented in FEELING_PICKS_NOT_CHANGED until it is capped)" },
  { file: "src/services/theDoor.ts", line: "if (o.frustrated) return { offer: false, why: \"frustrated with Cue right now\" }; // mood: the caller decides the hold (replyGrounding.ts)", why: "doorDecision decides nothing about mood itself: replyGrounding.ts passes frustrated and owns the wait (documented in FEELING_PICKS_NOT_CHANGED until it is capped)" },
  { file: "src/services/eventSurfacingSweep.ts", line: "...(trace.frustratedWithCo ? { revealNow: true } : {}), // mood: raises a find, never holds one", why: "frustration with Cue raises a find (sent whole, not teased); it never holds one" },
  { file: "src/services/eventSurfacingSweep.ts", line: "priority: isShortNotice(item.match, zone) ? 95 : trace.frustratedWithCo ? 85 : undefined, // mood: raises a find, never holds one", why: "frustration with Cue's own results raises this find's priority, so it can reorder the day; it never holds or cancels anything" },
  { file: "src/services/sweepFind.ts", line: "return { matches: gated, did, searched: searched || !blocked, frustratedWithCo: record.frustratedWithCo, sources: { ...tried, failures: sourceFailures } }; // mood: carries the read", why: "carries the read in the search result (search wider, never less); the || is on searched/blocked, not the read" },
  { file: "src/services/heavyMoment.ts", line: "const negative = life.filter((s) => s.valence === \"negative\" && s.basis !== \"frustration_score\" && !ABOUT_CO_TOO.test(`${s.about ?? \"\"} ${s.quote ?? \"\"}`.slice(0, 400)));", why: "the next-day check-in's trigger (pickEpisode): the hard reads about their life are what raise the check-in; nothing else is held" },
  { file: "src/services/heavyMoment.ts", line: "if (!negative.length) return null;", why: "the trigger: no hard read, no episode to check on (a feeling raises this check-in; its absence cancels nothing else)" },
  { file: "src/services/heavyMoment.ts", line: "while (start > 0 && negative[start].at.getTime() - negative[start - 1].at.getTime() <= gap) start--;", why: "the trigger: walks back through the hard reads to where the episode began" },
  { file: "src/services/heavyMoment.ts", line: "const highs = episode.filter((s) => s.intensity === \"high\");", why: "the trigger: the high-intensity reads in the episode" },
  { file: "src/services/heavyMoment.ts", line: "const mediums = episode.filter((s) => s.intensity === \"medium\");", why: "the trigger: the medium-intensity reads in the episode" },
  { file: "src/services/heavyMoment.ts", line: "if (!highs.length && mediums.length < HEAVY.mediumsNeeded) return null;", why: "the trigger: an everyday complaint (one medium read) is not an episode to check on" },
  { file: "src/services/heavyMoment.ts", line: "if (!episode.some((s) => (s.about ?? \"\").trim() || (s.quote ?? \"\").trim())) return null;", why: "the trigger: nothing specific they said, nothing to check on" },
  { file: "src/services/heavyMoment.ts", line: "if (episode.some((s) => SELF_HARM.test(plain(`${s.about ?? \"\"} ${s.quote ?? \"\"}`)))) return null;", why: "a self-harm line goes to the safety path, never this check-in (safety, not mood)" },
  { file: "src/services/heavyMoment.ts", line: "if (life.some((s) => s.valence === \"positive\" && s.at > endedAt)) return null;", why: "the trigger: a good moment since means the stretch passed, so there is no episode to check on (the feeling raised it; nothing else is held)" },
  { file: "src/services/heavyMoment.ts", line: "const lead = (highs.length ? highs : mediums).slice(-1)[0];", why: "the trigger: which read the check-in is about (wording)" },
  { file: "src/services/readTurn.ts", line: "intensity: (e.intensity === \"high\" || e.intensity === \"medium\" ? e.intensity : \"low\") as Intensity,", why: "makes the read: the model's intensity, with a default for anything unexpected; decides nothing" },
  { file: "src/services/readTurn.ts", line: "valence: (e.valence === \"negative\" || e.valence === \"positive\" ? e.valence : \"mixed\") as Valence,", why: "makes the read: the model's valence, with a default for anything unexpected; decides nothing" },
  { file: "src/services/voiceFlags.ts", line: "valence: f?.valence === \"negative\" || f?.valence === \"positive\" ? f.valence : \"mixed\",", why: "makes the voice-flag read (dormant since 10-04): the model's valence, with a default; decides nothing" },
  { file: "src/services/voiceFlags.ts", line: "JSON.stringify(flags.map((f) => ({ at_secs: f.atSecs, quote: f.quote, cue: f.cue, feeling: f.feeling, valence: f.valence, reading: f.reading, confidence: f.confidence, kept: f.kept, drop_reason: f.dropReason }))),", why: "records the voice-flag read (dormant since 10-04); decides nothing" },
  // Reached once ${…} counts as code and label, mood and feeling count as reads (review of the mood stack, 2026-10-23).
  { file: "src/agent/companionCheckin.ts", line: "...(thread.feeling ? { how_they_felt_saying_it: thread.feeling } : {}),", why: "words the thread's feeling into the check-in draft's input when there is one; the ternary only picks whether that field is present" },
  { file: "src/harness/bundleComposer.ts", line: "${i.set && many ? `\\nTHE DAY'S SET (what Cue's pick saw in these together)\\n${i.set}\\n` : \"\"}${i.leadWhy ? `\\nWHY THE FIRST ONE LEADS\\n${i.leadWhy}\\n` : \"\"}${i.memberBlock ? `\\n${i.memberBlock}\\n` : \"\"}${i.feeling ? `\\nHOW THEY'VE BEEN FEELING (it shapes how you say this, never whether: if they've been struggling, gentler and lower-pressure; the captions never name it; your own line after the last thing may speak to what they're going through, gently, only from what's here; the closing question never names it)\\n${i.feeling}\\n` : \"\"}", why: "the composer prompt: each ternary only picks whether a section's text (the feeling's among them) is in the prompt" },
  { file: "src/harness/bundleComposer.ts", line: "const aboutThem = [grounding, i.memberBlock ?? \"\", i.feeling ?? \"\"].join(\"\\n\");", why: "the identity check's grounding text includes how they've been; decides nothing about a mood" },
  { file: "src/harness/bundleComposer.ts", line: "else if ((stripUngroundedIdentity(text, at === \"opening\" ? aboutThem : grounding) ?? \"\").trim() !== text.trim()) problems.push({ at, why: `the ${at} says who they are beyond what they've told Cue` });", why: "the identity check (who they are beyond what they told Cue); reaches the census only through aboutThem's text, decides nothing about a mood" },
  { file: "src/harness/devReview.ts", line: "snippet: clip(`${e.emotion} (${e.intensity})${e.about ? ` about ${e.about}` : \"\"}${e.quote ? `: \"${e.quote}\"` : \"\"}`),", why: "the internal dev review words a read into its snippet; never member-facing, decides nothing" },
  { file: "src/harness/devReview.ts", line: "if (!groups.length) return [`Cue review, ${label}: nothing flagged.`];", why: "'label' here is a digest window ('last 24h') label, not a feeling's; decides nothing about a mood" },
  { file: "src/harness/devReview.ts", line: "return [`Cue review, ${label}: ${flags.length} flag${flags.length === 1 ? \"\" : \"s\"} in ${groups.length} type${groups.length === 1 ? \"\" : \"s\"}.`, `${lines.join(\"\\n\")}${more}`, `Full detail with decision-log rows: ask Claude \"what broke since ${label.replace(/^last /, \"\")}\".`];", why: "'label' here is a digest window ('last 24h') label, not a feeling's; decides nothing about a mood" },
  { file: "src/harness/devReview.ts", line: "const label = opts.since ? `since ${opts.since}` : \"last 24h\";", why: "'label' here is a digest window ('last 24h') label, not a feeling's; decides nothing about a mood" },
  { file: "src/harness/devReview.ts", line: "console.log(renderDigest(flags, names, label).join(\"\\n\\n\"));", why: "'label' here is a digest window ('last 24h') label, not a feeling's; decides nothing about a mood" },
  { file: "src/harness/devReview.ts", line: "console.log(`What broke ${label} (${since.toISOString()} to ${until.toISOString()}): ${flags.length} flags\\n`);", why: "'label' here is a digest window ('last 24h') label, not a feeling's; decides nothing about a mood" },
  { file: "src/harness/memberReflection.ts", line: "thread: { text: t.text, quote: t.openedQuote, dueDate: t.dueDate, feeling: t.feeling },", why: "carries the thread's feeling into the reflection draft's input; decides nothing" },
  { file: "src/harness/memberThreads.ts", line: "feeling: r.feeling,", why: "carries a thread's feeling (how they felt saying it) onto the thread; decides nothing" },
  { file: "src/harness/memberThreads.ts", line: "return rows[0] ? `${rows[0].emotion} (${rows[0].intensity})` : null;", why: "feelingAt: words the read nearest a quote as 'emotion (intensity)' for the thread record (null when none); decides nothing" },
  { file: "src/harness/memberThreads.ts", line: "label,", why: "the date words they gave for a commitment ('Friday'), carried into its follow-up; not a feeling, decides nothing about a mood" },
  { file: "src/harness/memberThreads.ts", line: "summary: `Ask how \"${text.slice(0, 80)}\" went (they said ${label})`,", why: "words the date they gave ('Friday') into the commitment follow-up's summary; not a feeling" },
  { file: "src/harness/memberThreads.ts", line: "const feeling = await feelingAt(userId, o.quotedAt);", why: "records how they felt when they opened the thread; decides nothing" },
  { file: "src/harness/memberThreads.ts", line: "[userId, o.text, o.quote, o.quotedAt + \":00Z\", feeling, o.dueDate, o.nextStep, o.kind],", why: "stores the thread's feeling with the thread row; decides nothing" },
  { file: "src/harness/memberThreads.ts", line: ".map((t) => `- ${t.text} (${t.status}, ${stampOf({ saidOn: t.openedAt, confirmedOn: t.lastTouchedAt, dueOn: t.dueDate }, now, wordsZone(zone)).label}${t.feeling ? `, felt ${t.feeling}` : \"\"}; they said: \"${t.openedQuote.slice(0, 160)}\")`)", why: "words a thread's feeling into the prompt ('felt anxious'); the ternary only picks text" },
  { file: "src/harness/memberThreads.ts", line: "thread: { text: thread.text, quote: thread.openedQuote, dueDate: thread.dueDate, feeling: thread.feeling },", why: "carries the thread's feeling into the follow-up draft's input; decides nothing" },
  { file: "src/harness/profileWrite.ts", line: "const label = FIELD_LABELS[r.field as CorrectableField] ?? r.field;", why: "'label' here is a corrected profile field's label, not a feeling's; decides nothing about a mood" },
  { file: "src/harness/profileWrite.ts", line: "? `- ${label}: you had \"${r.old_value}\"; they corrected it to \"${r.new_value}\" on ${day}`", why: "'label' here is a corrected profile field's label, not a feeling's; decides nothing about a mood" },
  { file: "src/harness/profileWrite.ts", line: ": `- ${label}: you had \"${r.old_value}\"; they said that's wrong on ${day}`;", why: "'label' here is a corrected profile field's label, not a feeling's; decides nothing about a mood" },
  { file: "src/harness/replyGrounding.ts", line: "addFact(rf, \"known\", `${label} Cue told them about: \"${match.name}\"${match.event_date ? `, on ${match.event_date}` : \"\"}${match.deadline ? `, application deadline ${match.deadline}` : \"\"}${note}.`);", why: "'label' here is a find's kind label ('Event' or 'Opportunity'), not a feeling's; decides nothing about a mood" },
  { file: "src/routes/sendblue.ts", line: "const label = String(rows[0]?.object_label ?? \"\").replace(link, \"\").trim();", why: "'label' here is a delivered object's (a doc or page title) label, not a feeling's; decides nothing about a mood" },
  { file: "src/routes/sendblue.ts", line: "return label ? { ...r, what: label } : r;", why: "'label' here is a delivered object's (a doc or page title) label, not a feeling's; decides nothing about a mood" },
  { file: "src/services/callContext.ts", line: "const label = day.toFormat(\"LLL d\");", why: "'label' here is a day ('Oct 3') label, not a feeling's; decides nothing about a mood" },
  { file: "src/services/callContext.ts", line: "return diff === 0 ? `today (${label})` : diff === -1 ? `yesterday (${label})` : label;", why: "'label' here is a day ('Oct 3') label, not a feeling's; decides nothing about a mood" },
  { file: "src/services/callContext.ts", line: "const label = LABELS[r.field] ?? r.field;", why: "'label' here is a corrected profile field's label, not a feeling's; decides nothing about a mood" },
  { file: "src/services/callContext.ts", line: "return r.new_value ? `- ${label}, ${dayLabel(r.corrected_at, zone)}: ${r.new_value} (not \"${r.old_value}\")` : `- ${label}, ${dayLabel(r.corrected_at, zone)}: not \"${r.old_value}\" (they said that's wrong)`;", why: "'label' here is a corrected profile field's label, not a feeling's; decides nothing about a mood" },
  { file: "src/services/callReason.ts", line: "cands.push({ kind: \"how_it_went\", key, text: `${t.text} (it was ${relDay(t.dueDate, today)}, ${t.dueDate})`, at: t.dueDate, theirWords: t.openedQuote, feeling: t.feeling });", why: "carries a thread's feeling into a call-reason candidate; decides nothing" },
  { file: "src/services/callReason.ts", line: "cands.push({ kind: t.feeling && /worr|anxi|stress|nerv|uneas|overwhelm|sad|frustrat|afraid|scared|tense/i.test(t.feeling) ? \"worry\" : \"open_thread\", key, text: t.text, at: t.openedAt.slice(0, 10), theirWords: t.openedQuote, feeling: t.feeling });", why: "a worried feeling words the reason and moves it up the call's order; it never removes it" },
  { file: "src/services/callReason.ts", line: "const felt = r.feeling ? ` (how they felt when they said it: ${r.feeling}; never name it to them)` : \"\";", why: "words the feeling into the call reason ('never name it to them'); the ternary only picks text" },
  { file: "src/services/callReason.ts", line: "return `Cue called because of something in their life: ${r.text}${felt}.${words}${quiet} Lead with them, never with Cue's own work.`;", why: "the call reason's text; reaches the census only through felt (wording)" },
  { file: "src/services/connectDots.ts", line: ".then((r) => r.rows.map((x: any) => ({ text: String(x.text), feeling: x.feeling ?? null })))", why: "carries each thread's feeling into the connect-the-dots input; decides nothing" },
  { file: "src/services/connectDots.ts", line: "${input.threads.map((t) => `- ${t.text}${t.feeling ? ` (feeling: ${t.feeling})` : \"\"}`).join(\"\\n\") || \"- (nothing open)\"}", why: "words each thread's feeling into the prompt; the ternary only picks text" },
  { file: "src/services/connectDots.ts", line: "${input.feeling ? `\\nHow they've been lately: ${input.feeling}\\n` : \"\"}", why: "words how they've been into the prompt; the ternary only picks text" },
  { file: "src/services/documentOffer.ts", line: "const feels = circling.find((r) => sameTopic(r.about, a.text)) ?? stuckThreads.find((t) => sameTopic(t.text, a.text));", why: "the trigger: which raised thread the offer is about (stuckThreads, above)" },
  { file: "src/services/documentOffer.ts", line: "if (feels && !done(a.text)) return { due: true, topic: a.text, why: `they asked for guidance on this ${Math.floor(a.ageDays)} days ago, and it keeps coming up unsettled` };", why: "the trigger: a circling ask or a raised thread makes the offer due; nothing planned is held or cancelled" },
  { file: "src/services/documentOffer.ts", line: "for (const t of stuckThreads) if (!done(t.text)) return { due: true, topic: t.text, why: `they feel ${t.feeling} about this and it has been open ${Math.floor(t.ageDays)} days` };", why: "the trigger: a raised thread makes the offer due and words why; nothing planned is held or cancelled" },
  { file: "src/services/documentOffer.ts", line: ".then((r) => r.rows.map((x: any) => ({ text: String(x.text), feeling: x.feeling ? String(x.feeling) : null, ageDays: days(new Date(x.opened_at), now) })))", why: "reads each thread's feeling for the trigger above; decides nothing itself" },
  { file: "src/services/documentOffer.ts", line: "const stuckThreads = s.threads.filter((t) => t.ageDays >= OFFER.threadDays && t.feeling && DIRECTION.test(t.feeling) && !CARE.test(t.feeling));", why: "the guidance offer's trigger: a thread they feel unsure, stuck or stressed about (DIRECTION) raises a document offer, one whose feeling is grief, exhaustion or crisis (CARE) doesn't raise one; nothing planned is held or cancelled" },
  { file: "src/services/eventDetails.ts", line: "${person.feeling ? `How they've been feeling: ${person.feeling}` : \"\"}`;", why: "words how they've been into the prompt; the ternary only picks text" },
  { file: "src/services/followUps.ts", line: "r?.feeling ? `their latest feeling: ${r.feeling}` : null,", why: "words their latest feeling into the follow-up's input; the ternary only picks text" },
  { file: "src/services/memberKnowledge.ts", line: "const docTitle = (label: string) => label.replace(DOC_LABEL, \"\").trim();", why: "'label' here is a delivered document's ledger label, not a feeling's; decides nothing about a mood" },
  { file: "src/services/memberKnowledge.ts", line: "add({ what: doc ? docTitle(r.label) : r.label, kind: doc ? \"document\" : r.kind ?? \"item\", at: r.at, via: \"ledger\", url: r.url });", why: "carries a delivered document's ledger label (docTitle(label)); not a feeling, decides nothing about a mood" },
  { file: "src/services/memberKnowledge.ts", line: "if (!title || items.some((i) => i.kind === \"document\" && (norm(i.what) === norm(title) || sameThing(i.what, title)))) continue;", why: "a delivered document's title from its ledger label (docTitle); not a feeling, decides nothing about a mood" },
  { file: "src/services/memberKnowledge.ts", line: "if (open.has(l)) items.push(item({ what: l.what, kind: \"promise\", state: \"outstanding\", told: true, theyHaveIt: false, dueAt: null, ref: null, verifiedAt: new Date(l.at).toISOString() }));", why: "promise state from the ledger; reaches the census only through docTitle(label), a document label, not a feeling" },
  { file: "src/services/memberKnowledge.ts", line: "else if (!collapseCarried([l], delivered, zoneDay).open.length) items.push(item({ what: l.what, kind: \"promise\", state: \"done\", told: true, theyHaveIt: true, dueAt: null, ref: null, verifiedAt: new Date(l.at).toISOString() }));", why: "promise state from the ledger; reaches the census only through docTitle(label), a document label, not a feeling" },
  { file: "src/services/memberKnowledge.ts", line: "feeling: cur ? `${cur.emotion}${cur.about ? ` about ${cur.about}` : \"\"} (${cur.intensity}, from a ${cur.source})` : null,", why: "words the feeling right now into the member's visible knowledge (null when there is none); decides nothing" },
  { file: "src/services/readTurn.ts", line: "const threads = ctx?.threads.map((t) => `- ${t.text}${t.feeling ? ` (feeling: ${t.feeling})` : \"\"}`).join(\"\\n\") || \"- (nothing open)\";", why: "words each thread's feeling into the read's prompt; the ternary only picks text" },
  { file: "src/services/sweepFind.ts", line: "feeling: k.restraint?.feeling ?? null,", why: "carries the feeling into the sweep's record (k.restraint.feeling); decides nothing" },
  { file: "src/services/sweepFind.ts", line: "${section(\"Where they're headed now:\", r.goals)}${section(\"Goals since done or set aside (history, not what to look for):\", r.goalsPast)}${section(\"Their other open asks (each gets its own sweep; context only):\", r.otherAsks)}${section(\"What they've corrected or Cue has learned (only the corrected version exists):\", r.learned)}${section(\"What they've told Cue, still holding:\", r.claims)}${r.observedTaste ? `How what Cue sent has landed: ${r.observedTaste}\\n` : \"\"}${r.feeling ? `How they've been: ${r.feeling} (this shapes how Cue says it, never whether they hear about something)\\n` : \"\"}${r.frustratedWithCo ? \"They've been frustrated with what Cue has found: look wider and try harder.\\n\" : \"\"}", why: "the sweep prompt: each section helper only words its text (how they've been, frustration with Cue's results) into the prompt" },
  { file: "src/services/sweepSelect.ts", line: "if (c.feeling) lines.push(`How they've been: ${c.feeling}`);", why: "words how they've been into the picker's prompt; the if only adds the line" },
  { file: "src/services/sweepSelectContext.ts", line: "feeling: k.restraint?.feeling ?? null,", why: "carries the feeling into the picker's context; decides nothing" },
  { file: "src/services/sweepSelectContext.ts", line: "feeling: feel.length ? feel.map((f: any) => `${f.emotion} (${f.intensity})${f.about ? ` about ${f.about}` : \"\"}`).join(\"; \") : null,", why: "words their recent feelings into the picker's context (null when none); decides nothing" },
  { file: "src/services/taskTurn.ts", line: "r?.feeling ? `How they are lately (from their own words): ${r.feeling}.` : null,", why: "words how they are lately into the task's prompt; the ternary only picks text" },
  { file: "src/services/turnContext.ts", line: "return st.drop ? [] : [{ text: String(x.text), feeling: x.feeling ?? null, line: `${String(x.text)} (${st.label})` }];", why: "carries a thread's feeling into the turn context; the drop is the thread's status (st.drop), not the feeling" },
  { file: "src/services/turnContext.ts", line: "const carrying = carryFromKnowledge(knowledge?.carrying ?? [], zone, windows).flatMap((c) => { const label = keep(c.label); return label ? [{ ...c, label }] : []; });", why: "'label' here is a carried item's (a promise or loop) label, not a feeling's; decides nothing about a mood" },
  { file: "src/services/turnContext.ts", line: "return { userId, message, profile, snapshot, sent, asks, threads: safeThreads, offersThisWeek, emotional, lessons: keepAll(lessons), inlineTarget, ledger: { ...ledger, lines: keepAll(ledger.lines), named: keepAll(ledger.named) }, capabilities: capabilitySheet(), google, kit, story, advice, tasks: keepAll(tasks), briefs: keepAll(briefs), goals: goals.flatMap((g) => { const text = keep(g.text); return text ? [{ ...g, text }] : []; }), todayEvent, docOffer, deliveries, carrying, recentDocs, drift, goalSetAsides: [...goalSetAsides, ...goalRechecks].flatMap((r) => { const g = keep(r.goal); return g ? [{ ...r, goal: g }] : []; }), retire, stopNote, statusCheck, coldStart, door, knowledge, rules: knowledge ? memberRules(knowledge) : null, searching, ahead, world };", why: "returns the turn context; reaches the census only through carrying (an item label), not a feeling" },
  { file: "src/services/voiceFlags.ts", line: "feeling: typeof f?.feeling === \"string\" ? f.feeling.toLowerCase().trim().slice(0, 40) : \"\",", why: "makes the voice-flag read (dormant since 10-04): the model's feeling, cleaned; decides nothing" },
  { file: "src/services/voiceFlags.ts", line: "else if (!base.feeling) dropReason = \"no feeling named\";", why: "the voice-flag audit (dormant since 10-04): a flag with no feeling named is dropped from the flags; nothing member-facing is held" },
  { file: "src/services/voiceFlags.ts", line: "return { at: new Date(rows[0].created_at), flags: rows.map((r: any) => ({ quote: r.quote, cue: r.cue, feeling: r.feeling, reading: r.reading })) };", why: "reads the stored voice flags (dormant since 10-04); decides nothing" },
  { file: "src/services/voiceFlags.ts", line: "const parts = v.flags.map((f) => `${CUE_WORDS[f.cue] ?? f.cue} when they said \"${f.quote}\" (${f.feeling})`);", why: "words the voice flags into the call-context line (dormant since 10-04); decides nothing" },
  { file: "src/services/voiceFlags.ts", line: "return `On your call ${ago}, their voice said more than their words: they ${parts.join(\"; \")}. That's one read of their tone, not something they told you: let it shape how you follow up, and never name it back to them.`;", why: "the voice-flag line's text; reaches the census only through parts (wording)" },

  { file: "src/harness/memberThreads.ts", line: "if (!rows[0]) continue;", why: "the inserted thread row (its insert carries the thread's feeling as a column): no row, nothing to follow up; the feeling decides nothing" },
  { file: "src/harness/memberThreads.ts", line: "if (o.kind === \"commitment\" && o.dueDate && o.dueLabel && (await queueCommitmentFollowUp(userId, rows[0].id, o.text, o.dueDate, o.dueLabel, zone))) queued.push(rows[0].id);", why: "queues the commitment follow-up for the inserted row; reaches the census only through the insert that stores the feeling, which decides nothing" },
  { file: "src/services/memberKnowledge.ts", line: "const keptLedger = ledger.flatMap((s) => { const label = g(s.label); return label === null ? [] : [{ ...s, label }]; });", why: "'label' here is a delivered item's ledger label (kept or dropped by the forget filter g), not a feeling; decides nothing about a mood" },
  { file: "src/services/memberKnowledge.ts", line: "if (on(\"delivered\")) k.delivered = mergeDelivered({ receipts: keptReceipts, ledger: keptLedger, offers: keptOffers });", why: "the delivered list from the kept ledger; reaches the census only through a ledger label, not a feeling" },
  { file: "src/services/memberKnowledge.ts", line: "if (on(\"carrying\")) k.carrying = carryingOf({ tasks, briefs, receipts: keptReceipts, ledger: keptLedger, loops: keptLoops, promises: keptPromises, now, zone });", why: "what Cue is carrying from the kept ledger; reaches the census only through a ledger label, not a feeling" },
  { file: "src/harness/replyGrounding.ts", line: "return !!r && (r.safetyHold || !!r.holdUntil || !!r.spaceUntil || r.unanswered.count > 0 || r.suppressedKinds.length > 0 || r.needsCare || r.frustratedWithCo); // mood: whether the restraint rule text is shown (wording)", why: "restraintOn: whether the restraint rule's text is shown in the reply prompt (wording); decides no send" },
  { file: "src/harness/replyGrounding.ts", line: "return !!e.needsCare || (!!e.current && e.current.intensity === \"high\" && e.current.valence === \"negative\"); // mood: the read; decisions take it only through heavyHold", why: "heavyMoment, the read itself: decisions take it only through heavyHold (capped)" },
  { file: "src/harness/replyGrounding.ts", line: "if (!heavyMoment(e)) return { state: \"none\", hold: false, heldHours: null }; // mood: the capped hold itself", why: "heavyHold, the capped hold itself: a heavy moment waits until they're okay again or the 48h cap" },
];
const files: string[] = [];
const walk = (d: string) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
walk("src");
const used = new Set<Pin>();
const flags = files.filter((f) => !/services\/moodHold\.ts$|harness\/emotion\.ts$/.test(f)).flatMap((f) => census(f, read(f), documented, PINNED, (p) => used.add(p)));
check("census: every mood read in src/ is the capped hold, wording, a declaration, a marked carry, a documented place, or pinned", flags.length === 0, flags.length);
for (const f of flags) console.log(`  ${f.file}:${f.line} ${f.read}: ${f.text}`);
check("census: every pin still names a line that needs it (update or remove a pin when its line changes)", PINNED.every((p) => used.has(p)), PINNED.filter((p) => !used.has(p)));
check("census: every pin says why", PINNED.every((p) => p.why.trim().length >= 20 && p.line.trim().length > 0), PINNED.filter((p) => p.why.trim().length < 20));

// The scan's own fixtures (review of the mood stack): gates in shapes a line pattern would miss must still fail.
const noDocs = () => false;
const FIXTURES: [string, string][] = [
  ["a ternary veto on the hard-day read", `export function steerDecision(o: any) {\n  const veto = (o as any).needsCare ? { steer: false, why: "x" } : null; if (veto) return veto;\n  return { steer: true };\n}`],
  ["a gate on the frustration read", `export function offerGate(s: any) {\n  if ((s as any).withCo?.frustrated) return "frustrated";\n  return null;\n}`],
  ["a multi-line condition with an early return", `export function pick(e: any) {\n  if (\n    e &&\n    e.needsCare\n  )\n    return null;\n  return 1;\n}`],
  ["a named struggling flag, then an early return", `export function pick(e: any) {\n  const struggling = !!e.hard;\n  if (struggling) return null;\n  return 1;\n}`],
  ["the bare heavy moment passed into a decision", `export function door(o: any) {\n  return doorDecision({ heavy: heavyMoment(o.emotional) });\n}`],
  // The four the review injected into services/coldStart.ts that the line census let through.
  ["a gate with a mood note", `export function steerDecision(o: any) {\n  if (o.needsCare) return { steer: false, why: "x" }; // mood: the caller decides the hold\n  return { steer: true };\n}`],
  ["the capped hold's name beside a raw read in the same gate", `export function steerDecision(o: any) {\n  if (heavyHold(o.e, o.now).hold || (o as any).needsCare) return { steer: false, why: "x" };\n  return { steer: true };\n}`],
  ["a string ternary into a variable, then a return on it", `export function steerDecision(x: any) {\n  const why = x.needsCare ? "a hard day" : null; if (why) return { steer: false, why };\n  return { steer: true };\n}`],
  ["the same across two lines, with a note on the ternary", `export function steerDecision(x: any) {\n  const why = x.needsCare ? "a hard day" : null; // mood: wording\n  if (why) return { steer: false, why };\n  return { steer: true };\n}`],
  ["a gate on the feeling right now", `export function steerDecision(e: any) {\n  if (e.current && e.current.intensity === "high") return { steer: false, why: "x" };\n  return { steer: true };\n}`],
  ["a gate on how negative the feeling is", `export function steerDecision(s: any) {\n  if (s.valence === "negative") return null;\n  return 1;\n}`],
  ["a gate on when the hard stretch began", `export function steerDecision(e: any, now: number) {\n  if (now - e.hardSince < 1) return null;\n  return 1;\n}`],
  // The four the second review got past the census (2026-10-23).
  ["a gate inside a template literal's ${…}", "export function steerDecision(o: any) {\n  const why = `${o.needsCare && skipAll()}`;\n  return `${o.needsCare ? cancel() : send()}`;\n}"],
  ["a destructure that renames the read, then a gate on the new name", `export function steerDecision(emo: any) {\n  const { needsCare: care } = emo;\n  if (care) return null;\n  return 1;\n}`],
  ["a bracket read by name", `export function steerDecision(emo: any) {\n  if (emo["needsCare"]) return null;\n  return 1;\n}`],
  ["a gate on a variable named for the mood", `export function steerDecision(e: any) {\n  const mood = e.emotion;\n  if (mood === "sad") return null;\n  return 1;\n}`],
  ["a gate on a feeling label", `export function steerDecision(sig: any) {\n  const label = sig.emotion; // an EmotionSignal's name\n  if (label === "low") return null;\n  return 1;\n}`],
  ["a gate on the feeling", `export function steerDecision(t: any) {\n  if (t.feeling) return null;\n  return 1;\n}`],
  ["a noted read inside a multi-line if", `export function pick(e: any) {\n  if (\n    e.ok &&\n    e.needsCare // mood: carries the read\n  ) return null;\n  return 1;\n}`],
];
for (const [label, srcText] of FIXTURES) check(`census fixture fails: ${label}`, census("src/services/fixture.ts", srcText, noDocs).length > 0, srcText);
const CONTROL = `type S = { needsCare?: boolean; current: EmotionSignal | null };\nconst a = r?.needsCare ? "they've been having a hard time lately" : null;\nconst b = heavyHold({ needsCare: x.needsCare }, now);\nif (b.hold) wait();\nconst c = { needsCare: !!raw.emotional?.needsCare }; // mood: carries the read\nconst d = "never when struggling";\nconst e = deps.currentEntry ?? null;`;
check("census fixture passes: wording, a declaration, the capped hold and its result, a marked carry", census("src/services/fixture.ts", CONTROL, noDocs).length === 0, census("src/services/fixture.ts", CONTROL, noDocs));
check("census fixture: a pin lets its exact line through, and only that line", census("src/services/fixture.ts", `if (o.frustrated) return null;`, noDocs, [{ file: "src/services/fixture.ts", line: "if (o.frustrated) return null;", why: "fixture: the pinned gate itself" }]).length === 0 && census("src/services/fixture.ts", `if (o.frustrated) return null; `.replace("null", "undefined"), noDocs, [{ file: "src/services/fixture.ts", line: "if (o.frustrated) return null;", why: "fixture: the pinned gate itself" }]).length > 0);

console.log(`\nmood never cancels: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
