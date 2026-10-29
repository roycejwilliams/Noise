// A member's design system (Royce, 2026-10-12: "Make Co's artifacts feel made by a designer who knows the member"). Decks, pages,
// docs and PDFs all read it, through the one pipeline below.
//
// WHERE IT LIVES
//   Table member_design_signals (db/migrations.ts). Every time the member says something about the look ("navy and gold", "use
//   Canela"), corrects one Co made ("less gold", "make it airier"), picks a preset, or Co reads a reference of theirs (a logo, a
//   screenshot, a Pinterest board), one row is written: owner, context (professional or personal), source, the tokens it carries
//   (values jsonb), their words (quote), what it came from (ref). Rows are never rewritten; the design system is the fold of them.
//   The older design_taste memory (services/designTaste.ts) still reads as a "stated" signal, so a member's earlier taste carries over.
//   One member's rows only, keyed by owner_user_id on every read and write: one member's taste never reaches another's artifact.
//
// HOW IT'S READ (foldSignals, pure)
//   Each token (background, text, accent, accent2, gradient, display font, body font, type, density, mood, title layout) is taken
//   from the signal with the highest score: source weight (correction 3, stated 2, confirmed reference 2, preset 1, inferred 0.5)
//   times a 60-day half life, so a correction today beats what they said last month, and something said once long ago fades behind
//   what they say now. The other context counts at half weight, only for tokens this context has nothing on. A reference read that
//   they haven't confirmed yet is never folded in: it's "pending" until the confirm-the-read line is answered.
//   "Answered" is every token any signal ever carried, or "don't care": an answered design question is never asked again.
//
// FILL AND STATE (fillDesign, pure)
//   A sparse brief is filled from the design system first, then from the mood's own designed defaults (fonts paired per mood, the
//   audience's density), and Co states its choices in one line (choicesLine). Co asks one question at most, and only when the design
//   system has nothing at all and Co never asked (the existing one ask, agent/deckTools.ts). Before building from a reference it just
//   read, Co sends one confirm-the-read line (confirmLine: "Deep green into teal, bold sans headlines, lots of air, right?"); that is
//   the one question. Their reply confirms it, or corrects it (a correction signal).
//
// EXACT DETAILS
//   Fonts: services/designFonts.ts (Google Fonts by name; commercial fonts mapped to the closest open one with a one-line note).
//   Reference tokens: services/designRead.ts (real pixels: the palette, a gradient's two ends, the logo's ink and ground, its size and
//   crop; a vision read only for what pixels can't say: serif or sans, weight, the closest open face, density).
//
// LAYOUTS (services/coPages/deck.ts, template.ts, documentSheet.ts)
//   Decks: title layouts field (a full-bleed color or gradient field, oversized type), editorial (paper, oversized display type, a
//   gradient strip), centered (the logo leads); content layouts statement, points, grid and split, picked from each slide's shape
//   unless Co picks one, with a rhythm rule (never three of a kind in a row). Pages: the cover band takes their gradient and fonts.
//   Docs and PDFs: the letter layout in their fonts and accent. Every layout is filled by the member's tokens, never by Co's theme.
//
// QA BEFORE ANY SEND (services/designQa.ts)
//   The artifact is rendered in headless Chrome and screenshotted, then measured: type scale, spacing (safe margins), contrast of
//   every text run on its actual ground (each end of a gradient), overflow, orphan headlines, image placement (stretched past its
//   pixels, cropped logos), plus per-medium rules (decks one idea per slide; pages scannability; docs and PDFs print type and page
//   breaks). Mechanical findings are fixed in code and measured again; content findings go back to Co once. What it found is logged.
//
// BAD INPUTS
//   A low-res image is placed small (never stretched), a logo cropped to its edges gets a plate with its own ground, and both are said
//   in the tool's result so Co can mention it in a few words.
//
// METRICS (artifact_design_log + view artifact_design_metrics, designMetrics below; npm run metrics:design)
//   Every artifact made logs its medium, layout, tokens, QA and the member turns it took from their ask; every change logs "revised".
//   First-shot acceptance = no QA finding left standing, built within one member turn of the ask, and no correction or revision within
//   48 hours (isFirstShot, the view); keeps = co_pages.kept; shares = co_page_shares. Queryable per medium.
import pool from "../db/db.js";
import { DECK_MOODS, contrast, extrasFrom, normalHex, styleFrom, type DeckMood, type DeckStyle, type Density, type TitleLayout } from "./coPages/style.js";
import { DEFAULT_FONTS, validFont, type FontChoice } from "./designFonts.js";

