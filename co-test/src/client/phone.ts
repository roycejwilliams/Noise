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

let userId: string | null = null;
let statusPollInterval: number | null = null;

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

function renderCallStatus(callStatus: string | null) {
  if (!callStatus) return;
  const labels: Record<string, string> = {
    initiated: "Dialing…",
    ringing: "Ringing your phone…",
    answered: "In call",
    completed: "Call ended — preparing results…",
  };
  callStatusLine.textContent = labels[callStatus] ?? callStatus;

  if (callStatus === "completed" && userId) {
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
      renderCallStatus(d.call_status);
      renderSmokeTest(d.smoke_test_tool_call_at, d.smoke_test_tool_response_at);
      if (d.test_case) testCaseSelect.value = d.test_case;
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
