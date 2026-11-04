// Fonts for a member's artifacts (services/designSystem.ts). Only open fonts, only from an open CDN: Google Fonts, or Fontshare for
// Co's own Satoshi. Never a font file Co hosts, never a commercial font.
//   - A font the member names that is on Google Fonts loads as itself (the web font, by name).
//   - A commercial font they name (Helvetica, Futura, Canela...) maps to the closest open font, with a one-line note saying so.
//   - Anything else falls back to the type family (serif or sans) the look calls for, said plainly.
// A family name is letters, digits and spaces only, so a stored name can never carry CSS or a URL of its own.

export type FontSource = "google" | "fontshare";
export type FontChoice = { family: string; source: FontSource; kind: "serif" | "sans" };
export type FontResolution = FontChoice & { asked: string; note: string | null };

export const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 ]{0,38}[A-Za-z0-9]$/;

// Open families known to be on Google Fonts, by kind. Not every family there: a name not in this list is checked against Google
// itself (googleHas) before it's used.
export const GOOGLE_FAMILIES: Record<string, "serif" | "sans"> = {
  Fraunces: "serif", "Playfair Display": "serif", "Cormorant Garamond": "serif", "Cormorant": "serif", "EB Garamond": "serif", "Libre Baskerville": "serif",
  "Libre Caslon Text": "serif", "Libre Caslon Display": "serif", Lora: "serif", Merriweather: "serif", "Source Serif 4": "serif", "Crimson Pro": "serif",
  "Crimson Text": "serif", "DM Serif Display": "serif", "DM Serif Text": "serif", Newsreader: "serif", "Instrument Serif": "serif", "Bodoni Moda": "serif",
  "Gilda Display": "serif", Marcellus: "serif", Cinzel: "serif", "Noto Serif": "serif", "PT Serif": "serif", Gelasio: "serif", Tinos: "serif",
  "Roboto Slab": "serif", "Zilla Slab": "serif", Spectral: "serif", "Young Serif": "serif", "Bricolage Grotesque": "sans", Inter: "sans",
  "Inter Tight": "sans", "DM Sans": "sans", Manrope: "sans", Figtree: "sans", "Plus Jakarta Sans": "sans", "Space Grotesk": "sans", "Work Sans": "sans",
  Montserrat: "sans", Jost: "sans", "Josefin Sans": "sans", "Nunito Sans": "sans", Lato: "sans", "Open Sans": "sans", Poppins: "sans", Raleway: "sans",
  Outfit: "sans", Syne: "sans", Archivo: "sans", "Archivo Black": "sans", "Instrument Sans": "sans", "IBM Plex Sans": "sans", "IBM Plex Serif": "serif",
  Sora: "sans", Urbanist: "sans", "Hanken Grotesk": "sans", Onest: "sans", Geist: "sans", Arimo: "sans", Karla: "sans", Rubik: "sans", "Red Hat Display": "sans",
  "Schibsted Grotesk": "sans", "Familjen Grotesk": "sans", "Anton": "sans", "Oswald": "sans", "Bebas Neue": "sans", Unbounded: "sans", "Big Shoulders Display": "sans",
};
// Fontshare (open, free for commercial use): Co's own body face.
export const FONTSHARE_FAMILIES: Record<string, "serif" | "sans"> = { Satoshi: "sans", "General Sans": "sans", "Clash Display": "sans", Switzer: "sans", Erode: "serif", Sentient: "serif" };

