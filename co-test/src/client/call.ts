import {
  HumeClient,
  EVIWebAudioPlayer,
  getAudioStream,
  ensureSingleValidAudioTrack,
  getBrowserSupportedMimeType,
  convertBlobToBase64,
  MimeType,
} from "hume";
import { appendTranscriptEntry, getPromptOverride, TranscriptMessage } from "./shared.js";

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

let socket: any = null;
let recorder: MediaRecorder | null = null;
let player: EVIWebAudioPlayer | null = null;
let userId: string | null = null;
let callStartTime: number | null = null;
let timerInterval: number | null = null;
let micMuted = false;
let speakerMuted = false;
const transcriptMessages: TranscriptMessage[] = [];

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

function addSystemEntry(label: string, kind: "start" | "end") {
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

async function startAudioCapture(sock: any, timeSliceMs = 80): Promise<MediaRecorder> {
  const mimeTypeResult = getBrowserSupportedMimeType();
  const mimeType = mimeTypeResult.success ? mimeTypeResult.mimeType : MimeType.WEBM;

  const micStream = await getAudioStream();
  ensureSingleValidAudioTrack(micStream);

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

async function startCall() {
  callButton.disabled = true;
  callButton.title = "Connecting…";
  callButton.setAttribute("aria-label", "Connecting…");
  statusEl.textContent = "Connecting…";

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

    player = new EVIWebAudioPlayer({ fft: { enabled: true } });
    player.on("fft", (e: any) => updateWaveform(e.detail.fft));

    socket.on("open", async () => {
      await player!.init();
      recorder = await startAudioCapture(socket);
      startTimer();
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
    callButton.title = "Start call";
    callButton.setAttribute("aria-label", "Start call");
    callButton.disabled = false;
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
        body: JSON.stringify({ user_id: sessionId, transcript, messages: transcriptMessages }),
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
