import {
  HumeClient,
  EVIWebAudioPlayer,
  getAudioStream,
  ensureSingleValidAudioTrack,
  getBrowserSupportedMimeType,
  convertBlobToBase64,
  MimeType,
} from "hume";
import { appendTranscriptEntry, getPromptOverride, renderCoveragePanel, TranscriptMessage } from "./shared.js";

const callButton = document.getElementById("call-button") as HTMLButtonElement;
const muteButton = document.getElementById("mute-button") as HTMLButtonElement;
const speakerButton = document.getElementById("speaker-button") as HTMLButtonElement;
const timerEl = document.getElementById("timer") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const transcriptList = document.getElementById("transcript-list") as HTMLElement;
const transcriptToggle = document.getElementById("transcript-toggle") as HTMLButtonElement;
const transcriptPanel = document.getElementById("transcript-panel") as HTMLElement;
const waveformEl = document.getElementById("waveform") as HTMLElement;
const promptModeLabel = document.getElementById("prompt-mode-label") as HTMLElement;
const coveragePanelBody = document.getElementById("coverage-panel-body") as HTMLElement;

let socket: any = null;
let recorder: MediaRecorder | null = null;
let player: EVIWebAudioPlayer | null = null;
let userId: string | null = null;
let callStartTime: number | null = null;
let timerInterval: number | null = null;
let micMuted = false;
let speakerMuted = false;
let toolCallCount = 0;
const transcriptMessages: TranscriptMessage[] = [];

export type CoverageCheck = {
  call_number: number;
  timestamp: string;
  missing_topics: string[];
  covered_topics: string[];
  ready_to_summarize: boolean;
  latency_ms: number;
};

const coverageHistory: CoverageCheck[] = [];

async function ensureSession(): Promise<string> {
  if (userId) return userId;
  const res = await fetch("/api/session", { method: "POST" });
  const data = await res.json();
  if (!data.success) throw new Error("Failed to create session");
  userId = data.user_id;
  return userId!;
}

