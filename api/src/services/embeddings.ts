import "dotenv/config";
import OpenAI from "openai";

// OpenAI is used specifically for embeddings — Anthropic doesn't have an embeddings API
// text-embedding-3-small produces 1536-dimension vectors, matching our co_profiles schema
// Cost: ~$0.02 per million tokens — essentially free at our scale
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Converts any text string into a 1536-dimension vector
// The vector represents the semantic meaning of the text in mathematical space
// Similar meanings produce similar vectors — this is what enables goal comparison
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small", // 1536 dimensions, fast, cheap
    input: text,
  });

  // The embedding is an array of 1536 floats between -1 and 1
  return response.data[0].embedding;
}

// Converts a user's goals array into a single embedding
// We join goals into one string so the model understands them as a whole
// Example: ["build a startup", "find community"] → "build a startup. find community"
// This combined embedding is stored in co_profiles.goal_embeddings
// and used during matching to score goal alignment between users
export async function generateGoalEmbedding(
  goals: string[],
): Promise<number[]> {
  // Join all goals into a single coherent sentence for better embedding quality
  const text = goals.join(". ");
  return generateEmbedding(text);
}
