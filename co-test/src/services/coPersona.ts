// The text channel used a separate, thinner persona ("You are Co, an
// exclusive life concierge") than the real Hume EVI call does — this fetches
// the actual system prompt Co's voice config uses, so a text conversation is
// genuinely the same entity as the one on a call: same listening style, same
// phase-driven attention, same psychological principles, able to pick up a
// real back-and-forth rather than reading like a different, simpler bot.
//
// Fetched once and cached for the life of the process rather than on every
// message — co-test restarts on every deploy anyway, and this avoids adding
// a Hume round-trip to the latency of every text reply.
let cachedPrompt: string | null = null;
let fetchPromise: Promise<string | null> | null = null;

export async function getCoPersonaPrompt(): Promise<string | null> {
  if (cachedPrompt) return cachedPrompt;
  if (!fetchPromise) {
    fetchPromise = (async () => {
      try {
        const res = await fetch(
          `https://api.hume.ai/v0/evi/configs/${process.env.HUME_CONFIG_ID}?restrict_to_most_recent=true`,
          { headers: { "X-Hume-Api-Key": process.env.HUME_API_KEY! } },
        );
        if (!res.ok) throw new Error(`Hume config fetch failed: ${res.status}`);
        const data: any = await res.json();
        const text = data.configs_page?.[0]?.prompt?.text;
        if (typeof text !== "string" || !text) throw new Error("Hume config response had no prompt text");
        cachedPrompt = text;
        return text;
      } catch (err: any) {
        console.error(
          "coPersona: failed to fetch Hume EVI persona prompt for text channel (non-fatal, falling back to a thinner default):",
          err?.message ?? err,
        );
        return null;
      }
    })();
  }
  return fetchPromise;
}
