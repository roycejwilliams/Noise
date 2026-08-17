const statusEl = document.getElementById("login-status") as HTMLElement;

const stepPhone = document.getElementById("step-phone") as HTMLElement;
const stepOtp = document.getElementById("step-otp") as HTMLElement;

const nameInput = document.getElementById("name-input") as HTMLInputElement;
const emailInput = document.getElementById("email-input") as HTMLInputElement;
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

// Same split as the Framer intake form — one Full Name field, split on the
// first space into first/last. A single-word name falls back to itself for
// last_name so it still satisfies the backend's required field rather than
// blocking signup over it.
function splitName(fullName: string): { first_name: string; last_name: string } {
  const [first_name, ...rest] = fullName.trim().split(/\s+/);
  return { first_name, last_name: rest.join(" ") || first_name };
}

async function sendCode() {
  phoneError.classList.add("hidden");
  const fullName = nameInput.value.trim();
  const email = emailInput.value.trim();
  const value = phoneInput.value.trim();
  if (!fullName || !email || !value) {
    phoneError.textContent = "Name, email, and phone are all required.";
    phoneError.classList.remove("hidden");
    return;
  }

  sendCodeButton.disabled = true;
  try {
    const { first_name, last_name } = splitName(fullName);
    const res = await fetch("/api/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: value, first_name, last_name, email }),
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
