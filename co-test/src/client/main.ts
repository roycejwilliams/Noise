import {
  HumeClient,
  EVIWebAudioPlayer,
  getAudioStream,
  ensureSingleValidAudioTrack,
  getBrowserSupportedMimeType,
  convertBlobToBase64,
  MimeType,
} from "hume";

const callButton = document.getElementById("call-button") as HTMLButtonElement;
const muteButton = document.getElementById("mute-button") as HTMLButtonElement;
const speakerButton = document.getElementById("speaker-button") as HTMLButtonElement;
const timerEl = document.getElementById("timer") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const transcriptList = document.getElementById("transcript-list") as HTMLElement;
const transcriptToggle = document.getElementById("transcript-toggle") as HTMLButtonElement;
const transcriptPanel = document.getElementById("transcript-panel") as HTMLElement;
const waveformEl = document.getElementById("waveform") as HTMLElement;
const extractionSection = document.getElementById("extraction-section") as HTMLElement;
const cardsGrid = document.getElementById("cards-grid") as HTMLElement;
const rawOutputEl = document.getElementById("raw-output") as HTMLElement;
const downloadButton = document.getElementById("download-json") as HTMLButtonElement;

let socket: any = null;
let recorder: MediaRecorder | null = null;
let player: EVIWebAudioPlayer | null = null;
let userId: string | null = null;
let callStartTime: number | null = null;
let timerInterval: number | null = null;
let micMuted = false;
let speakerMuted = false;
const transcriptMessages: { role: "user" | "assistant"; content: string }[] = [];
let extractedData: any = null;

async function ensureSession(): Promise<string> {
  if (userId) return userId;
  const res = await fetch("/api/session", { method: "POST" });
  const data = await res.json();
  if (!data.success) throw new Error("Failed to create session");
  userId = data.user_id;
  return userId!;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
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
  const row = document.createElement("div");
  row.className = `transcript-entry transcript-system transcript-system-${kind}`;
  row.innerHTML = `
    <span class="system-icon">${kind === "start" ? "✓" : "✕"}</span>
    <span class="system-label">${label}</span>
    <span class="entry-time">${formatClock(new Date())}</span>
  `;
  transcriptList.appendChild(row);
  scrollTranscriptToBottom();
}

function addMessageEntry(role: "user" | "assistant", content: string, timestamp: Date) {
  transcriptMessages.push({ role, content });

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
  transcriptList.appendChild(row);
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
  statusEl.textContent = "Connecting…";

  try {
    await ensureSession();

    const tokenRes = await fetch("/api/hume-token", { method: "POST" });
    const tokenData = await tokenRes.json();
    if (!tokenData.success) throw new Error("Failed to fetch Hume access token");

    const client = new HumeClient({ accessToken: tokenData.accessToken });
    socket = client.empathicVoice.chat.connect({ configId: tokenData.configId });

    player = new EVIWebAudioPlayer({ fft: { enabled: true } });
    player.on("fft", (e: any) => updateWaveform(e.detail.fft));

    socket.on("open", async () => {
      await player!.init();
      recorder = await startAudioCapture(socket);
      startTimer();
      statusEl.textContent = "In call";
      callButton.classList.add("active");
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
    callButton.disabled = false;
  }
}

function endCall() {
  callButton.disabled = true;
  socket?.close();
}

function handleCallEnded() {
  stopTimer();
  recorder?.stream.getTracks().forEach((t) => t.stop());
  recorder = null;
  player?.dispose();
  player = null;
  socket = null;

  callButton.classList.remove("active");
  callButton.disabled = false;
  statusEl.textContent = `Call ended · ${timerEl.textContent}`;
  resetWaveform();
  addSystemEntry("Call ended", "end");

  runExtraction();
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

const CARD_FIELDS: { key: string; label: string }[] = [
  { key: "life_chapters", label: "Life chapter" },
  { key: "city", label: "City" },
  { key: "social_energy", label: "Social energy" },
  { key: "connection_style", label: "Connection style" },
  { key: "goals", label: "Goals" },
  { key: "blockers", label: "Blockers" },
  { key: "emotional_state", label: "Emotional state" },
];

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  return String(v);
}

function renderExtraction(data: { profile: any; intent: any; raw_model_output: string }) {
  cardsGrid.innerHTML = "";

  for (const field of CARD_FIELDS) {
    const card = document.createElement("div");
    card.className = "card";
    const labelEl = document.createElement("div");
    labelEl.className = "card-label";
    labelEl.textContent = field.label;
    const valueEl = document.createElement("div");
    valueEl.className = "card-value";
    valueEl.textContent = formatValue(data.profile?.[field.key]);
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
  intentValue.textContent = data.intent
    ? `${data.intent.type === "seeking" ? "Seeking" : "Offering"}: ${data.intent.text}`
    : "Nothing specific detected";
  intentCard.append(intentLabel, intentValue);
  cardsGrid.appendChild(intentCard);

  rawOutputEl.textContent = JSON.stringify(data, null, 2);
}

async function runExtraction() {
  if (!userId) return;
  const transcript = transcriptMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
  if (!transcript.trim()) return;

  extractionSection.classList.remove("hidden");
  extractionSection.classList.add("loading");

  try {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, transcript }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error ?? "Extraction failed");
    extractedData = json.data;
    renderExtraction(extractedData);
  } catch (err) {
    console.error("Extraction failed:", err);
  } finally {
    extractionSection.classList.remove("loading");
  }
}

downloadButton.addEventListener("click", () => {
  if (!extractedData) return;
  const blob = new Blob([JSON.stringify(extractedData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "co-profile.json";
  a.click();
  URL.revokeObjectURL(url);
});

initWaveformBars();
