import { downloadJson, renderCards, renderTranscriptList, TranscriptMessage } from "./shared.js";

const statusEl = document.getElementById("status") as HTMLElement;
const emptyState = document.getElementById("empty-state") as HTMLElement;
const emptyMessage = document.getElementById("empty-message") as HTMLElement;
const extractionSection = document.getElementById("extraction-section") as HTMLElement;
const cardsGrid = document.getElementById("cards-grid") as HTMLElement;
const rawOutputEl = document.getElementById("raw-output") as HTMLElement;
const transcriptList = document.getElementById("transcript-list") as HTMLElement;
const downloadButton = document.getElementById("download-json") as HTMLButtonElement;

type StoredResult = {
  profile: any;
  intent: any;
  raw_model_output: string;
  transcript: string;
  messages: TranscriptMessage[];
};

function getSessionId(): string | null {
  const match = window.location.pathname.match(/^\/call\/([^/]+)\/results\/?$/);
  return match ? match[1] : null;
}

function showEmptyState(message: string) {
  emptyMessage.textContent = message;
  emptyState.classList.remove("hidden");
  extractionSection.classList.add("hidden");
}

async function load() {
  const sessionId = getSessionId();
  if (!sessionId) {
    statusEl.textContent = "Invalid session";
    showEmptyState("This isn't a valid session link.");
    return;
  }

  try {
    const res = await fetch(`/api/session/${sessionId}/results`);
    const json = await res.json();

    if (!json.success) {
      statusEl.textContent = "Error";
      showEmptyState("Something went wrong loading this session.");
      return;
    }

    if (json.status === "not_found") {
      statusEl.textContent = "Not found";
      showEmptyState("No session found for this link.");
      return;
    }

    if (json.status === "not_ready") {
      statusEl.textContent = "Not ready";
      showEmptyState("This call hasn't finished yet — no extraction is available for it.");
      return;
    }

    const data: StoredResult = json.data;
    statusEl.textContent = "Ready";
    emptyState.classList.add("hidden");
    extractionSection.classList.remove("hidden");

    renderCards(cardsGrid, data.profile, data.intent);
    rawOutputEl.textContent = JSON.stringify(data, null, 2);
    renderTranscriptList(transcriptList, data.messages ?? []);

    downloadButton.addEventListener("click", () => {
      downloadJson(data, "co-profile.json");
    });
  } catch (err) {
    console.error("Failed to load results:", err);
    statusEl.textContent = "Error";
    showEmptyState("Something went wrong loading this session.");
  }
}

load();