function formatTimer(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function scrollTranscriptToBottom() {
  transcriptList.scrollTop = transcriptList.scrollHeight;
}

function addSystemEntry(label: string, kind: "start" | "end" | "tool") {
  const message: TranscriptMessage = {
    role: "system",
    content: label,
    timestamp: new Date().toISOString(),
    kind,
  };
  transcriptMessages.push(message);
  appendTranscriptEntry(transcriptList, message);
  scrollTranscriptToBottom();
}

// transcriptMessages only ever holds finalized (non-interim) user/assistant
// turns, so this is always what Co has actually heard up to this point in
// the live call — same shape runExtractionAndRedirect sends post-call.
function transcriptSoFar(): string {
  return transcriptMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}

function resetCoveragePanel() {
  toolCallCount = 0;
  coverageHistory.length = 0;
  coveragePanelBody.innerHTML = '<div class="coverage-empty">No tool calls yet</div>';
}

// Sandbox-only handler: co-test's browser holds the live EVI socket, so
// Hume delivers tool_call here directly rather than through the Hume
// webhook (that path — api/src/routes/co.ts — only exists for the
// Twilio-bridged phone call, where no client holds the socket). The
// assessment itself (assessConversationCoverage) is the same server-side
// function either way; this just proves it out before wiring the
// Twilio-specific plumbing.
async function handleToolCall(msg: any) {
  if (msg.name !== "assess_conversation_coverage") return;
  toolCallCount += 1;

  try {
    const res = await fetch("/api/assess-coverage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: transcriptSoFar() }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error ?? "assess-coverage failed");

    // Only missing_topics/ready_to_summarize ever go back to Hume — covered_topics
    // and latency_ms are sandbox-only and stop at the side panel + history sent
    // to /api/extract for the results page.
    socket.sendToolResponseMessage({
      toolCallId: msg.toolCallId,
      content: JSON.stringify(data.assessment),
    });
    coverageHistory.push({
      call_number: toolCallCount,
      timestamp: new Date().toISOString(),
      missing_topics: data.assessment.missing_topics,
      covered_topics: data.covered_topics,
      ready_to_summarize: data.assessment.ready_to_summarize,
      latency_ms: data.latency_ms,
    });
    renderCoveragePanel(coveragePanelBody, {
      ...data.assessment,
      covered_topics: data.covered_topics,
      call_count: toolCallCount,
      latency_ms: data.latency_ms,
    });
    addSystemEntry("Coverage check", "tool");
  } catch (err) {
    console.error("assess_conversation_coverage tool call failed:", err);
    const fallback = { missing_topics: ALL_TOPICS, ready_to_summarize: false };
    socket.sendToolErrorMessage({
      toolCallId: msg.toolCallId,
      error: err instanceof Error ? err.message : String(err),
      content: JSON.stringify(fallback),
    });
    addSystemEntry("Coverage check — failed, sent fallback", "tool");
  }
}

function addMessageEntry(role: "user" | "assistant", content: string, timestamp: Date) {
  const message: TranscriptMessage = { role, content, timestamp: timestamp.toISOString() };
  transcriptMessages.push(message);
  appendTranscriptEntry(transcriptList, message);
  scrollTranscriptToBottom();
}

function startTimer() {
  callStartTime = Date.now();
  timerEl.textContent = "00:00";
  timerInterval = window.setInterval(() => {
    timerEl.textContent = formatTimer(Date.now() - callStartTime!);
  }, 500);
}

function stopTimer() {
  if (timerInterval !== null) window.clearInterval(timerInterval);
  timerInterval = null;
}

const BAR_COUNT = 24;

function initWaveformBars() {
  waveformEl.innerHTML = "";
  for (let i = 0; i < BAR_COUNT; i++) {
    const bar = document.createElement("div");
    bar.className = "wave-bar";
    waveformEl.appendChild(bar);
  }
}

function updateWaveform(fft: number[]) {
  const bars = waveformEl.children;
  for (let i = 0; i < bars.length; i++) {
    const v = fft[i] ?? 0;
    const heightPct = Math.min(100, Math.max(8, (v / 255) * 100));
    (bars[i] as HTMLElement).style.height = `${heightPct}%`;
  }
}

function resetWaveform() {
  const bars = waveformEl.children;
  for (let i = 0; i < bars.length; i++) (bars[i] as HTMLElement).style.height = "8%";
}

function startAudioCapture(
  micStream: MediaStream,
  mimeType: MimeType,
  sock: any,
  timeSliceMs = 80,
): MediaRecorder {
  const rec = new MediaRecorder(micStream, { mimeType });
  rec.ondataavailable = async (e: BlobEvent) => {
    if (e.data.size > 0 && sock.readyState === WebSocket.OPEN && !micMuted) {
      const data = await convertBlobToBase64(e.data);
      sock.sendAudioInput({ data });
    }
  };
  rec.onerror = (e) => console.error("MediaRecorder error:", e);
  rec.start(timeSliceMs);
  return rec;
}

function resetCallButtonToIdle() {
  callButton.title = "Start call";
  callButton.setAttribute("aria-label", "Start call");
  callButton.disabled = false;
}

async function startCall() {
  callButton.disabled = true;
  callButton.title = "Connecting…";
  callButton.setAttribute("aria-label", "Connecting…");
  statusEl.textContent = "Connecting…";

  // iOS Safari only allows AudioContext.resume() (inside player.init()) while
  // the tap's user-activation is still live — that window closes once we've
  // awaited a couple of network round trips, so this has to run before
  // anything else, not after them inside the "open" handler like it used to.
  try {
    player = new EVIWebAudioPlayer({ fft: { enabled: true } });
    player.on("fft", (e: any) => updateWaveform(e.detail.fft));
    await player.init();
  } catch (err) {
    console.error("Failed to init audio player:", err);
    statusEl.textContent = "Failed to connect";
    resetCallButtonToIdle();
    player?.dispose();
    player = null;
    return;
  }

  // Confirm we can actually capture the mic *before* opening the Hume
  // socket. Hume greets proactively the instant the connection opens, so
  // requesting the mic only after that point means Co starts talking into
  // a call the user was never actually connected to.
  let micStream: MediaStream;
  let mimeType: MimeType;
  try {
    const mimeTypeResult = getBrowserSupportedMimeType();
    mimeType = mimeTypeResult.success ? mimeTypeResult.mimeType : MimeType.WEBM;
    micStream = await getAudioStream();
    ensureSingleValidAudioTrack(micStream);
  } catch (err) {
    console.error("Failed to acquire microphone:", err);
    const detail = err instanceof Error ? `${err.name || "Error"}: ${err.message}` : String(err);
    statusEl.textContent = `Mic error — ${detail}`;
    resetCallButtonToIdle();
    player?.dispose();
    player = null;
    return;
  }

  try {
    await ensureSession();

    const tokenRes = await fetch("/api/hume-token", { method: "POST" });
    const tokenData = await tokenRes.json();
    if (!tokenData.success) throw new Error("Failed to fetch Hume access token");

    const client = new HumeClient({ accessToken: tokenData.accessToken });
    const promptOverride = getPromptOverride();
    socket = client.empathicVoice.chat.connect({
      configId: tokenData.configId,
      ...(promptOverride ? { sessionSettings: { systemPrompt: promptOverride } } : {}),
    });

    socket.on("open", () => {
      recorder = startAudioCapture(micStream, mimeType, socket);
      startTimer();
      resetCoveragePanel();
      statusEl.textContent = "In call";
      callButton.classList.add("active");
      callButton.title = "End call";
      callButton.setAttribute("aria-label", "End call");
      callButton.setAttribute("aria-pressed", "true");
      callButton.disabled = false;
      addSystemEntry("Started conversation", "start");
    });

    socket.on("message", (msg: any) => {
      const receivedAt: Date = msg.receivedAt ? new Date(msg.receivedAt) : new Date();
      switch (msg.type) {
        case "user_message":
          if (!msg.interim && msg.message?.content) {
            addMessageEntry("user", msg.message.content, receivedAt);
          }
          break;
        case "assistant_message":
          if (msg.message?.content) {
            addMessageEntry("assistant", msg.message.content, receivedAt);
          }
          break;
        case "audio_output":
          player?.enqueue(msg);
          break;
        case "user_interruption":
          player?.stop();
          break;
        case "tool_call":
          handleToolCall(msg).catch((err) => console.error("Unhandled tool_call error:", err));
          break;
        case "error":
          console.error("Hume reported an error:", msg);
          break;
      }
    });

    socket.on("error", (err: unknown) => {
      console.error("Hume socket error:", err);
      statusEl.textContent = "Connection error";
    });

    socket.on("close", () => {
      handleCallEnded();
    });
  } catch (err) {
    console.error("Failed to start call:", err);
    statusEl.textContent = "Failed to connect";
    resetCallButtonToIdle();
    player?.dispose();
    player = null;
    micStream.getTracks().forEach((t) => t.stop());
  }
}

function endCall() {
  callButton.disabled = true;
  socket?.close();
}

async function handleCallEnded() {
  stopTimer();
  recorder?.stream.getTracks().forEach((t) => t.stop());
  recorder = null;
  player?.dispose();
  player = null;
  socket = null;

  callButton.classList.remove("active");
  callButton.title = "Start call";
  callButton.setAttribute("aria-label", "Start call");
  callButton.setAttribute("aria-pressed", "false");
  callButton.disabled = true;
  resetWaveform();
  addSystemEntry("Call ended", "end");

  const finalTimer = timerEl.textContent;
  statusEl.textContent = `Call ended · ${finalTimer} · preparing results…`;

  await runExtractionAndRedirect();
}

callButton.addEventListener("click", () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    endCall();
  } else {
    startCall();
  }
});

