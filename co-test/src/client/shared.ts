export type TranscriptMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  kind?: "start" | "end" | "tool";
};

// sessionStorage (not localStorage) is deliberate — scoped to this one
// browser tab, cleared when it closes, so a forgotten test override can
// never quietly bleed into a later, unrelated session. Read/written from
// both the prompt page and the call page, so it's the single source of
// truth for "which prompt is the next call actually going to use."
const PROMPT_OVERRIDE_KEY = "co_test_prompt_override";

export function getPromptOverride(): string | null {
  const value = sessionStorage.getItem(PROMPT_OVERRIDE_KEY);
  return value && value.trim() ? value : null;
}

export function setPromptOverride(text: string): void {
  sessionStorage.setItem(PROMPT_OVERRIDE_KEY, text);
}

export function clearPromptOverride(): void {
  sessionStorage.removeItem(PROMPT_OVERRIDE_KEY);
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

export const CARD_FIELDS: { key: string; label: string }[] = [
  { key: "life_chapters", label: "Life chapter" },
  { key: "city", label: "City" },
  { key: "social_energy", label: "Social energy" },
  { key: "connection_style", label: "Connection style" },
  { key: "goals", label: "Goals" },
  { key: "blockers", label: "Blockers" },
  { key: "emotional_state", label: "Emotional state" },
];

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  return String(v);
}

function buildSystemEntry(content: string, kind: "start" | "end" | "tool", timestamp: Date): HTMLElement {
  const icon = kind === "start" ? "✓" : kind === "end" ? "✕" : "⚙";
  const row = document.createElement("div");
  row.className = `transcript-entry transcript-system transcript-system-${kind}`;
  row.innerHTML = `
    <span class="system-icon">${icon}</span>
    <span class="system-label">${content}</span>
    <span class="entry-time">${formatClock(timestamp)}</span>
  `;
  return row;
}

function buildMessageEntry(role: "user" | "assistant", content: string, timestamp: Date): HTMLElement {
  const row = document.createElement("div");
  row.className = "transcript-entry";
  row.innerHTML = `
    <div class="entry-meta">
      <span class="entry-speaker">${role === "assistant" ? "Co" : "You"}</span>
      <span class="entry-time">${formatClock(timestamp)}</span>
    </div>
    <div class="entry-text"></div>
  `;
  (row.querySelector(".entry-text") as HTMLElement).textContent = content;
  return row;
}

export function appendTranscriptEntry(container: HTMLElement, message: TranscriptMessage) {
  const timestamp = new Date(message.timestamp);
  const row =
    message.role === "system"
      ? buildSystemEntry(message.content, message.kind ?? "start", timestamp)
      : buildMessageEntry(message.role, message.content, timestamp);
  container.appendChild(row);
}

export function renderTranscriptList(container: HTMLElement, messages: TranscriptMessage[]) {
  container.innerHTML = "";
  for (const m of messages) appendTranscriptEntry(container, m);
}

export function renderCards(cardsGrid: HTMLElement, profile: any, intent: any) {
  cardsGrid.innerHTML = "";

  for (const field of CARD_FIELDS) {
    const card = document.createElement("div");
    card.className = "card";
    const labelEl = document.createElement("div");
    labelEl.className = "card-label";
    labelEl.textContent = field.label;
    const valueEl = document.createElement("div");
    valueEl.className = "card-value";
    valueEl.textContent = formatValue(profile?.[field.key]);
    card.append(labelEl, valueEl);
    cardsGrid.appendChild(card);
  }

  const addIntentCard = (label: string, value: string) => {
    const card = document.createElement("div");
    card.className = "card card-intent";
    const labelEl = document.createElement("div");
    labelEl.className = "card-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("div");
    valueEl.className = "card-value";
    valueEl.textContent = value;
    card.append(labelEl, valueEl);
    cardsGrid.appendChild(card);
  };

  // Part 5's expanded capture — shown alongside the original seeking/
  // offering ask so it's visible whether Co is picking up specific, usable
  // signal (named preferences, real wants, stated availability) or nothing
  // at all. Each renders independently since a transcript can carry one
  // without the others.
  addIntentCard(
    "Seeking / offering",
    intent?.text ? `${intent.type === "seeking" ? "Seeking" : "Offering"}: ${intent.text}` : "Nothing specific detected",
  );
  addIntentCard(
    "Concrete preferences",
    intent?.concrete_preferences?.length ? intent.concrete_preferences.join(", ") : "None detected",
  );
  addIntentCard(
    "Wants / misses",
    intent?.wants?.length ? intent.wants.join(", ") : "None detected",
  );
  addIntentCard("Availability", intent?.availability || "Not mentioned");
}

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
];

export function topicLabel(topic: string): string {
  return topic.replace(/_/g, " ");
}

// Shared by call.ts (browser-simulated calls, which already held this live)
// and phone.ts (real Twilio-bridged calls, now relayed live via Socket.IO —
// see webhooks.ts's pushLiveEvent) so both render an in-progress coverage
// check identically. covered_topics/call_count/latency_ms are sandbox-only
// observability — never part of what's sent back to Hume as the tool
// response (that stays exactly {missing_topics, ready_to_summarize}).
export function renderCoveragePanel(
  container: HTMLElement,
  data: {
    missing_topics: string[];
    ready_to_summarize: boolean;
    covered_topics: string[];
    call_count: number;
    latency_ms: number;
  },
) {
  const chip = (topic: string, covered: boolean) =>
    `<span class="coverage-topic-chip ${covered ? "covered" : "missing"}">${topicLabel(topic)}</span>`;

  container.innerHTML = `
    <div class="coverage-stats">
      <div class="coverage-stat-row">
        <span class="coverage-stat-label">Calls this session</span>
        <span class="coverage-stat-value">${data.call_count}</span>
      </div>
      <div class="coverage-stat-row">
        <span class="coverage-stat-label">Last call latency</span>
        <span class="coverage-stat-value">${data.latency_ms}ms</span>
      </div>
    </div>
    <div class="coverage-section-label">Covered (${data.covered_topics.length}/${RAPPORT_TOPICS.length})</div>
    <div class="coverage-topic-list">
      ${data.covered_topics.map((t) => chip(t, true)).join("") || '<span class="coverage-empty">None yet</span>'}
    </div>
    <div class="coverage-section-label">Missing</div>
    <div class="coverage-topic-list">
      ${data.missing_topics.map((t) => chip(t, false)).join("") || '<span class="coverage-empty">None</span>'}
    </div>
    <div class="coverage-ready ${data.ready_to_summarize ? "yes" : ""}">
      ${data.ready_to_summarize ? "Ready to summarize" : "Not ready yet"}
    </div>
  `;
}

export function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
