// Live: is the second reader (services/factCheck.ts) good enough to drop facts?
// Labeled cases built from a real Peerspace list page, read in the browser:
// each card's own price, capacity and area (true), the NEXT card's price or
// area under this card's name (false: the misattribution the code check can't
// see, since both cards sit in one passage), and claims the page never makes
// (false: available on their date, allows outside DJs). Jev and Haiku each read
// every case. Turn SEARCH_FACT_CHECK on only if the reader catches most false
// facts and drops almost no true ones. Under $0.10.
//
//   railway run npx tsx evals/search/factCheck.ts
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const { browserPageText, closeBrowser } = await import("../../src/services/browserRead.js");
const { nearName, singleItemUrl } = await import("../../src/services/taskWeb.js");
const F = await import("../../src/services/factCheck.js");
const { askJevZdr, gatewayConfigured } = await import("../../src/services/jevGateway.js");

type Card = { name: string; area: string; guests: string; price: string };
export function parseCards(text: string): Card[] {
  const cards: Card[] = [];
  for (const chunk of text.split(/\n\s*\d+ hr min\s*\n/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    const g = lines.findIndex((l) => /^\d+ guests$/.test(l));
    const p = lines.findLastIndex((l) => /^\$\d[\d,]*$/.test(l));
    if (g < 2 || p < 0) continue;
    const areaAt = lines.slice(0, g).findLastIndex((l) => /, [A-Z]{2}$/.test(l));
    if (areaAt < 1) continue;
    cards.push({ name: lines[areaAt - 1], area: lines[areaAt].replace(/, [A-Z]{2}$/, ""), guests: lines[g], price: lines[p] });
  }
  return cards;
}

const pages = ["https://www.peerspace.com/venues/san-francisco--ca/photo-studio", "https://www.peerspace.com/venues/oakland--ca/photo-studio"];
type Case = { thing: string; fact: string; passage: string; truth: boolean; kind: string };
const cases: Case[] = [];
for (const url of pages) {
  const text = await browserPageText(url);
  if (!text) {
    console.log(`couldn't read ${url}`);
    continue;
  }
  const cards = parseCards(text).slice(0, 7);
  console.log(`${url}: ${cards.length} cards`);
  // As production reads it: a list page needs the fact next to the name.
  const add = (thing: string, fact: string, truth: boolean, kind: string) => cases.push({ thing, fact, passage: nearName(thing, fact, text, !singleItemUrl(url)).excerpt, truth, kind });
  cards.forEach((c, i) => {
    const next = cards[(i + 1) % cards.length];
    add(c.name, `price: from ${c.price}/hr`, true, "own price");
    add(c.name, `capacity: ${c.guests}`, true, "own capacity");
    add(c.name, `neighborhood: ${c.area}`, true, "own area");
    if (next.price !== c.price) add(c.name, `price: from ${next.price}/hr`, false, "next card's price");
    if (next.area !== c.area) add(c.name, `neighborhood: ${next.area}`, false, "next card's area");
    if (i % 2 === 0) add(c.name, "available on Saturday, October 10", false, "claim not on page");
    else add(c.name, "allows outside DJs and live music", false, "claim not on page");
  });
}
// A second layout: The Bash's DJ cards (name, reviews, bookings, "DJ FROM city", "STARTING AT $X").
{
  const url = "https://www.thebash.com/services/dj";
  const text = await browserPageText(url);
  const cards: { name: string; from: string; price: string | null }[] = [];
  if (text) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    lines.forEach((l, i) => {
      if (!/^\d+REVIEWS?$/.test(l) || i < 1) return;
      const end = lines.findIndex((x, k) => k > i && /^\d+REVIEWS?$/.test(x));
      const card = lines.slice(i, end > 0 ? end - 1 : i + 14);
      const from = card.find((x) => /^(DJ|.*) FROM [A-Z ]+, [A-Z]{2}$/.test(x))?.replace(/^.* FROM /, "");
      const at = card.findIndex((x) => x === "STARTING AT");
      if (from) cards.push({ name: lines[i - 1], from, price: at >= 0 ? card[at + 1] : null });
    });
    console.log(`${url}: ${cards.length} cards`);
    const priced = cards.filter((c) => c.price).slice(0, 6);
    const add = (thing: string, fact: string, truth: boolean, kind: string) => cases.push({ thing, fact, passage: nearName(thing, fact, text, !singleItemUrl(url)).excerpt, truth, kind: `bash ${kind}` });
    priced.forEach((c, i) => {
      const next = priced[(i + 1) % priced.length];
      add(c.name, `price: starting at ${c.price}`, true, "own price");
      add(c.name, `based in: ${c.from}`, true, "own city");
      if (next.price !== c.price) add(c.name, `price: starting at ${next.price}`, false, "next card's price");
      if (next.from !== c.from) add(c.name, `based in: ${next.from}`, false, "next card's city");
      add(c.name, "available on Saturday, October 10", false, "claim not on page");
    });
  }
}
// A single listing's own page: the price sits far below the name.
{
  const url = "https://www.peerspace.com/pages/listings/69383e05227dfd74f5b9f577";
  const text = await browserPageText(url);
  const lines = text?.split("\n").map((l) => l.trim()).filter(Boolean) ?? [];
  const name = lines[lines.findIndex((l) => l === "Save") + 1] ?? null;
  const rate = text?.match(/\$(\d+)\/hr/)?.[1];
  const min = text?.match(/(\d+) hr minimum/)?.[1];
  if (text && name && rate) {
    console.log(`${url}: "${name}" $${rate}/hr${min ? `, ${min} hr minimum` : ""}`);
    const add = (fact: string, truth: boolean, kind: string) => cases.push({ thing: name, fact, passage: nearName(name, fact, text, false).excerpt, truth, kind: `own page ${kind}` });
    add(`price: $${rate}/hr`, true, "price");
    if (min) add(`minimum: ${min} hr minimum`, true, "minimum");
    add(`price: $${Number(rate) * 2 + 5}/hr`, false, "wrong price");
    add("available on Saturday, October 10", false, "claim not on page");
    add("capacity: 400 standing", false, "claim not on page");
  } else console.log(`couldn't read ${url}`);
}
await closeBrowser();
console.log(`${cases.length} cases (${cases.filter((c) => c.truth).length} true, ${cases.filter((c) => !c.truth).length} false); Jev ${gatewayConfigured() ? "configured" : "NOT configured"}\n`);