muteButton.addEventListener("click", () => {
  micMuted = !micMuted;
  muteButton.classList.toggle("active", micMuted);
  muteButton.setAttribute("aria-pressed", String(micMuted));
});

speakerButton.addEventListener("click", () => {
  speakerMuted = !speakerMuted;
  speakerButton.classList.toggle("active", speakerMuted);
  speakerButton.setAttribute("aria-pressed", String(speakerMuted));
  if (speakerMuted) player?.mute();
  else player?.unmute();
});

transcriptToggle.addEventListener("click", () => {
  const collapsed = transcriptPanel.classList.toggle("collapsed");
  transcriptToggle.classList.toggle("collapsed", collapsed);
});

// Runs extraction against everything captured during the call, then always
// navigates to the results page for this session — even on failure or an
// empty transcript, since the results page has a defined "not ready" state
// for exactly that, rather than stranding the user on the ended-call screen.
async function runExtractionAndRedirect() {
  if (!userId) return;
  const sessionId = userId;

  const transcript = transcriptMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  if (transcript.trim()) {
    try {
      await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: sessionId,
          transcript,
          messages: transcriptMessages,
          coverage_history: coverageHistory,
        }),
      });
    } catch (err) {
      console.error("Extraction failed:", err);
    }
  }

  window.location.href = `/call/${sessionId}/results`;
}

// Checked once per page load, not live-updated — the override only ever
// changes on the Prompt page, and sessionStorage is scoped to this tab, so
// there's no scenario where it changes out from under an already-loaded
// call page.
function renderPromptModeLabel() {
  const override = getPromptOverride();
  const isModified = !!override;
  promptModeLabel.textContent = isModified
    ? "Next call: modified test prompt"
    : "Next call: default (production) prompt";
  promptModeLabel.classList.toggle("modified", isModified);
}

renderPromptModeLabel();
initWaveformBars();
