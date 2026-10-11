// Where a page's images come from (Royce, 2026-10-11): "every image on a page belongs to the thing being recommended: the venue's
// site, the listing, the event page. No stock photos, ever." When a page is made, each section without an image gets one from its own
// entities, in this order:
//   1. the og:image on the entity's own page (the site's own chosen image, read from its meta tags);
//   2. the og:image of a source the page already cites for that entity (a source whose label names it);
//   3. no image. "A section with no image beats a section with a fake one."
// Fetched once, when the page is made (attachImages), never on render: the image's URL is stored with the page it came from
// (schema.ts Photo.sourceUrl), and the template only reads what's stored. The model never supplies an image URL.
//
// Every fetch goes through linkReader.ts safeFetch (no private addresses, every redirect hop checked, time and size capped).
import type { CoPageData, Photo, Section } from "./schema.js";
import { sectionEntities } from "./schema.js";

export const OG_LIMITS = { entitiesPerSection: 2, sourcesPerEntity: 1, budgetMs: 9000, url: 500 } as const;

const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// Pure: the page's own chosen image, from its meta tags (og:image:secure_url, og:image, og:image:url, twitter:image), as an absolute
// https URL, or null. Relative paths resolve against the page's final address; anything not plain https is refused.
export function ogImageFrom(html: string, pageUrl: string): string | null {
  const head = html.slice(0, 300_000);
  const wanted = ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"];
  const found = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(ATTR("property")) ?? tag.match(ATTR("name")))?.slice(2).find((x) => x !== undefined)?.toLowerCase();
    const val = tag.match(ATTR("content"))?.slice(2).find((x) => x !== undefined);
    if (key && val && wanted.includes(key) && !found.has(key)) found.set(key, decode(val.trim()));
  }
  for (const k of wanted) {
    const v = found.get(k);
    if (!v) continue;
    try {
      const u = new URL(v, pageUrl);
      if (u.protocol === "http:" && u.hostname) u.protocol = "https:";
      if (u.protocol !== "https:" || u.username || u.password) continue;
      const s = u.toString();
      if (s.length > OG_LIMITS.url || /["'<>\s\\]/.test(s)) continue;
      return s;
    } catch {
      continue;
    }
  }
  return null;
}

export type OgDeps = { fetchPage: (url: string) => Promise<{ html: string; finalUrl: string } | null>; now: () => number };
export const realOgDeps: OgDeps = {
  fetchPage: async (url) => {
    const { safeFetch } = await import("../linkReader.js");
    const r = await safeFetch(url);
    if ("error" in r || r.status >= 400 || !/html/i.test(r.contentType)) return null;
    return { html: r.body, finalUrl: r.finalUrl };
  },
  now: () => Date.now(),
};

// The image for one entity: its own page first, then a cited source that names it. Null when neither has one.
export async function imageForEntity(entity: { name: string; url: string }, sources: { label: string; url: string }[], deps: OgDeps = realOgDeps): Promise<Photo | null> {
  const tryPage = async (url: string): Promise<Photo | null> => {
    const page = await deps.fetchPage(url).catch(() => null);
    if (!page) return null;
    const img = ogImageFrom(page.html, page.finalUrl);
    return img ? { url: img, alt: `${entity.name}, from its own page`.slice(0, 140), sourceUrl: url } : null;
  };
  const own = await tryPage(entity.url);
  if (own) return own;
  const named = entity.name.toLowerCase();
  const cited = sources.filter((s) => s.url !== entity.url && s.label.toLowerCase().includes(named)).slice(0, OG_LIMITS.sourcesPerEntity);
  for (const s of cited) {
    const p = await tryPage(s.url);
    if (p) return { ...p, alt: `${entity.name}, from ${s.label}`.slice(0, 140) };
  }
  return null;
}

// Once, when the page is made: every section without an image tries its first entities, inside one time budget. Sections run in
// parallel; a section whose entities have no image stays without one. Returns the page with images filled in, and what happened.
export async function attachImages(data: CoPageData, deps: OgDeps = realOgDeps): Promise<{ data: CoPageData; found: number; tried: number }> {
  const start = deps.now();
  let tried = 0;
  const sections: Section[] = await Promise.all(
    data.sections.map(async (s) => {
      if (s.image) return s;
      for (const ent of sectionEntities(s).slice(0, OG_LIMITS.entitiesPerSection)) {
        if (deps.now() - start > OG_LIMITS.budgetMs) break;
        tried++;
        const img = await imageForEntity(ent, data.sources, deps).catch(() => null);
        if (img) return { ...s, image: img };
      }
      return s;
    }),
  );
  return { data: { ...data, sections }, found: sections.filter((s, i) => s.image && !data.sections[i].image).length, tried };
}
