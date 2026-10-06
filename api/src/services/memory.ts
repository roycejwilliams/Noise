import pool from "../db/db.js";
import { generateEmbedding } from "./embeddings.js";
import { isPrivateTurn } from "./privateTurn.js";

// Insert-then-embed pattern for co_memories, extracted from the inline
// version in routes/co.ts (sendMissedCallFollowUp) for reuse by the ask-checkin
// agent (agent/askCheckin.ts). Embedding failure is non-fatal — same as every
// other best-effort profile/memory write in this codebase — since the memory
// row itself is what matters; the embedding only feeds later semantic search.
// The embedder, replaceable so a test can see whether a memory was embedded.
export const embedder = { generate: generateEmbedding };

export async function writeMemory(
  userId: string,
  memoryType: string,
  content: string,
  opts: { private?: boolean } = {},
): Promise<void> {
  // Written during a turn that touched a document: private, and never embedded (services/privateTurn.ts).
  const isPrivate = opts.private ?? isPrivateTurn(userId);
  const mem = await pool.query(
    `INSERT INTO co_memories (user_id, memory_type, content, private) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, memoryType, content, isPrivate],
  );
  if (isPrivate) return;
  embedder.generate(content)
    .then((emb) =>
      pool.query(
        `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
        [`[${emb.join(",")}]`, mem.rows[0].id],
      ),
    )
    .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
}
