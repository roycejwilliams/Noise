const statusEl = document.getElementById("login-status") as HTMLElement;

const stepPhone = document.getElementById("step-phone") as HTMLElement;
const stepOtp = document.getElementById("step-otp") as HTMLElement;

const phoneInput = document.getElementById("phone-input") as HTMLInputElement;
const sendCodeButton = document.getElementById("send-code-button") as HTMLButtonElement;
const phoneError = document.getElementById("phone-error") as HTMLElement;

const otpInput = document.getElementById("otp-input") as HTMLInputElement;
const verifyButton = document.getElementById("verify-button") as HTMLButtonElement;
const otpError = document.getElementById("otp-error") as HTMLElement;
const backButton = document.getElementById("back-button") as HTMLButtonElement;

let phoneNumber = "";

function showStep(step: HTMLElement) {
  for (const el of [stepPhone, stepOtp]) el.classList.add("hidden");
  step.classList.remove("hidden");
}

// A returning tester with a still-valid session cookie skips straight past
// the form — this is a tool-access check (routes/login.ts's /status), not a
// page reload of the actual test flow, which starts fresh at /phone either way.
async function redirectIfAlreadyLoggedIn() {
  try {
    const res = await fetch("/api/login/status");
    const data = await res.json();
    if (data.success && data.loggedIn) {
      window.location.href = "/phone";
    }
  } catch (err) {
    console.error("Login status check failed:", err);
  }
}

async function sendCode() {
  phoneError.classList.add("hidden");
  const value = phoneInput.value.trim();
  if (!value) {
    phoneError.textContent = "Phone number is required.";
    phoneError.classList.remove("hidden");
    return;
  }

  sendCodeButton.disabled = true;
  try {
    const res = await fetch("/api/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: value }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error ?? "Failed to send code.");
    phoneNumber = value;
    statusEl.textContent = "Code sent — check your texts.";
    showStep(stepOtp);
    otpInput.focus();
  } catch (err) {
    phoneError.textContent = err instanceof Error ? err.message : String(err);
    phoneError.classList.remove("hidden");
  } finally {
    sendCodeButton.disabled = false;
  }
}

async function verifyCode() {
  otpError.classList.add("hidden");
  const otp_code = otpInput.value.trim();
  if (!otp_code) return;

  verifyButton.disabled = true;
  try {
    const res = await fetch("/api/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: phoneNumber, otp_code }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error ?? "Verification failed.");
    window.location.href = "/phone";
  } catch (err) {
    otpError.textContent = err instanceof Error ? err.message : String(err);
    otpError.classList.remove("hidden");
  } finally {
    verifyButton.disabled = false;
  }
}

sendCodeButton.addEventListener("click", sendCode);
phoneInput.addEventListener("keydown", (e) => e.key === "Enter" && sendCode());
verifyButton.addEventListener("click", verifyCode);
otpInput.addEventListener("keydown", (e) => e.key === "Enter" && verifyCode());
backButton.addEventListener("click", () => {
  otpInput.value = "";
  statusEl.textContent = "Enter your phone number to continue.";
  showStep(stepPhone);
  phoneInput.focus();
});

redirectIfAlreadyLoggedIn();
