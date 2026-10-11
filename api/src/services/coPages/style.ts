// A member's look as data (2026-10-11): a mood, three colors and a type family. Shared by every artifact that takes their taste:
// decks (deck.ts) and pages (schema.ts, template.ts). Colors are six-digit hex only and text is contrast-checked, so nothing but a
// readable color can reach the CSS.
export const DECK_MOODS = ["minimal", "bold", "warm", "dark", "playful", "editorial", "classic"] as const;
export type DeckMood = (typeof DECK_MOODS)[number];
export type DeckStyle = { mood: DeckMood; background: string; text: string; accent: string; type: "serif" | "sans" };

// Each mood's own pairing: the default when they named no colors, and the fallback when theirs wouldn't read. "minimal" is the
// default when they don't care (Royce: "If they don't care, default to clean and minimal").
export const MOOD_STYLES: Record<DeckMood, Omit<DeckStyle, "mood">> = {
  minimal: { background: "#FAFAF8", text: "#141414", accent: "#7A7A7A", type: "sans" },
  bold: { background: "#111111", text: "#FFFFFF", accent: "#FF4F1F", type: "sans" },
  warm: { background: "#F6EFE6", text: "#2B1D14", accent: "#B5652E", type: "serif" },
  dark: { background: "#121417", text: "#ECEDEE", accent: "#7FA7D9", type: "sans" },
  playful: { background: "#FFF6E9", text: "#1E1B4B", accent: "#E8487D", type: "sans" },
  editorial: { background: "#FBF9F5", text: "#1A1A1A", accent: "#9A3A55", type: "serif" },
  classic: { background: "#FFFFFF", text: "#0B2545", accent: "#9C7A45", type: "serif" },
};

const HEX = /^#[0-9a-f]{6}$/i;
// WCAG contrast ratio of two hex colors.
export function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// Pure: a style from a mood and the colors they named (any may be missing or bad). Body text must read on the background (4.5:1);
// the accent only needs to be seen (2:1 against the background, else the mood's accent).
export function styleFrom(mood: unknown, colors: { background?: unknown; text?: unknown; accent?: unknown } = {}, type?: unknown): DeckStyle {
  const m: DeckMood = DECK_MOODS.includes(mood as DeckMood) ? (mood as DeckMood) : "minimal";
  const base = MOOD_STYLES[m];
  const pick = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim().toUpperCase() : d);
  const background = pick(colors.background, base.background);
  let text = pick(colors.text, base.text);
  if (contrast(text, background) < 4.5) text = contrast(base.text, background) >= 4.5 ? base.text : contrast("#111111", background) >= contrast("#FFFFFF", background) ? "#111111" : "#FFFFFF";
  let accent = pick(colors.accent, base.accent);
  if (contrast(accent, background) < 2) accent = text;
  return { mood: m, background, text, accent, type: type === "serif" || type === "sans" ? type : base.type };
}

