// Zero-token helper for the browser-use pilot: list Peerspace listing URLs from a search page with the existing
// headless reader, so the test set is real listings. No model calls.
//   npx tsx evals/browserPilot/pickListings.ts "<peerspace search url>"
import "../lib/requireMeter.js";
const R = await import("../../src/services/browserRead.js");
const url = process.argv[2];
const text = await R.browserPageText(url);
const links = R.linksSeen(url).filter((l) => /peerspace\.com\/pages\/listings\//.test(l.href));
console.log(JSON.stringify({ chars: text?.length ?? 0, listings: [...new Map(links.map((l) => [l.href.split("?")[0], l.text.replace(/\s+/g, " ").slice(0, 90)])).entries()].slice(0, 30) }, null, 1));
await R.closeBrowser();