const items = cases.map(({ thing, fact, passage }) => ({ thing, fact, passage }));
const t0 = Date.now();
const jev = await F.checkFacts(items, { jev: askJevZdr, haiku: async () => "{}" });
const jevMs = Date.now() - t0;
const t1 = Date.now();
const haiku = await F.checkFacts(items, { jev: async () => null });
const haikuMs = Date.now() - t1;

function score(name: string, r: { verdicts: F.Verdict[]; by: string[] }, ms: number) {
  const answered = r.verdicts.filter((v) => v !== "unclear").length;
  const falseCaught = cases.filter((c, i) => !c.truth && r.verdicts[i] === "no").length;
  const falseTotal = cases.filter((c) => !c.truth).length;
  const trueDropped = cases.filter((c, i) => c.truth && r.verdicts[i] === "no").length;
  const trueTotal = cases.filter((c) => c.truth).length;
  console.log(`${name} (${r.by.join("/")}, ${ms}ms): answered ${answered}/${cases.length}; caught ${falseCaught}/${falseTotal} false facts; wrongly dropped ${trueDropped}/${trueTotal} true facts`);
  for (const kind of [...new Set(cases.map((c) => c.kind))]) {
    const idx = cases.map((c, i) => (c.kind === kind ? i : -1)).filter((i) => i >= 0);
    const right = idx.filter((i) => (cases[i].truth ? r.verdicts[i] === "yes" : r.verdicts[i] === "no")).length;
    const unclear = idx.filter((i) => r.verdicts[i] === "unclear").length;
    console.log(`   ${kind}: ${right}/${idx.length} right${unclear ? `, ${unclear} unclear` : ""}`);
  }
  return { falseCaught, falseTotal, trueDropped, trueTotal, answered };
}
const j = score("Jev", jev, jevMs);
const h = score("Haiku", haiku, haikuMs);
for (const [i, c] of cases.entries()) if ((c.truth && (jev.verdicts[i] === "no" || haiku.verdicts[i] === "no")) || (!c.truth && jev.verdicts[i] !== "no" && haiku.verdicts[i] !== "no")) console.log(`  miss: [${c.truth ? "true" : "false"}] ${c.thing} — ${c.fact}: jev ${jev.verdicts[i]}, haiku ${haiku.verdicts[i]}`);
const good = (s: typeof j) => s.answered >= cases.length * 0.8 && s.falseCaught >= s.falseTotal * 0.8 && s.trueDropped <= Math.max(1, s.trueTotal * 0.05);
console.log(`\nready to turn on: Jev ${good(j) ? "yes" : "no"}, Haiku ${good(h) ? "yes" : "no"}`);
