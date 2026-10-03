import { renderSidebar } from "./sidebar.js";

renderSidebar("prompt");

// Co's call prompt, read-only: api/prompts/co-system-prompt.md is the source
// of truth (the ElevenLabs agent and the text persona both use it), so
// changes go through that file and scripts/pushElevenLabsAgent.ts, not here.
const statusEl = document.getElementById("status") as HTMLElement;
const configMetaEl = document.getElementById("config-meta") as HTMLElement;
const textarea = document.getElementById("prompt-textarea") as HTMLTextAreaElement;

async function init(): Promise<void> {
  statusEl.textContent = "Loading prompt…";
  try {
    const res = await fetch("/api/prompt");
    const json = await res.json();
    if (!json.success) throw new Error(json.error ?? "Failed to load prompt");
    textarea.value = json.prompt;
    configMetaEl.textContent = json.source;
    statusEl.textContent = "Loaded";
  } catch (err) {
    console.error("Failed to load prompt:", err);
    statusEl.textContent = "Failed to load the prompt file";
  }
}

init();
