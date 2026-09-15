// Prints embedding similarity for every ask case, to set SAME_ASK_HIGH/LOW.
//   npx tsx evals/profile/sims.ts
import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { loadCases } from "../lib.js";
import { cosineSimilarity } from "../../src/harness/profileWrite.js";
import { generateEmbedding } from "../../src/services/embeddings.js";

const dir = dirname(fileURLToPath(import.meta.url));
const cases = loadCases<any>(dir).filter((c) => c.kind === "ask");
for (const c of cases) {
  const n = await generateEmbedding(c.newAsk);
  const sims = await Promise.all(c.openAsks.map(async (t: string) => cosineSimilarity(n, await generateEmbedding(t))));
  console.log(`${c.id} same=${c.expect.same} best=${Math.max(...sims).toFixed(3)}`);
}
