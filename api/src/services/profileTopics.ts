// The topics Co tries to understand about a person, and what each means.
// Dependency-free (services/understanding.ts and model-free checks read it);
// profileExtraction.ts re-exports it.
export const RAPPORT_TOPICS = [
  "current_situation",
  "major_transition",
  "goals_challenges",
  "looking_for",
  "people_to_meet",
  "ways_to_help",
  "personality",
  "location_availability",
  "boundaries_preferences",
  "long_term_direction",
] as const;

export type RapportTopic = (typeof RAPPORT_TOPICS)[number];

// Single source of truth for what each topic actually means — used both to
// build assessConversationCoverage's prompt below and, for the text channel
// (webhooks.ts), to tell the reply-generation model in plain language what a
// missing_topics key is actually asking about.
export const RAPPORT_TOPIC_DESCRIPTIONS: Record<RapportTopic, string> = {
  current_situation: "what's going on in their life right now",
  major_transition: "the bigger context or change they're in the middle of",
  goals_challenges: "what they're working toward or struggling with",
  looking_for: "what kind of connection or outcome they want from this",
  people_to_meet: "the kind of people they'd want to be introduced to",
  ways_to_help: "what they could offer or help others with",
  personality: "some sense of their personality or how they come across",
  location_availability: "where they are and when they're free",
  boundaries_preferences: "any stated boundaries or preferences",
  long_term_direction:
    "their longer-horizon personal and career direction — where they want to be in a few years, distinct from what's urgent right now",
};
