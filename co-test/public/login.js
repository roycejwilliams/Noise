"use strict";
(() => {
  // src/client/login.ts
  var statusEl = document.getElementById("login-status");
  var stepPhone = document.getElementById("step-phone");
  var stepOtp = document.getElementById("step-otp");
  var phoneInput = document.getElementById("phone-input");
  var sendCodeButton = document.getElementById("send-code-button");
  var phoneError = document.getElementById("phone-error");
  var otpInput = document.getElementById("otp-input");
  var verifyButton = document.getElementById("verify-button");
  var otpError = document.getElementById("otp-error");
  var backButton = document.getElementById("back-button");
  var phoneNumber = "";
  function showStep(step) {
    for (const el of [stepPhone, stepOtp]) el.classList.add("hidden");
    step.classList.remove("hidden");
  }
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
    if (!value) return;
    sendCodeButton.disabled = true;
    try {
      const res = await fetch("/api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number: value })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? "Failed to send code.");
      phoneNumber = value;
      statusEl.textContent = "Code sent \u2014 check your texts.";
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
        body: JSON.stringify({ phone_number: phoneNumber, otp_code })
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
})();
