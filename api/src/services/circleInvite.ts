import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

// Shared by every real path that sends a member their circle-invite text —
// the initial Moderator-approval invite and the decline-triggered replacement
// invite in routes/sendblue.ts, and co-test's real-test-user-vs-filler-pool
// feature (dynamicPlacementTest.ts). One implementation so all three stay
// identical instead of drifting — this IS how Co talks to real users, not
// a test-only variant of it.

// Returns "{title} {description}" — a short punchy name followed by a
// one-line description of the circle's shared vibe, grounded in the
// recipient's own real goals where available (private context the model is
// told to allude to, not quote directly — same rule as
// generateWarmCircleInviteMessage below). A bare name alone read as generic
// and interchangeable across circles; the description is what actually
// makes it feel written for this person.
export async function generateCircleTitle(city: string, chapter: string, goals: string[] = []): Promise<string> {
  const privateContext = goals.length ? goals.slice(0, 2).join(" ") : `navigating ${chapter || "a new chapter"} in ${city}`;
  const fallback = `${chapter ? `Your ${chapter} circle` : "Your circle"} — a small group in ${city} who get it.`;

  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      prompt: `Give a short, warm, specific name (3-5 words, no quotes) for a small circle of people in ${city} all navigating "${chapter || "a new chapter"}", plus a one-sentence description of the circle's shared vibe (under 12 words, no quotes, no period at the end). Ground the description in this real context about who it's for, without quoting it directly: "${privateContext}". Not generic — this should feel written for this specific person, not a template.

Return ONLY valid JSON, nothing else:
{"title": "...", "description": "..."}`,
    });
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const title = String(parsed.title ?? "").trim();
    const description = String(parsed.description ?? "").trim();
    if (!title) return fallback;
    return description ? `${title} ${description}` : title;
  } catch (err) {
    console.error("Circle title generation failed, using fallback (non-fatal):", err);
    return fallback;
  }
}

// The invite should feel like Co personally noticed something about this
// specific person and is nudging them out of their comfort zone — never a
// literal explanation of the matching logic ("you were grouped because you
// both..."). Grounded in their own real goals (private context the model is
// told to allude to, not restate or cite as a reason), never headcount or
// other members' identities — this is their own thread, not a group
// announcement, same consent design as always.
export async function generateWarmCircleInviteMessage(params: {
  firstName: string;
  circleTitle: string;
  chapter: string;
  city: string;
  goals: string[];
}): Promise<string> {
  const { firstName, circleTitle, chapter, city, goals } = params;
  const privateContext = goals.length
    ? goals.slice(0, 2).join(" ")
    : `they're navigating ${chapter || "a new chapter"} in ${city}`;

  const fallback = `Hey, I found you a circle called ${circleTitle} — think it could be a good stretch for you. There's already a moment curated and waiting if you're in. Reply YES to join or NO to pass.`;

  try {
    const { text } = await generateText({
      model: anthropic("claude-sonnet-4-6"),
      prompt: `You are Co, texting ${firstName} on their own private thread — never a group announcement.

You found them a circle called "${circleTitle}" and there's already a moment curated and waiting if they're in.

Privately, here's something real you know about them from what they've actually told you: "${privateContext}". Let it inform the message the way a perceptive friend would — like this made you think of them — but do NOT explain the matching logic or state it as a reason. Never say anything like "because you both..." or "since you mentioned...". Don't quote their own words back at them directly either — just let it show you noticed them specifically, not a generic user.

Tone: warm, a little playful, gently nudging them out of their comfort zone because you have a real hunch about this, not a calculated reason. Reference this tone, do not copy it verbatim: "Hey, been thinking about what you mentioned, I think it's time you got out of your comfort zone a bit. Found some people I have a feeling you'd really click with."

Never mention how many people are in the circle or who they are. Ask them to reply YES to join or NO to pass. No exclamation points, no em dashes. 2-3 sentences.`,
    });
    return text;
  } catch (err) {
    console.error("Warm circle invite generation failed, using fallback (non-fatal):", err);
    return fallback;
  }
}
