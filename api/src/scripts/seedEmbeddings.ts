import pool from "../db/db.js";
import { generateGoalEmbedding } from "../services/embeddings.js";

async function seedEmbeddings() {
  const profiles = await pool.query(
    `SELECT user_id, goals FROM co_profiles WHERE goal_embeddings IS NULL`,
  );

  for (const profile of profiles.rows) {
    if (!profile.goals || profile.goals.length === 0) continue;

    console.log(`Generating embedding for ${profile.user_id}...`);
    const embedding = await generateGoalEmbedding(profile.goals);

    await pool.query(
      `UPDATE co_profiles SET goal_embeddings = $1 WHERE user_id = $2`,
      [JSON.stringify(embedding), profile.user_id],
    );

    console.log(`Done.`);
  }

  console.log("All embeddings seeded.");
  process.exit(0);
}

seedEmbeddings();
