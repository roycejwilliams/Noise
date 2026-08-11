import { io as ioClient, Socket } from "socket.io-client";
import { appendTranscriptEntry, renderCoveragePanel } from "./shared.js";
import { renderSidebar } from "./sidebar.js";

renderSidebar("phone");

const statusEl = document.getElementById("status") as HTMLElement;

const stepTextIn = document.getElementById("step-text-in") as HTMLElement;
const stepOtp = document.getElementById("step-otp") as HTMLElement;
const stepCall = document.getElementById("step-call") as HTMLElement;

const messageCoButton = document.getElementById("message-co-button") as HTMLAnchorElement;
const entryError = document.getElementById("entry-error") as HTMLElement;

const otpInput = document.getElementById("otp-input") as HTMLInputElement;
const verifyOtpButton = document.getElementById("verify-otp-button") as HTMLButtonElement;
const resendOtpButton = document.getElementById("resend-otp-button") as HTMLButtonElement;
const otpError = document.getElementById("otp-error") as HTMLElement;

const testCaseSelect = document.getElementById("test-case-select") as HTMLSelectElement;
const requestCallButton = document.getElementById("request-call-button") as HTMLButtonElement;
const callStatusLine = document.getElementById("call-status-line") as HTMLElement;
const smokeTestPanel = document.getElementById("smoke-test-panel") as HTMLElement;
const smokeToolCallState = document.getElementById("smoke-tool-call-state") as HTMLElement;
const smokeToolResponseState = document.getElementById("smoke-tool-response-state") as HTMLElement;
const resultsLinkWrap = document.getElementById("results-link-wrap") as HTMLElement;
const resultsLink = document.getElementById("results-link") as HTMLAnchorElement;

const liveCallPanel = document.getElementById("live-call-panel") as HTMLElement;
const liveTranscriptList = document.getElementById("live-transcript-list") as HTMLElement;
const liveCoveragePanelBody = document.getElementById("live-coverage-panel-body") as HTMLElement;

let userId: string | null = null;
let socketToken: string | null = null;
let statusPollInterval: number | null = null;

// Live view for a real Twilio-bridged call — the browser never holds the
// Hume socket directly here (the backend does, via webhook events), so this
// relays over the same Socket.IO room pattern production already uses for
// other real-time push, joined per user_id. Same data/rendering call.ts
// already shows live for browser-simulated calls (see shared.ts).
type LiveEvent =
  | { seq: number; type: "transcript"; message: { role: "user" | "assistant"; content: string; timestamp: string } }
  | {
      seq: number;
      type: "coverage";
      check: {
        call_number: number;
        timestamp: string;
        missing_topics: string[];
        covered_topics: string[];
        ready_to_summarize: boolean;
        latency_ms: number;
      };
    }
  | { seq: number; type: "call_ended" };

let liveSocket: Socket | null = null;
let lastAppliedSeq = 0;
let liveCoverageCount = 0;

// Applied identically whether the event arrived live over the socket or as
// part of a reconnect catch-up snapshot (see hydrateLiveState) — the seq
// guard makes both paths idempotent, so a coverage result can never render
// before the transcript line that triggered it, and a reconnect never
// double-applies or silently skips events.
function applyLiveEvent(event: LiveEvent) {
  if (event.seq <= lastAppliedSeq) return;
  lastAppliedSeq = event.seq;

  if (event.type === "transcript") {
    liveCallPanel.classList.remove("hidden");
    appendTranscriptEntry(liveTranscriptList, {
      role: event.message.role,
      content: event.message.content,
      timestamp: event.message.timestamp,
    });
    liveTranscriptList.scrollTop = liveTranscriptList.scrollHeight;
  } else if (event.type === "coverage") {
    liveCallPanel.classList.remove("hidden");
    liveCoverageCount += 1;
    renderCoveragePanel(liveCoveragePanelBody, {
      missing_topics: event.check.missing_topics,
      covered_topics: event.check.covered_topics,
      ready_to_summarize: event.check.ready_to_summarize,
      call_count: liveCoverageCount,
      latency_ms: event.check.latency_ms,
    });
  } else if (event.type === "call_ended") {
    // Requirement 7 — hand off cleanly rather than freezing the live view.
    // The existing call_status poll below (already running) picks up
    // call_status='completed' moments later and reveals the same "View
    // extraction results" link it already does today; this just retires
    // the live panel immediately instead of leaving it sitting stale.
    liveCallPanel.classList.add("hidden");
    callStatusLine.textContent = "Call ended — preparing results…";
  }
}

// Snapshot fetch for a fresh connect or a reconnect after a dropped
// connection — applies every event with seq greater than what's already
// rendered (requirement 5). Safe to call redundantly.
async function hydrateLiveState() {
  if (!userId) return;
  try {
    const res = await fetch(`/api/phone/${userId}/live-state`);
    const json = await res.json();
    if (!json.success) return;
    const events: LiveEvent[] = [...json.events].sort((a, b) => a.seq - b.seq);
    for (const event of events) applyLiveEvent(event);
  } catch (err) {
    console.error("Live-state hydrate failed:", err);
  }
}

function ensureLiveSocket() {
  if (liveSocket || !userId || !socketToken) return;
  liveSocket = ioClient({ auth: { user_id: userId, token: socketToken } });
  // Fires on the initial connect AND every reconnect — hydrating from the
  // snapshot both times means a dropped/restored connection catches up on
  // whatever it missed instead of silently resuming from whatever's next.
  liveSocket.on("connect", () => {
    hydrateLiveState();
  });
  liveSocket.on("co:live_event", (event: LiveEvent) => applyLiveEvent(event));
}

function showStep(step: HTMLElement) {
  for (const el of [stepTextIn, stepOtp, stepCall]) el.classList.add("hidden");
  step.classList.remove("hidden");
}