export type DesignContext = "professional" | "personal";
export type SignalSource = "correction" | "stated" | "reference" | "preset" | "inferred";
export const TOKEN_FIELDS = ["background", "text", "accent", "accent2", "gradient", "display", "body", "type", "density", "mood", "titleLayout"] as const;
export type TokenField = (typeof TOKEN_FIELDS)[number];
export type Tokens = Partial<{
  background: string;
  text: string;
  accent: string;
  accent2: string;
  gradient: boolean;
  display: FontChoice;
  body: FontChoice;
  type: "serif" | "sans";
  density: Density;
  mood: DeckMood;
  titleLayout: TitleLayout;
}>;
export type DesignSignal = {
  id?: number;
  context: DesignContext;
  source: SignalSource;
  values: Tokens & { dontCare?: boolean; cleared?: TokenField[] };
  quote: string | null;
  ref: string | null;
  confirmed: boolean;
  askedAt: Date | null;
  at: Date;
  fontNotes?: string[];
};
export type DesignSystem = {
  context: DesignContext;
  tokens: Tokens;
  // Which signal each token came from (its source), for the choices line and the log.
  from: Partial<Record<TokenField, SignalSource>>;
  answered: Set<TokenField>;
  dontCare: boolean;
  references: string[];
  // Reference reads waiting on their confirm, newest first.
  pending: DesignSignal[];
  fontNotes: string[];
  // Their own words behind the tokens that won (the quotes of those signals), so the colors are named the way they named them.
  quotes?: string[];
};

export const DESIGN_LIMITS = { halfLifeDays: 60, otherContext: 0.5, pendingHours: 12, signals: 80 } as const;
// A reference they confirmed counts as much as their own words (they said "right" to it); recency decides between the two.
const WEIGHT: Record<SignalSource, number> = { correction: 3, stated: 2, reference: 2, preset: 1, inferred: 0.5 };
const HEX = /^#[0-9a-f]{6}$/i;

// Pure: only well-formed tokens survive (hex colors, open fonts, known moods, densities and layouts).
export function cleanTokens(v: unknown): Tokens & { dontCare?: boolean; cleared?: TokenField[] } {
  const x = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out: Tokens & { dontCare?: boolean; cleared?: TokenField[] } = {};
  // "1F4F4A" without its "#" is still their color (design audit: a vibe's four colors were all dropped for the missing "#").
  for (const k of ["background", "text", "accent", "accent2"] as const) {
    const h = normalHex(x[k]);
    if (h) out[k] = h;
  }
  if (typeof x.gradient === "boolean") out.gradient = x.gradient;
  if (validFont(x.display)) out.display = { family: x.display.family, source: x.display.source, kind: x.display.kind };
  if (validFont(x.body)) out.body = { family: x.body.family, source: x.body.source, kind: x.body.kind };
  if (x.type === "serif" || x.type === "sans") out.type = x.type;
  const ex = extrasFrom({ density: x.density, titleLayout: x.titleLayout });
  if (ex.density) out.density = ex.density;
  if (ex.titleLayout) out.titleLayout = ex.titleLayout;
  if (DECK_MOODS.includes(x.mood as DeckMood)) out.mood = x.mood as DeckMood;
  if (x.dontCare === true) out.dontCare = true;
  // A clear (services/whatCoKnows.ts): the member removed these tokens for this context; carries no token of its own.
  if (Array.isArray(x.cleared)) {
    const c = x.cleared.filter((f): f is TokenField => (TOKEN_FIELDS as readonly string[]).includes(f as string));
    if (c.length) out.cleared = [...new Set(c)];
  }
  return out;
}

