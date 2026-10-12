// A member's Pinterest board as taste (Royce, 2026-10-11, PR 5): "member sends a public Pinterest board link, Co reads it for taste
// signals. Public boards only; if a board needs login, say so instead of guessing."
//
// What a public board gives without signing in (checked 2026-10-11): its RSS feed (<board>.rss: the board's name, description and
// each pin's title), and the board page itself, whose data carries each pin's dominant color. A board Co can't read (secret, private,
// removed, or a link that isn't a board) has no feed: Pinterest answers "Board not found" there. That, and only that, is "can't open
// it": no guessing from the link's words. Every fetch goes through linkReader.ts safeFetch (public addresses only, every redirect hop
// checked, time and size capped).
export type BoardRead =
  | { readable: true; board: string; description: string | null; pins: string[]; colors: { hex: string; share: number }[]; tone: "light" | "dark" | "mixed" | null; url: string }
  | { readable: false; why: "not_a_board" | "needs_login_or_gone" | "unreachable" };

export type PinDeps = { fetch: (url: string) => Promise<{ finalUrl: string; status: number; body: string } | { error: string }> };
const realDeps: PinDeps = {
  fetch: async (url) => {
    const { safeFetch } = await import("./linkReader.js");
    return safeFetch(url);
  },
};

const PIN_HOST = /(^|\.)pinterest\.(com|ca|co\.uk|com\.au|fr|de|es|it|jp|com\.mx|ie|nz|pt|se|dk|at|ch|ru|cl|ph|kr)$/i;
// Paths under a Pinterest host that are never a board.
const NOT_BOARD = new Set(["pin", "search", "ideas", "today", "explore", "login", "signup", "business", "_", "settings", "categories", "topics"]);

// Pure: a link's board, as "user/board", or null when it isn't one.
export function boardPath(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!PIN_HOST.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || NOT_BOARD.has(parts[0].toLowerCase())) return null;
  const ok = (s: string) => /^[A-Za-z0-9_.-]{1,80}$/.test(s);
  return ok(parts[0]) && ok(parts[1]) && !/\.rss$/i.test(parts[1]) ? `${parts[0]}/${parts[1]}` : null;
}
export const isPinterestLink = (raw: string): boolean => {
  try {
    const h = new URL(raw.trim()).hostname;
    return PIN_HOST.test(h) || /^pin\.it$/i.test(h);
  } catch {
    return false;
  }
};

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

// Pure: the feed's board name, description and pin titles (up to 25), or null when it isn't a feed with pins.
export function parseBoardRss(xml: string): { board: string; description: string | null; pins: string[] } | null {
  const channel = xml.match(/<channel>([\s\S]*?)<item>/i)?.[1] ?? "";
  const board = decode(channel.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  if (!board || !items.length) return null;
  const description = decode(channel.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? "") || null;
  const pins = items
    .map((it) => decode(it.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "") || decode(it.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? "").slice(0, 120))
    .filter(Boolean)
    .slice(0, 25);
  return { board: board.slice(0, 120), description: description?.slice(0, 300) ?? null, pins };
}

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
// Pure: the board's palette from its pins' dominant colors: near colors merged (each channel to the nearest 32), the most common
// first with their share, and whether the board reads light or dark overall.
export function paletteFromPage(html: string): { colors: { hex: string; share: number }[]; tone: "light" | "dark" | "mixed" | null } {
  const all = [...html.matchAll(/"dominant_color":"(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase());
  if (!all.length) return { colors: [], tone: null };
  const bucket = (h: string) => `#${[1, 3, 5].map((i) => Math.min(255, Math.round(parseInt(h.slice(i, i + 2), 16) / 32) * 32).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  const counts = new Map<string, { n: number; sample: string }>();
  for (const h of all) {
    const b = bucket(h);
    const e = counts.get(b);
    counts.set(b, { n: (e?.n ?? 0) + 1, sample: e?.sample ?? h });
  }
  const colors = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 6).map((c) => ({ hex: c.sample, share: Math.round((c.n / all.length) * 100) / 100 }));
  const light = all.filter((h) => lum(h) > 0.5).length / all.length;
  return { colors, tone: light > 0.65 ? "light" : light < 0.35 ? "dark" : "mixed" };
}

export async function readBoard(raw: string, deps: PinDeps = realDeps): Promise<BoardRead> {
  let link = raw.trim();
  // A pin.it short link: follow it (safeFetch checks every hop) to where it points.
  if (/^https?:\/\/pin\.it\//i.test(link)) {
    const r = await deps.fetch(link).catch(() => ({ error: "unreachable" }));
    if ("error" in r) return { readable: false, why: "unreachable" };
    link = r.finalUrl;
  }
  const path = boardPath(link);
  if (!path) return { readable: false, why: "not_a_board" };
  const base = `https://www.pinterest.com/${path}`;
  const rss = await deps.fetch(`${base}.rss`).catch(() => ({ error: "unreachable" }));
  if ("error" in rss) return { readable: false, why: "unreachable" };
  const feed = rss.status === 200 ? parseBoardRss(rss.body) : null;
  if (!feed) return { readable: false, why: "needs_login_or_gone" };
  // The board page is large (about 1.4 MB, its pins' colors near the end): a slow or cut-short read is tried once more before the
  // look goes without colors (live run, PR 5: one read of the same board came back without them).
  const readPalette = async () => {
    const page = await deps.fetch(`${base}/`).catch(() => ({ error: "unreachable" }));
    return "error" in page || page.status !== 200 ? { colors: [] as { hex: string; share: number }[], tone: null } : paletteFromPage(page.body);
  };
  let palette = await readPalette();
  if (!palette.colors.length) palette = await readPalette();
  return { readable: true, ...feed, ...palette, url: `${base}/` };
}