// Entry screen is a single "Message Co to start" button — no name/phone
// form (Ditto pattern). The session itself is created anonymously the
// moment this page loads, before the tester has done anything; the real
// phone number gets attached server-side once the inbound text actually
// arrives (see webhooks.ts's /sendblue/webhook claim logic).
async function initSession() {
  try {
    const res = await fetch("/api/phone/session", { method: "POST" });
    const data = await res.json();
    if (!data.success) throw new Error(data.error ?? "Failed to start session");

    userId = data.user_id;
    socketToken = data.socket_token ?? null;
    const textInNumber = data.text_in_number ?? null;
    if (textInNumber) {
      // sms: link pre-addresses the device's native Messages/iMessage compose
      // sheet — this only removes the manual step of finding/typing the
      // number; the tester still has to send the message themselves.
      messageCoButton.href = `sms:${textInNumber}`;
    } else {
      messageCoButton.classList.add("hidden");
      entryError.textContent = "No text-in number configured — check server config.";
      entryError.classList.remove("hidden");
    }
    statusEl.textContent = "Waiting for your text";
    beginPolling();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Failed to start";
    entryError.textContent = err instanceof Error ? err.message : String(err);
    entryError.classList.remove("hidden");
  }
}

async function verifyOtp() {
  if (!userId) return;
  otpError.classList.add("hidden");
  const otp_code = otpInput.value.trim();
  if (!otp_code) return;

  verifyOtpButton.disabled = true;
  try {
    const res = await fetch(`/api/phone/${userId}/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ otp_code }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error ?? "Verification failed");
    // Polling loop will pick up otp_verified=true and advance the step.
  } catch (err) {
    console.error(err);
    otpError.textContent = err instanceof Error ? err.message : String(err);
    otpError.classList.remove("hidden");
  } finally {
    verifyOtpButton.disabled = false;
  }
}

async function resendOtp() {
  if (!userId) return;
  resendOtpButton.disabled = true;
  try {
    await fetch(`/api/phone/${userId}/resend-otp`, { method: "POST" });
  } catch (err) {
    console.error("Resend failed:", err);
  } finally {
    window.setTimeout(() => (resendOtpButton.disabled = false), 3000);
  }
}

async function saveTag() {
  if (!userId || !testCaseSelect.value) return;
  try {
    await fetch(`/api/phone/${userId}/tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test_case: testCaseSelect.value }),
    });
  } catch (err) {
    console.error("Failed to save tag:", err);
  }
}

async function requestCall() {
  if (!userId) return;
  requestCallButton.disabled = true;
  callStatusLine.textContent = "Calling…";
  try {
    const res = await fetch(`/api/phone/${userId}/call`, { method: "POST" });
    const data = await res.json();
    if (!data.success) throw new Error(data.error ?? "Call failed to start");
    smokeTestPanel.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    callStatusLine.textContent = err instanceof Error ? err.message : String(err);
    requestCallButton.disabled = false;
  }
}

// recap_ready gates the results link directly — checked independently of
// call_status so the link can never appear before there's actually
// something to show, regardless of what call_status happens to mean.
function renderCallStatus(callStatus: string | null, recapReady: boolean) {
  if (!callStatus) return;
  const labels: Record<string, string> = {
    initiated: "Dialing…",
    ringing: "Ringing your phone…",
    answered: "In call",
    processing: "Call ended — preparing results…",
    completed: recapReady ? "Results ready" : "Call ended — preparing results…",
    failed: "Something went wrong preparing results — try calling again",
  };
  callStatusLine.textContent = labels[callStatus] ?? callStatus;

  if (recapReady && userId) {
    resultsLinkWrap.classList.remove("hidden");
    resultsLink.href = `/call/${userId}/results`;
  }
}

function renderSmokeTest(toolCallAt: string | null, toolResponseAt: string | null) {
  if (toolCallAt || toolResponseAt) smokeTestPanel.classList.remove("hidden");
  smokeToolCallState.textContent = toolCallAt ? `✓ ${new Date(toolCallAt).toLocaleTimeString()}` : "waiting…";
  smokeToolResponseState.textContent = toolResponseAt
    ? `✓ ${new Date(toolResponseAt).toLocaleTimeString()}`
    : "waiting…";
}

async function pollStatus() {
  if (!userId) return;
  try {
    const res = await fetch(`/api/phone/${userId}/status`);
    const json = await res.json();
    if (!json.success) return;
    const d = json.data;

    if (!d.contact_verified) {
      showStep(stepTextIn);
      statusEl.textContent = "Waiting for text-in";
    } else if (!d.otp_verified) {
      showStep(stepOtp);
      statusEl.textContent = "Waiting for OTP";
    } else {
      showStep(stepCall);
      statusEl.textContent = "Verified — ready to call";
      renderCallStatus(d.call_status, Boolean(d.recap_ready));
      renderSmokeTest(d.smoke_test_tool_call_at, d.smoke_test_tool_response_at);
      if (d.test_case) testCaseSelect.value = d.test_case;
      // Connects once a call exists and hasn't ended — covers both "just
      // requested" and "page reloaded mid-call" the same way, since this is
      // a no-op once already connected.
      if (d.call_sid && d.call_status !== "completed") ensureLiveSocket();
    }
  } catch (err) {
    console.error("Status poll failed:", err);
  }
}

function beginPolling() {
  if (statusPollInterval !== null) return;
  pollStatus();
  statusPollInterval = window.setInterval(pollStatus, 2500);
}

verifyOtpButton.addEventListener("click", verifyOtp);
resendOtpButton.addEventListener("click", resendOtp);
testCaseSelect.addEventListener("change", saveTag);
requestCallButton.addEventListener("click", requestCall);

initSession();
