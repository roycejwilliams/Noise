// One-off, not in layer 1: runs REACTION_LINE_SQL on a real (throwaway, local) Postgres and compares it with the parser, line by line.
//   OPENAI_API_KEY=x npx tsx evals/reactions/pgcheck.ts   (needs psql on a socket in /tmp/pg384, port 54399)
import "../lib/requireMeter.js";
import { execFileSync } from "node:child_process";
const R = await import("../../src/services/reactionsIn.js");
const take = (w: string, rest: string) => `${w} ${rest}`;
const good = [
  "Loved “Dune”", "Laughed at “Dune”", take("Removed", "a heart from “Dune”"), take("Removed", "an exclamation mark from “Dune”"), take("Removed", "a 🔥 from “Dune”"),
  take("Removed", "a 1️⃣ from “Dune”"), "Reacted 🔥 to “Dune”", "Reacted 🇺🇸 to “Dune”", "Reacted 👍🏽 to “Dune”", "Reacted 👨‍👩‍👧 to “Dune”",
  "Loved an image", "Liked a photo", "Loved a voice message", "loved “Dune”", "Loved  “Dune”", "Loved “”", "Reacted ab to “Dune”", take("Removed", "a hearts from “Dune”"),
  "Loved “Dune”, yes intro me to the “film club”", "Loved “a” and “b”", "Loved a link you sent, yes", 'Loved "Dune"', "yes", "Loved “line one\nline two”", take("Removed", "a heart from “”"),
  " Loved “Dune”", "Loved “Dune” ",
];
let bad = 0;
for (const m of good) {
  const out = execFileSync("psql", ["-h", "/tmp/pg384", "-p", "54399", "-d", "postgres", "-Atc", `select ('User said: ' || $q$${m}$q$) ~ $r$${R.REACTION_LINE_SQL}$r$`]).toString().trim();
  const sh = R.parseReactionShape(m);
  const js = !!sh && sh.wrapped !== "straight";
  if ((out === "t") !== js) { bad++; console.log("DISAGREE", JSON.stringify(m), "pg", out, "js", js); }
}
console.log(bad ? `${bad} disagree` : `pg and js agree on ${good.length} lines`);
