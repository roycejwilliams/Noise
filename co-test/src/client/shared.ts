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

  const intentCard = document.createElement("div");
  intentCard.className = "card card-intent";
  const intentLabel = document.createElement("div");
  intentLabel.className = "card-label";
  intentLabel.textContent = "Seeking / offering";
  const intentValue = document.createElement("div");
  intentValue.className = "card-value";
  intentValue.textContent = intent
    ? `${intent.type === "seeking" ? "Seeking" : "Offering"}: ${intent.text}`
    : "Nothing specific detected";
  intentCard.append(intentLabel, intentValue);
  cardsGrid.appendChild(intentCard);
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