// Commercial fonts people name, to the closest open one. Lower-case keys, matched on the start of what they said ("Helvetica Neue
// Bold" is Helvetica).
export const COMMERCIAL_TO_OPEN: [string, string][] = [
  ["helvetica", "Inter"], ["neue haas", "Inter"], ["akzidenz", "Inter"], ["arial", "Arimo"], ["sf pro", "Inter"], ["san francisco", "Inter"],
  ["soehne", "Inter"], ["söhne", "Inter"], ["graphik", "Figtree"], ["gt america", "Inter Tight"], ["gt walsheim", "DM Sans"], ["circular", "DM Sans"],
  ["proxima nova", "Montserrat"], ["gotham", "Montserrat"], ["futura", "Jost"], ["avenir", "Nunito Sans"], ["brandon", "Josefin Sans"], ["gill sans", "Lato"],
  ["franklin gothic", "Libre Franklin"], ["din", "Barlow"], ["univers", "Inter"], ["frutiger", "Hanken Grotesk"], ["myriad", "Source Sans 3"], ["segoe", "Open Sans"],
  ["canela", "Fraunces"], ["tiempos", "Newsreader"], ["lyon", "Source Serif 4"], ["freight", "Crimson Pro"], ["publico", "Newsreader"], ["domaine", "Playfair Display"],
  ["didot", "Playfair Display"], ["bodoni", "Bodoni Moda"], ["baskerville", "Libre Baskerville"], ["caslon", "Libre Caslon Text"], ["garamond", "EB Garamond"],
  ["times", "Tinos"], ["georgia", "Gelasio"], ["minion", "Crimson Pro"], ["optima", "Marcellus"], ["trajan", "Cinzel"], ["copperplate", "Cinzel"],
  ["chronicle", "Spectral"], ["mercury", "Spectral"], ["ogg", "Fraunces"], ["gt sectra", "Fraunces"], ["recoleta", "Young Serif"], ["cooper", "Young Serif"],
  ["clarendon", "Roboto Slab"], ["rockwell", "Zilla Slab"], ["impact", "Anton"], ["druk", "Anton"], ["knockout", "Oswald"],
];
// The open fallbacks themselves are on Google even when not in GOOGLE_FAMILIES above.
const MAPPED_KIND: Record<string, "serif" | "sans"> = { "Libre Franklin": "sans", Barlow: "sans", "Source Sans 3": "sans" };

const titleCase = (s: string) => s.replace(/\s+/g, " ").trim().replace(/\b([a-z])/g, (m) => m.toUpperCase());
const kindOf = (family: string): "serif" | "sans" | null => GOOGLE_FAMILIES[family] ?? FONTSHARE_FAMILIES[family] ?? MAPPED_KIND[family] ?? null;

// Pure: a family's canonical spelling when Co knows it ("playfair display" is "Playfair Display").
function known(name: string): FontChoice | null {
  const want = name.replace(/\s+/g, " ").trim().toLowerCase();
  for (const [fam, kind] of Object.entries(GOOGLE_FAMILIES)) if (fam.toLowerCase() === want) return { family: fam, source: "google", kind };
  for (const [fam, kind] of Object.entries(FONTSHARE_FAMILIES)) if (fam.toLowerCase() === want) return { family: fam, source: "fontshare", kind };
  for (const [fam, kind] of Object.entries(MAPPED_KIND)) if (fam.toLowerCase() === want) return { family: fam, source: "google", kind };
  return null;
}

export const DEFAULT_FONTS: Record<"serif" | "sans", FontChoice> = { serif: { family: "Fraunces", source: "google", kind: "serif" }, sans: { family: "Inter", source: "google", kind: "sans" } };

