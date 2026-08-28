// The text channel used a separate, thinner persona ("You are Co, an
// exclusive life concierge") than the real Hume EVI call does — this fetches
// the actual system prompt Co's voice config uses, so a text conversation is
// genuinely the same entity as the one on a call: same listening style, same
// phase-driven attention, same psychological principles, able to pick up a
// real back-and-forth rather than reading like a different, simpler bot.
//
// Fetched once and cached for the life of the process rather than on every
// message — this avoids adding a Hume round-trip to the latency of every
// text reply.
let cachedPrompt: string | null = null;
let fetchPromise: Promise<string | null> | null = null;

// The raw prompt returned by getCoPersonaPrompt() below still contains
// {{first_name}}/{{context_summary}} template tokens — Hume substitutes
// those itself at call time (see mediaStreamBridge.ts's `variables`), but
// nothing does that for this text-channel reuse. Left unfilled, the model is
// literally told "here's the context_summary: {{context_summary}}" and,
// correctly, reports it doesn't have one instead of writing real output —
// confirmed live (a post-call follow-up text leaked exactly that reasoning
// to a real user). Always render through this before handing the prompt to
// a model; never pass getCoPersonaPrompt()'s raw text to one directly.
export async function renderCoPersonaPrompt(
  firstName: string,
  contextSummary: string,
): Promise<string | null> {
  const raw = await getCoPersonaPrompt();
  if (!raw) return raw;
  return raw
    .replace(/\{\{first_name\}\}/g, firstName)
    .replace(/\{\{context_summary\}\}/g, contextSummary);
}

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
