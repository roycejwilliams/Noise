// Co pages (Royce, 2026-10-11): one document format, rendered by one template, with images only from the things the page is about.
// Zero tokens, no network: pages are stubbed.
//   npx tsx evals/coPages/document.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const S = await import("../../src/services/coPages/schema.js");
const T = await import("../../src/services/coPages/template.js");
const O = await import("../../src/services/coPages/ogImage.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

const base = () => ({
  title: "Saturday night in the Mission",
  context: "Saturday, Oct 24 · Mission District, SF · for Jordan",
  cover: null,
  sections: [
    { heading: "The shape of the night", image: null, blocks: [{ type: "bullets", items: [{ lead: "7:00 PM", text: "Dinner at Alder & Ash" }] }] },
    { heading: "Where to eat", image: null, blocks: [{ type: "comparison", options: [
      { name: "Alder & Ash", facts: [{ label: "Price", value: "About $85" }], note: null, url: "https://alderandash.example/" },
      { name: "Mesa Verde", facts: [{ label: "Price", value: "About $60" }], note: null, url: "https://mesaverde.example/" },
    ] }] },
    { heading: "A drink nearby", image: null, blocks: [{ type: "links", items: [{ name: "Fern Bar", note: "Natural wine", url: "https://fernbar.example/", group: "Quiet" }] }] },
  ],
  sources: [{ label: "Fern Bar on the city guide", url: "https://cityguide.example/fern-bar" }],
});

// ---------------------------------------------------------------- the format
{
  const p = S.parseCoPageData(base());
  check("a page is a title, a context line, sections of blocks, and sources", p.ok);
  const bad = (mut: (d: any) => void) => { const d: any = base(); mut(d); const r = S.parseCoPageData(d); return r.ok ? [] : r.problems; };
  check("no HTML, markdown, links in text, em dashes or exclamation points", [
    bad((d) => (d.title = "<b>Night</b>")), bad((d) => (d.context = "**bold**")), bad((d) => (d.sections[0].heading = "See https://x.example")),
    bad((d) => (d.title = "A night — out")), bad((d) => (d.title = "Big night!")),
  ].every((x) => x.length > 0));
  check("unknown fields are refused, not dropped", bad((d) => (d.extra = 1)).some((x) => /unknown field extra/.test(x)));
  check("a comparison needs two to four options with the same facts in the same order", bad((d) => (d.sections[1].blocks[0].options[1].facts = [{ label: "Feel", value: "Lively" }])).some((x) => /same facts/.test(x)) && bad((d) => (d.sections[1].blocks[0].options = [d.sections[1].blocks[0].options[0]])).length > 0);
  check("links are plain https only", bad((d) => (d.sections[2].blocks[0].items[0].url = "javascript:alert(1)")).length > 0 && bad((d) => (d.sources[0].url = "http://x.example/a b")).length > 0);
}

// ---------------------------------------------------------------- images belong to what the page is about
{
  const withImg = (sectionIndex: number, sourceUrl: string) => { const d: any = base(); d.sections[sectionIndex].image = { url: "https://img.example/a.jpg", alt: "x", sourceUrl }; return S.parseCoPageData(d); };
  check("a section's image from one of its own entities is accepted", withImg(1, "https://alderandash.example/").ok);
  check("a section's image from a source the page cites is accepted", withImg(2, "https://cityguide.example/fern-bar").ok);
  const stock = withImg(1, "https://unsplash.com/photos/abc");
  check("an image from anywhere else (stock) is refused", !stock.ok && /must come from one of that section's own links or a cited source/.test((stock as any).problems.join()));
  const d: any = base(); d.cover = { url: "https://img.example/c.jpg", alt: "x", sourceUrl: "https://stock.example/x" };
  check("the cover must come from something on the page too", !S.parseCoPageData(d).ok);
}

// ---------------------------------------------------------------- og:image, read once when the page is made
{
  check("the page's own og:image, in either attribute order and quote style", O.ogImageFrom(`<meta property="og:image" content="https://cdn.example/a.jpg">`, "https://x.example/") === "https://cdn.example/a.jpg" && O.ogImageFrom(`<meta content='/img/b.jpg' property='og:image'>`, "https://x.example/page") === "https://x.example/img/b.jpg");
  check("secure_url wins; twitter:image is the last resort", O.ogImageFrom(`<meta name="twitter:image" content="https://t.example/t.jpg"><meta property="og:image" content="https://o.example/o.jpg"><meta property="og:image:secure_url" content="https://s.example/s.jpg">`, "https://x.example/") === "https://s.example/s.jpg" && O.ogImageFrom(`<meta name="twitter:image" content="https://t.example/t.jpg">`, "https://x.example/") === "https://t.example/t.jpg");
  check("no tag, or a non-https or odd value, is no image", O.ogImageFrom("<html></html>", "https://x.example/") === null && O.ogImageFrom(`<meta property="og:image" content="javascript:alert(1)">`, "https://x.example/") === null && O.ogImageFrom(`<meta property="og:image" content="data:image/png;base64,AAA">`, "https://x.example/") === null);
  check("an http image is upgraded to https", O.ogImageFrom(`<meta property="og:image" content="http://cdn.example/a.jpg">`, "https://x.example/") === "https://cdn.example/a.jpg");

  const pages: Record<string, string> = {
    "https://alderandash.example/": `<meta property="og:image" content="https://alderandash.example/hero.jpg">`,
    "https://mesaverde.example/": `<html>no image</html>`,
    "https://fernbar.example/": `<html>no image</html>`,
    "https://cityguide.example/fern-bar": `<meta property="og:image" content="https://cityguide.example/fern.jpg">`,
  };
  const fetched: string[] = [];
  const deps = { fetchPage: async (u: string) => { fetched.push(u); return pages[u] !== undefined ? { html: pages[u], finalUrl: u } : null; }, now: () => 0 };
  const r = await O.attachImages(S.parseCoPageData(base()).ok ? (S.parseCoPageData(base()) as any).data : null, deps);
  const [s0, s1, s2] = r.data.sections;
  check("1. the entity's own page first", s1.image?.url === "https://alderandash.example/hero.jpg" && s1.image?.sourceUrl === "https://alderandash.example/");
  check("2. then a source the page cites for that entity (its label names it)", s2.image?.url === "https://cityguide.example/fern.jpg" && s2.image?.sourceUrl === "https://cityguide.example/fern-bar");
  check("3. then no image: a section with no entity gets none (never a stand-in)", s0.image === null);
  check("what attachImages fills always passes the schema's ownership rule", S.parseCoPageData({ ...r.data }).ok, S.parseCoPageData({ ...r.data }));
  const none = await O.attachImages({ ...(S.parseCoPageData(base()) as any).data, sources: [] }, { fetchPage: async () => ({ html: "<html></html>", finalUrl: "https://x.example/" }), now: () => 0 });
  check("no og:image anywhere: every section stays without one", none.found === 0 && none.data.sections.every((s: any) => s.image === null));
  check("rendering never fetches: the template only reads what's stored", !/\bfetch\(|safeFetch|fetchPage|attachImages|ogImage\.js/.test((await import("node:fs")).readFileSync(new URL("../../src/services/coPages/template.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "")));
}

// ---------------------------------------------------------------- the template
{
  const p = (S.parseCoPageData({ ...base(), title: "<script>x</script> night" }) as any);
  check("a title with markup is refused before it can render", !p.ok);
  const d: any = (S.parseCoPageData(base()) as any).data;
  d.sections[1].image = { url: "https://alderandash.example/hero.jpg", alt: "Alder & Ash, from its own page", sourceUrl: "https://alderandash.example/" };
  const html = T.renderCoPage({ id: "x".repeat(24), data: d, version: 1, updatedAt: new Date("2026-10-11T19:00:00Z") }, { url: "https://co.example/d/x", ogImageUrl: "https://co.example/d/og.png", zone: "America/Los_Angeles" });
  check("OG tags so the link unfurls; noindex", /property="og:title" content="Saturday night in the Mission"/.test(html) && /property="og:image"/.test(html) && /name="robots" content="noindex, nofollow"/.test(html));
  check("no nav, no buttons, no forms, no scripts", !/<nav|<button|<form|<script/i.test(html));
  check("an image says where it's from", /<figcaption>From alderandash\.example<\/figcaption>/.test(html));
  check("the quiet footer: Made by Co and the as-of date", /<div class="sign">Made by Co<\/div>/.test(html) && /As of Oct 11, 2026/.test(html));
  check("Alder &amp; Ash is escaped, never raw", /Alder &amp; Ash/.test(html) && !/>Alder & Ash</.test(html));
}

console.log(`co pages: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