// Pure: a named font to one Co can load. kindHint: the family the look calls for, used when the name means nothing Co can load.
// unknownOnGoogle: a name not in Co's lists that Google itself has (googleHas, checked by the caller).
export function resolveFont(asked: string, kindHint: "serif" | "sans" = "sans", unknownOnGoogle: (fam: string) => boolean = () => false): FontResolution {
  const raw = String(asked ?? "").replace(/[^\p{L}\p{N} '-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  const direct = raw ? known(raw) : null;
  if (direct) return { ...direct, asked: raw, note: null };
  const lower = raw.toLowerCase();
  const mapped = COMMERCIAL_TO_OPEN.find(([k]) => lower.startsWith(k) || lower === k);
  if (mapped) {
    const fam = mapped[1];
    return { family: fam, source: "google", kind: kindOf(fam) ?? kindHint, asked: raw, note: `${titleCase(raw)} is a licensed font, so it's set in ${fam}, the closest open match.` };
  }
  const cand = titleCase(raw);
  if (cand && FAMILY_RE.test(cand) && unknownOnGoogle(cand)) return { family: cand, source: "google", kind: kindHint, asked: raw, note: null };
  const fb = DEFAULT_FONTS[kindHint];
  return { ...fb, asked: raw, note: raw ? `${titleCase(raw)} isn't one I can load, so it's set in ${fb.family}.` : null };
}

// Whether Google Fonts serves a family (checked once per name, cached). Network: a reply path only, never layer 1.
const googleCache = new Map<string, boolean>();
export async function googleHas(family: string): Promise<boolean> {
  if (!FAMILY_RE.test(family)) return false;
  if (known(family)) return true;
  if (googleCache.has(family)) return googleCache.get(family)!;
  try {
    const r = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}&display=swap`, { signal: AbortSignal.timeout(4000) });
    googleCache.set(family, r.ok);
    return r.ok;
  } catch {
    return false;
  }
}

// Resolves with Google consulted for names Co doesn't know.
export async function resolveFontOnline(asked: string, kindHint: "serif" | "sans" = "sans"): Promise<FontResolution> {
  const offline = resolveFont(asked, kindHint);
  if (!offline.note || COMMERCIAL_TO_OPEN.some(([k]) => offline.asked.toLowerCase().startsWith(k))) return offline;
  const cand = titleCase(offline.asked);
  return (await googleHas(cand)) ? resolveFont(asked, kindHint, () => true) : offline;
}

// Pure: is this a font choice Co may put in CSS (the stored form, re-checked on every load).
export function validFont(f: unknown): f is FontChoice {
  const x = f as FontChoice;
  return !!x && typeof x === "object" && typeof x.family === "string" && FAMILY_RE.test(x.family) && (x.source === "google" || x.source === "fontshare") && (x.kind === "serif" || x.kind === "sans");
}

// Google answers an error for the whole request when a family lacks a weight asked of it, so each family is its own link and asks
// only for weights it has: single-weight display faces none, faces with a light cut 300, 400 and 700, the rest 400 and 700.
const SINGLE_WEIGHT = new Set(["Anton", "Bebas Neue", "Archivo Black", "DM Serif Display", "DM Serif Text", "Instrument Serif", "Young Serif", "Gilda Display", "Marcellus", "Libre Caslon Display"]);
const HAS_LIGHT = new Set(["Fraunces", "Cormorant Garamond", "Cormorant", "Inter", "Inter Tight", "DM Sans", "Manrope", "Figtree", "Plus Jakarta Sans", "Space Grotesk", "Work Sans", "Montserrat", "Jost", "Josefin Sans", "Nunito Sans", "Lato", "Open Sans", "Poppins", "Raleway", "Outfit", "Sora", "Urbanist", "Hanken Grotesk", "Onest", "Geist", "Karla", "Rubik", "Red Hat Display", "Crimson Pro", "Newsreader", "Source Serif 4", "Spectral", "Merriweather", "IBM Plex Sans", "IBM Plex Serif", "Libre Franklin", "Barlow", "Source Sans 3", "Bricolage Grotesque", "Archivo", "Roboto Slab", "Zilla Slab", "Big Shoulders Display", "Unbounded", "Oswald", "Noto Serif"]);
// Pure: the stylesheet links for these fonts.
export function fontLinks(fonts: FontChoice[]): string[] {
  const uniq = [...new Map(fonts.filter(validFont).map((f) => [`${f.source}:${f.family}`, f])).values()];
  const out: string[] = [];
  for (const f of uniq.filter((x) => x.source === "google")) {
    const known = !!kindOf(f.family);
    const w = SINGLE_WEIGHT.has(f.family) || !known ? "" : HAS_LIGHT.has(f.family) ? ":wght@300;400;700" : ":wght@400;700";
    out.push(`https://fonts.googleapis.com/css2?family=${f.family.replace(/ /g, "+")}${w}&display=swap`);
  }
  const fs = uniq.filter((x) => x.source === "fontshare");
  if (fs.length) out.push(`https://api.fontshare.com/v2/css?${fs.map((f) => `f[]=${f.family.toLowerCase().replace(/ /g, "-")}@300,400,500,700`).join("&")}&display=swap`);
  return out;
}

// Pure: the CSS font-family stack for a choice.
export function fontStack(f: FontChoice): string {
  const tail = f.kind === "serif" ? "Georgia, 'Times New Roman', serif" : "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";
  return `'${f.family}', ${tail}`;
}
