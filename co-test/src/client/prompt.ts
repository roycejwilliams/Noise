import { clearPromptOverride, getPromptOverride, setPromptOverride } from "./shared.js";

const statusEl = document.getElementById("status") as HTMLElement;
const configMetaEl = document.getElementById("config-meta") as HTMLElement;
const textarea = document.getElementById("prompt-textarea") as HTMLTextAreaElement;
const resetButton = document.getElementById("reset-button") as HTMLButtonElement;
const modeLabel = document.getElementById("prompt-mode-label") as HTMLElement;

let livePrompt = "";

function updateModeLabel() {
  const override = getPromptOverride();
  const isModified = !!override && override !== livePrompt;
  modeLabel.textContent = isModified
    ? "Modified test prompt — active for your next call"
    : "Default (production) prompt — nothing overridden";
  modeLabel.classList.toggle("modified", isModified);
}

// Always re-fetches from Hume rather than trusting any cached value, so
// "reset" really means "whatever the real config says right now" — not
// whatever this page happened to load with earlier.
async function fetchLivePrompt(): Promise<void> {
  statusEl.textContent = "Loading live prompt…";
  try {
    const res = await fetch("/api/prompt");
    const json = await res.json();
    if (!json.success) throw new Error(json.error ?? "Failed to load prompt");
    livePrompt = json.prompt;
    configMetaEl.textContent = `${json.configName} · v${json.version}`;
    statusEl.textContent = "Loaded live prompt from Hume";
  } catch (err) {
    console.error("Failed to fetch live prompt:", err);
    statusEl.textContent = "Failed to load live prompt — is HUME_CONFIG_ID set?";
    livePrompt = "";
  }
}

textarea.addEventListener("input", () => {
  if (textarea.value === livePrompt) {
    clearPromptOverride();
  } else {
    setPromptOverride(textarea.value);
  }
  updateModeLabel();
});

resetButton.addEventListener("click", async () => {
  clearPromptOverride();
  textarea.value = "Loading live prompt…";
  await fetchLivePrompt();
  textarea.value = livePrompt;
  updateModeLabel();
});

async function init() {
  await fetchLivePrompt();
  const override = getPromptOverride();
  textarea.value = override ?? livePrompt;
  updateModeLabel();
}

init();