// Pure: the design system for one context from their signals, newest first or not.
export function foldSignals(signals: DesignSignal[], context: DesignContext, now: Date = new Date()): DesignSystem {
  const age = (d: Date) => Math.max(0, (now.getTime() - d.getTime()) / 86_400_000);
  const score = (s: DesignSignal) => WEIGHT[s.source] * 0.5 ** (age(s.at) / DESIGN_LIMITS.halfLifeDays) * (s.context === context ? 1 : DESIGN_LIMITS.otherContext);
  const usable = signals.filter((s) => s.source !== "reference" || s.confirmed);
  const tokens: Tokens = {};
  const from: DesignSystem["from"] = {};
  // The signal each token came from: references and font notes are said only for what actually won (review: a turned-down read
  // still said "from your logo", and a corrected font kept its old note).
  const winner: Partial<Record<TokenField, DesignSignal>> = {};
  const answered = new Set<TokenField>();
  for (const f of TOKEN_FIELDS) {
    const has = usable.filter((s) => s.values[f] !== undefined);
    for (const s of has) answered.add(f);
    // This context first; the other only for a token this context never had, and never for one the member cleared here (a clear
    // in this context, services/whatCoKnows.ts: "remove my work look" must not hand work decks the personal look).
    const clearedHere = signals.some((s) => s.context === context && s.values.cleared?.includes(f));
    const cands = has.some((s) => s.context === context) || clearedHere ? has.filter((s) => s.context === context) : has;
    // Ties go to the newer signal.
    const best = cands.sort((a, b) => score(b) - score(a) || b.at.getTime() - a.at.getTime())[0];
    if (best) {
      (tokens as any)[f] = best.values[f];
      from[f] = best.source;
      winner[f] = best;
    }
  }
  // "Don't care" counts only when nothing newer in this context says otherwise.
  const latest = [...usable].filter((s) => s.context === context || !usable.some((u) => u.context === context)).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  const dontCare = !!latest?.values.dontCare && Object.keys(tokens).length === 0;
  const pending = signals.filter((s) => s.source === "reference" && !s.confirmed).sort((a, b) => b.at.getTime() - a.at.getTime());
  const won = [...new Set(Object.values(winner))] as DesignSignal[];
  const references = [...new Set(won.filter((s) => s.source === "reference" && s.ref).sort((a, b) => b.at.getTime() - a.at.getTime()).map((s) => s.ref!))].slice(0, 5);
  const fontNotes = [...new Set([winner.display, winner.body].filter((s): s is DesignSignal => !!s).flatMap((s) => s.fontNotes ?? []))].slice(0, 2);
  const quotes = [...new Set(won.map((s) => s.quote).filter((q): q is string => !!q))].slice(0, 6);
  return { context, tokens, from, answered: dontCare ? new Set(TOKEN_FIELDS) : answered, dontCare, references, pending, fontNotes, quotes };
}

// ---------------------------------------------------------------- fill and state

// Each mood's own designed pairing (display, body), the default when they named no fonts.
const F = (family: string, kind: "serif" | "sans"): FontChoice => ({ family, source: "google", kind });
export const MOOD_FONTS: Record<DeckMood, { display: FontChoice; body: FontChoice }> = {
  minimal: { display: F("Inter Tight", "sans"), body: F("Inter", "sans") },
  bold: { display: F("Bricolage Grotesque", "sans"), body: F("Inter", "sans") },
  warm: { display: F("Fraunces", "serif"), body: F("DM Sans", "sans") },
  dark: { display: F("Space Grotesk", "sans"), body: F("Inter", "sans") },
  playful: { display: F("Bricolage Grotesque", "sans"), body: F("DM Sans", "sans") },
  editorial: { display: F("Fraunces", "serif"), body: F("Inter", "sans") },
  classic: { display: F("Libre Caslon Text", "serif"), body: F("Inter", "sans") },
};

