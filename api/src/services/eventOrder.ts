// Kept free of imports that need API keys, so the code evals can test it.
import type { EventDetails } from "./eventDetails.js";

// Pure: order scored events for offering. Open before sold out, then score.
export function orderForOffering<T extends { similarity: number; details?: EventDetails }>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const aSold = a.details?.soldOut === true ? 1 : 0;
    const bSold = b.details?.soldOut === true ? 1 : 0;
    return aSold - bSold || b.similarity - a.similarity;
  });
}