// Who it's for, to the context and the density a designer would start from.
export function audienceContext(audience: string | null | undefined): DesignContext | null {
  const a = String(audience ?? "").toLowerCase();
  if (!a.trim()) return null;
  if (/\b(investor|vc|board|client|partner|sponsor|team|boss|manager|customer|hiring|recruit|conference|panel|pitch|company|colleague|venue|stakeholder)/.test(a)) return "professional";
  if (/\b(friend|family|wedding|birthday|partner's|mom|dad|kids?|party|guests|personal|myself|me)\b/.test(a)) return "personal";
  return null;
}
// A board or a review reads dense material; everyone else gets air.
const audienceDensity = (audience: string | null | undefined): Density => (/\b(board|analysts?|report|review)\b/i.test(String(audience ?? "")) ? "balanced" : "airy");

export type Filled = { style: DeckStyle; chosen: Partial<Record<TokenField, "yours" | "default">>; notes: string[] };

// Pure: a complete look from their design system, with what was theirs and what Co chose. Readable text is re-checked (styleFrom).
export function fillDesign(ds: Pick<DesignSystem, "tokens" | "context" | "dontCare">, o: { audience?: string | null; hasLogo?: boolean } = {}): Filled {
  const t = ds.tokens;
  const chosen: Filled["chosen"] = {};
  const mark = (f: TokenField, mine: boolean) => (chosen[f] = mine ? "yours" : "default");
  const mood: DeckMood = t.mood ?? (ds.dontCare ? "minimal" : t.gradient ? "bold" : t.type === "serif" ? "editorial" : "minimal");
  mark("mood", !!t.mood);
  const base = styleFrom(mood, { background: t.background, text: t.text, accent: t.accent }, t.type ?? t.display?.kind, { field: !!t.gradient });
  for (const f of ["background", "text", "accent", "type"] as const) mark(f, t[f] !== undefined && (base as any)[f] === (t as any)[f]);
  const pair = MOOD_FONTS[mood];
  // Their type family wins over the mood's pairing: a serif look never gets a sans display face.
  const display = t.display ?? (base.type === pair.display.kind ? pair.display : DEFAULT_FONTS[base.type]);
  const body = t.body ?? pair.body;
  mark("display", !!t.display);
  mark("body", !!t.body);
  let accent2 = t.accent2;
  // A gradient's second end must still read as a field with the accent; without one it's the accent a shade deeper.
  if (t.gradient && !accent2) accent2 = shade(base.accent, -0.25);
  const gradient = !!t.gradient && !!accent2;
  mark("gradient", t.gradient !== undefined);
  mark("accent2", !!t.accent2);
  const density = t.density ?? audienceDensity(o.audience);
  mark("density", !!t.density);
  // A full color field opens only a loud look or a gradient; a dark or luxe one opens quietly on its own paper (design audit: "black,
  // gold, quiet expensive" opened on a full mustard field).
  const loud = mood === "bold" || mood === "playful";
  const titleLayout: TitleLayout = t.titleLayout ?? (gradient || loud ? "field" : o.hasLogo && mood === "minimal" ? "centered" : "editorial");
  mark("titleLayout", !!t.titleLayout);
  const style: DeckStyle = { ...base, display, body, density, titleLayout, ...(accent2 ? { accent2 } : {}), ...(gradient ? { gradient: true } : {}) };
  return { style, chosen, notes: [] };
}

// Pure: a hex color moved toward black (amount < 0) or white (amount > 0).
export function shade(hex: string, amount: number): string {
  const to = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) + (to - parseInt(hex.slice(i, i + 2), 16)) * t).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

// Plain color names for the lines Co says ("navy", "deep green"): the nearest by perceived distance.
const NAMED: [string, string][] = [
  ["black", "#0A0A0A"], ["charcoal", "#2E2E2E"], ["slate", "#4A5560"], ["grey", "#8A8A8A"], ["stone", "#C9C3B8"], ["white", "#FFFFFF"], ["off-white", "#F6F4EF"],
  ["cream", "#F3EAD7"], ["ivory", "#FBF7EC"], ["beige", "#E2D3B6"], ["tan", "#C2A27A"], ["brown", "#6B4527"], ["chocolate", "#3D2416"],
  ["navy", "#14284B"], ["midnight blue", "#0F1A33"], ["cobalt", "#1F4FD1"], ["blue", "#2F6FDF"], ["sky blue", "#8EC5F0"], ["powder blue", "#C8DCEB"],
  ["teal", "#138C8C"], ["deep teal", "#0B4F55"], ["turquoise", "#2EC4C0"], ["mint", "#A7E3C6"], ["sage", "#9DAF8E"], ["green", "#2E9B4F"], ["deep green", "#0E4A2C"],
  ["forest green", "#1F4D2B"], ["emerald", "#0F8A5F"], ["lime", "#B5D82C"], ["olive", "#6B6E2B"], ["chartreuse", "#D4E157"],
  ["yellow", "#F2D22E"], ["mustard", "#C9A227"], ["gold", "#C5A15A"], ["antique gold", "#A8864D"], ["champagne", "#E3CFA5"], ["amber", "#E59B1C"], ["orange", "#F26A1B"],
  ["coral", "#F08064"], ["salmon", "#F4A08A"], ["peach", "#F7C3A3"], ["terracotta", "#C0623F"], ["rust", "#A0441E"],
  ["red", "#D62E2E"], ["crimson", "#A3122A"], ["burgundy", "#6D1A2B"], ["maroon", "#5A1F2A"], ["pink", "#F28CB1"], ["blush", "#F1C9C5"], ["rose", "#C9577A"],
  ["magenta", "#C2187A"], ["purple", "#6A3FB5"], ["plum", "#5B2A4F"], ["lavender", "#BBA9E0"],
];
const lab = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const X = (c[0] * 0.4124 + c[1] * 0.3576 + c[2] * 0.1805) / 0.95047;
  const Y = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  const Z = (c[0] * 0.0193 + c[1] * 0.1192 + c[2] * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const labDist = (x: string, y: string) => {
  const a = lab(x), b = lab(y);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};
// words: their own words about the look. A color they named that this one is close to is said their way ("gold", not "mustard";
// design audit, 2026-10-12), else the nearest name.
export function colorName(hex: string, words?: string | null): string {
  if (!HEX.test(hex)) return "";
  const said = words ? theirColorWords(words) : [];
  const near = said.map((n) => ({ n, d: labDist(hex, NAMED.find((x) => x[0] === n)![1]) })).filter((x) => x.d <= 30).sort((x, y) => x.d - y.d)[0];
  if (near) return near.n;
  return NAMED.map(([n, h]) => ({ n, d: labDist(hex, h) })).sort((x, y) => x.d - y.d)[0].n;
}
// Pure: the color names that appear in their words, longest first ("deep teal" before "teal").
export function theirColorWords(words: string): string[] {
  const w = ` ${words.toLowerCase().replace(/[^a-z\s-]/g, " ").replace(/\s+/g, " ")} `;
  return NAMED.map(([n]) => n).filter((n) => w.includes(` ${n} `)).sort((a, b) => b.length - a.length);
}
const isNeutral = (hex: string) => /^(black|charcoal|white|off-white|ivory|cream|grey|stone)$/.test(colorName(hex));

// Pure: the colors in a few words: "deep green into teal", "navy and gold", "black on cream". words: their own words about the look,
// so a color they named is said their way.
export function colorWords(t: Tokens, words?: string | null): string {
  const bg = t.background, ink = t.text, acc = t.accent, acc2 = t.accent2;
  const name = (h: string) => colorName(h, words);
  if (t.gradient && acc && acc2) return `${name(acc)} into ${name(acc2)}`;
  const named = [bg && !isNeutral(bg) ? bg : null, acc, acc2].filter((x): x is string => !!x).map(name);
  const uniq = [...new Set(named)];
  if (uniq.length >= 2) return `${uniq[0]} and ${uniq[1]}`;
  if (uniq.length === 1 && bg) return `${uniq[0]} on ${name(bg)}`;
  if (ink && bg) return `${name(ink)} on ${name(bg)}`;
  return uniq[0] ?? "";
}
const AIR: Record<Density, string> = { airy: "lots of air", balanced: "balanced spacing", dense: "tight and full" };
const typeWords = (t: Tokens, weight?: string | null) => {
  const kind = t.display?.kind ?? t.type;
  if (!kind) return "";
  const w = weight === "bold" || weight === "black" ? "bold " : weight === "light" ? "light " : "";
  return `${w}${kind} headlines`;
};

// Pure: the confirm-the-read line, before Co builds from a reference it just read: "Deep green into teal, bold sans headlines, lots
// of air, right?" Only what was measured or read; nothing else.
export function confirmLine(t: Tokens, o: { weight?: string | null; words?: string | null } = {}): string {
  const parts = [colorWords(t, o.words), typeWords(t, o.weight), t.density ? AIR[t.density] : ""].filter(Boolean);
  if (!parts.length) return "";
  const s = parts.join(", ");
  return `${s[0].toUpperCase()}${s.slice(1)}, right?`;
}

// Pure: Co's choices in one line, said with the link: "Set in Fraunces and Inter, deep green into teal, lots of air, from your logo."
// Built from the style as it was stored and applied (design audit: Co said "teal into coral" over a deck that had none), never from
// what was asked for. words: their own words about the look.
export function choicesLine(f: Pick<Filled, "style">, o: { refs?: string[]; fontNote?: string | null; words?: string | null } = {}): string {
  const st = f.style;
  const fonts = st.display && st.body ? (st.display.family === st.body.family ? `Set in ${st.display.family}` : `Set in ${st.display.family} and ${st.body.family}`) : `Set in ${st.type}`;
  const colors = colorWords({ background: st.background, text: st.text, accent: st.accent, accent2: st.accent2, gradient: st.gradient }, o.words);
  const air = st.density ? AIR[st.density] : "";
  const from = o.refs?.length ? `from ${o.refs.slice(0, 2).join(" and ")}` : "";
  const line = [fonts, colors, air, from].filter(Boolean).join(", ");
  return `${line}.${o.fontNote ? ` ${o.fontNote}` : ""}`;
}

// ---------------------------------------------------------------- storage (owner-keyed, every query)

export type DesignDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
let db: DesignDb = pool;
// Tests swap in a stub; nothing else should.
export function useDesignDb(d: DesignDb | null): void {
  db = d ?? pool;
}

const rowSignal = (r: any): DesignSignal => ({
  id: Number(r.id),
  context: r.context === "personal" ? "personal" : "professional",
  source: (["correction", "stated", "reference", "preset", "inferred"].includes(r.source) ? r.source : "inferred") as SignalSource,
  values: cleanTokens(typeof r.vals === "string" ? JSON.parse(r.vals) : r.vals),
  quote: r.quote ? String(r.quote) : null,
  ref: r.ref ? String(r.ref) : null,
  confirmed: !!r.confirmed,
  askedAt: r.asked_at ? new Date(r.asked_at) : null,
  at: new Date(r.created_at),
  fontNotes: Array.isArray(r.font_notes) ? r.font_notes.map(String) : [],
});

// assetN: the member's image number a reference read came from, so what's written in that image is never read as their words.
export async function recordSignal(userId: string, s: { context: DesignContext; source: SignalSource; values: Tokens & { dontCare?: boolean }; quote?: string | null; ref?: string | null; confirmed?: boolean; fontNotes?: string[]; assetN?: number | null; refKind?: "logo" | "inspiration" | "screenshot" | "board" | null }): Promise<number | null> {
  const values = cleanTokens(s.values);
  if (!Object.keys(values).length) return null;
  const { rows } = await db.query(
    `INSERT INTO member_design_signals (owner_user_id, context, source, vals, quote, ref, confirmed, font_notes, asset_n, ref_kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    // A ref is Co's own label for a reference it read ("your logo"); a stated taste's inspiration is in their quote, in their voice.
    [userId, s.context, s.source, JSON.stringify(values), s.quote ? s.quote.slice(0, 300) : null, s.ref && s.source === "reference" ? s.ref.slice(0, 120) : null, s.source === "reference" ? !!s.confirmed : true, JSON.stringify((s.fontNotes ?? []).slice(0, 3)), s.assetN ?? null, s.refKind ?? null],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

// ---------------------------------------------------------------- reference text is data for the look, never their words

// The image numbers of theirs Co read as an inspiration or a screenshot (readReference): what those images say is a stranger's text or
// a design's copy, never something the member said. Their own logo is different: its words are their brand, so it's never listed here
// (review of the design system PR: "Northlight Studio" on their logo was refused as a name they never gave). A photo they sent as content (a menu to summarize) was never read as a reference, so its
// description stays theirs: the line is drawn by what Co did with the image, which is what they asked for, not by its words.
export async function referenceImageNumbers(userId: string): Promise<Set<number>> {
  const { rows } = await db.query(`SELECT DISTINCT asset_n FROM member_design_signals WHERE owner_user_id = $1 AND source = 'reference' AND asset_n IS NOT NULL AND ref_kind IN ('inspiration', 'screenshot')`, [userId]);
  return new Set(rows.map((r) => Number(r.asset_n)));
}
// Pure: their words with every reference image's description taken out. The photo line the texting route records looks like
// "[sent a photo showing: ...] (saved as their image #N)"; only the description is dropped, so the record that a photo came stays.
export function withoutReferenceText(words: string, refs: Set<number>): string {
  if (!refs.size) return words;
  return words
    .replace(/\[sent a photo showing: [\s\S]*?\] \(saved as their image #(\d+)\)/g, (m, n: string) => (refs.has(Number(n)) ? `[sent a reference image for the look] (their image #${n})` : m))
    .replace(/\[They also sent a photo\. It shows: [\s\S]*?\. Saved as their image #(\d+)\]/g, (m, n: string) => (refs.has(Number(n)) ? `[They also sent a reference image for the look, their image #${n}]` : m));
}

export async function loadSignals(userId: string): Promise<DesignSignal[]> {
  // The newest signals, and every clear whatever its age (services/whatCoKnows.ts): a clear past the limit must still hold.
  const { rows } = await db.query(
    `(SELECT id, context, source, vals, quote, ref, confirmed, asked_at, created_at, font_notes FROM member_design_signals WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT $2)
     UNION
     (SELECT id, context, source, vals, quote, ref, confirmed, asked_at, created_at, font_notes FROM member_design_signals WHERE owner_user_id = $1 AND vals ? 'cleared')
     ORDER BY created_at DESC`,
    [userId, DESIGN_LIMITS.signals],
  );
  return rows.map(rowSignal);
}

// Their design system for a context. The older saved taste (designTaste.ts) reads as a stated signal in both contexts.
export async function loadDesignSystem(userId: string, context: DesignContext, now: Date = new Date()): Promise<DesignSystem> {
  const signals = await loadSignals(userId).catch(() => [] as DesignSignal[]);
  // The older saved taste only until they've said something about the look in the new system (it has no context, so it reads once,
  // as this context's, never as two signals; review of the design system PR). Reference reads alone don't replace it.
  const said = signals.some((s) => s.source !== "reference");
  const legacy = said ? null : await (await import("./designTaste.js")).loadDesignTaste(userId).catch(() => null);
  if (legacy) {
    const t = legacy.taste;
    const values = cleanTokens({ mood: t.dontCare ? undefined : t.mood, background: t.colors.background, text: t.colors.text, accent: t.colors.accent, type: t.type, dontCare: t.dontCare });
    signals.push({ context, source: "stated", values, quote: t.quote, ref: null, confirmed: true, askedAt: null, at: legacy.at });
  }
  // Pending reads expire: an unanswered confirm from yesterday never blocks today's deck.
  const fresh = signals.filter((s) => s.source !== "reference" || s.confirmed || now.getTime() - s.at.getTime() < DESIGN_LIMITS.pendingHours * 3600_000);
  return foldSignals(fresh, context, now);
}

// The confirm-the-read line went out for this read.
export async function markReadAsked(userId: string, id: number): Promise<void> {
  await db.query(`UPDATE member_design_signals SET asked_at = NOW() WHERE id = $1 AND owner_user_id = $2`, [id, userId]);
}
// They said no to it: the read carries nothing from now on (the row stays, as the record that it was read and turned down).
export async function dismissRead(userId: string, id: number): Promise<void> {
  await db.query(`UPDATE member_design_signals SET confirmed = true, vals = '{}'::jsonb, ref = NULL WHERE id = $1 AND owner_user_id = $2 AND source = 'reference'`, [id, userId]);
}
// They answered it: the read is part of their design system from now on.
export async function confirmRead(userId: string, id: number): Promise<void> {
  await db.query(`UPDATE member_design_signals SET confirmed = true WHERE id = $1 AND owner_user_id = $2 AND source = 'reference'`, [id, userId]);
}

// ---------------------------------------------------------------- metrics

export type Medium = "deck" | "page" | "doc";
// turnsToBuild: the member's turns between their ask and the build (0: built on the turn they asked; a confirm answered and built is 1).
export async function logArtifactDesign(e: { ownerUserId: string; pageId?: string | null; medium: Medium; event: "made" | "revised"; layout?: string | null; tokens?: unknown; qa?: unknown; confirmLine?: string | null; choices?: string | null; audience?: string | null; turnsToBuild?: number | null }): Promise<void> {
  await db.query(
    `INSERT INTO artifact_design_log (owner_user_id, page_id, medium, event, layout, tokens, qa, confirm_line, choices, audience, turns_to_build) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [e.ownerUserId, e.pageId ?? null, e.medium, e.event, e.layout ?? null, JSON.stringify(e.tokens ?? {}), JSON.stringify(e.qa ?? {}), e.confirmLine ?? null, e.choices ?? null, e.audience ? e.audience.slice(0, 120) : null, typeof e.turnsToBuild === "number" ? e.turnsToBuild : null],
  );
}

// The member's turns from the ask to this build: counted from the first time Co asked before building (the taste question or the
// confirm-the-read line, services/designTaste.ts recordTasteAsked) since their last artifact, in the last 12 hours. No ask: 0.
// current: this turn's words, counted when the turn's own line isn't logged yet.
export async function turnsToBuild(userId: string, current: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT MIN(created_at) AS asked FROM co_memories WHERE user_id = $1 AND memory_type = 'design_taste_asked' AND created_at > NOW() - INTERVAL '12 hours'
        AND created_at > COALESCE((SELECT MAX(created_at) FROM artifact_design_log WHERE owner_user_id = $1 AND event = 'made'), 'epoch')`,
    [userId],
  );
  const asked = rows[0]?.asked;
  if (!asked) return 0;
  // Their talk with a teammate (services/teamLines.ts) isn't a turn with Co.
  const { notToTeammate } = await import("./teamLines.js");
  const { rows: said } = await db.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at > $2`, [userId, asked]);
  const lines = said.map((r) => String(r.content));
  const now = current.trim().slice(0, 60);
  return lines.length + (now && !lines.some((l) => l.includes(now)) ? 1 : 0);
}

// Pure: first-shot acceptance for one artifact (design audit: the old view counted only "revised" events, so silence, a build that took
// four turns and unfixed QA findings all read as first shot). It is first shot only when nothing QA found was left standing, it was
// built within one member turn of their ask, and no correction or revision came within 48 hours.
// An artifact whose QA never ran is unknown (null), never first shot: nothing measured is not nothing found.
export function isFirstShot(a: { qaRan: boolean; qaUnresolved: number; turnsToBuild: number | null; corrections: number }): boolean | null {
  if (!a.qaRan) return null;
  return a.qaUnresolved === 0 && (a.turnsToBuild ?? 0) <= 1 && a.corrections === 0;
}

// First-shot acceptance, keeps and shares per medium over the last `days` (artifacts made at least 48 hours ago count for first shot),
// with the build turns and corrections behind it.
export async function designMetrics(days = 30): Promise<{ medium: string; made: number; settled: number; firstShot: number; firstShotRate: number | null; unknown: number; kept: number; shared: number; qaFindings: number; qaUnresolved: number; slowBuilds: number; corrected: number }[]> {
  const { rows } = await db.query(
    `SELECT medium, COUNT(*)::int AS made, COUNT(*) FILTER (WHERE settled)::int AS settled, COUNT(*) FILTER (WHERE settled AND first_shot)::int AS first_shot, COUNT(*) FILTER (WHERE settled AND first_shot IS NULL)::int AS unknown,
            COUNT(*) FILTER (WHERE kept)::int AS kept, COUNT(*) FILTER (WHERE shares > 0)::int AS shared, COALESCE(SUM(qa_findings), 0)::int AS qa_findings,
            COUNT(*) FILTER (WHERE qa_unresolved > 0)::int AS qa_unresolved, COUNT(*) FILTER (WHERE COALESCE(turns_to_build, 0) > 1)::int AS slow_builds, COUNT(*) FILTER (WHERE corrections > 0)::int AS corrected
       FROM artifact_design_metrics WHERE made_at > NOW() - make_interval(days => $1) GROUP BY medium ORDER BY medium`,
    [days],
  );
  return rows.map((r) => ({ medium: String(r.medium), made: r.made, settled: r.settled, firstShot: r.first_shot, firstShotRate: r.settled - r.unknown > 0 ? Math.round((r.first_shot / (r.settled - r.unknown)) * 100) / 100 : null, unknown: r.unknown, kept: r.kept, shared: r.shared, qaFindings: r.qa_findings, qaUnresolved: r.qa_unresolved, slowBuilds: r.slow_builds, corrected: r.corrected }));
}

// The pending confirm-the-read, said to Co at the start of the next turn (design audit: "Yes, that's right." got "Good, burgundy and
// white it is." and no deck, and the same confirm was asked again two turns later). Null when nothing waits on their answer.
export async function pendingLookInstruction(userId: string, now: Date = new Date()): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT id, context, vals, asked_at, created_at, quote FROM member_design_signals WHERE owner_user_id = $1 AND source = 'reference' AND confirmed = false AND asked_at IS NOT NULL AND created_at > $2 ORDER BY created_at DESC LIMIT 3`,
    [userId, new Date(now.getTime() - DESIGN_LIMITS.pendingHours * 3600_000)],
  );
  if (!rows.length) return null;
  const tokens = cleanTokens(typeof rows[0].vals === "string" ? JSON.parse(rows[0].vals) : rows[0].vals);
  const line = confirmLine(tokens);
  if (!line) return null;
  return `You asked them to confirm the look you read from their image ("${line}") and nothing is built from it until they answer. If what they just said answers it (a yes, or a change), act on it in this turn: if they asked for a deck, call makeDeck now with readConfirmed (true for a yes; false, with taste, for a change) and build it; if no deck is asked for yet, call readReference with answer set to their reply. Don't ask the confirm line again when they've answered it. If they didn't answer it, carry on with what they said (makeDeck says what to do if they asked for a deck).`;
}

// Pure: contrast is part of the check readers lean on (re-exported so QA and the renderers share one formula).
export { contrast };

// Pure: deck lines that copy a reference image's own words (four words in a row from what it says) that the member never wrote
// themselves. Provenance, not taste: where the line came from is the fact checked.
export function referenceCopies(lines: string[], refTexts: string[], theirWords: string): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const grams = (s: string) => {
    const w = norm(s).split(" ").filter(Boolean);
    const out = new Set<string>();
    for (let i = 0; i + 4 <= w.length; i++) out.add(w.slice(i, i + 4).join(" "));
    return out;
  };
  const ref = new Set(refTexts.flatMap((t) => [...grams(t)]));
  const theirs = ` ${norm(theirWords)} `;
  return lines.filter((l) => [...grams(l)].some((g) => ref.has(g) && !theirs.includes(` ${g} `)));
}
export async function referenceTexts(userId: string, numbers: Set<number>): Promise<string[]> {
  if (!numbers.size) return [];
  const { rows } = await db.query(`SELECT description FROM member_assets WHERE owner_user_id = $1 AND n = ANY($2::int[]) AND description IS NOT NULL`, [userId, [...numbers]]);
  return rows.map((r) => String(r.description));
}
