"use strict";
(() => {
  // src/client/login.ts
  var statusEl = document.getElementById("login-status");
  var textCoButton = document.getElementById("text-co-button");
  var waitingEl = document.getElementById("login-waiting");
  var errorEl = document.getElementById("login-error");
  var phoneForm = document.getElementById("login-phone-form");
  var phoneInput = document.getElementById("login-phone");
  var confirmForm = document.getElementById("login-confirm-form");
  var confirmInput = document.getElementById("login-confirm-code");
  var POLL_MS = 2e3;
  var pollTimer = null;
  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }
  async function redirectIfAlreadyLoggedIn() {
    try {
      const data = await (await fetch("/api/login/status")).json();
      if (data.success && data.loggedIn) {
        window.location.href = "/phone";
        return true;
      }
    } catch (err) {
      console.error("Login status check failed:", err);
    }
    return false;
  }
  var phone = "";
  async function prepareCode() {
    errorEl.classList.add("hidden");
    try {
      const data = await (await fetch("/api/login/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) })).json();
      if (!data.success && data.error) throw new Error(data.error);
      if (!data.success || !data.text_in_number) throw new Error("Couldn't start sign-in. Refresh to try again.");
      const message = `Hi Co! (test site code: ${data.code})`;
      const separator = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "&" : "?";
      textCoButton.href = `sms:${data.text_in_number}${separator}body=${encodeURIComponent(message)}`;
      textCoButton.removeAttribute("aria-disabled");
      startPolling();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  }
  function startPolling() {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(async () => {
      try {
        const data = await (await fetch("/api/login/check")).json();
        if (data.status === "confirm") {
          window.clearInterval(pollTimer);
          waitingEl.classList.add("hidden");
          textCoButton.classList.add("hidden");
          confirmForm.classList.remove("hidden");
          statusEl.textContent = "Co just texted you a code. Enter it here.";
          confirmInput.focus();
        } else if (data.status === "expired") {
          window.clearInterval(pollTimer);
          waitingEl.classList.add("hidden");
          statusEl.textContent = "That took a while. Tap Text Co again.";
          await prepareCode();
        }
      } catch (err) {
        console.error("Sign-in check failed:", err);
      }
    }, POLL_MS);
  }
  textCoButton.addEventListener("click", (e) => {
    if (textCoButton.getAttribute("aria-disabled") === "true") {
      e.preventDefault();
      return;
    }
    waitingEl.classList.remove("hidden");
    statusEl.textContent = "Send the text, then come back here.";
  });
  confirmForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");
    try {
      const data = await (await fetch("/api/login/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: confirmInput.value.trim() }) })).json();
      if (data.status === "signed_in") {
        statusEl.textContent = "Signed in.";
        window.location.href = "/phone";
      } else if (data.status === "wrong") {
        showError("That code doesn't match. Check the text from Co and try again.");
      } else {
        confirmForm.classList.add("hidden");
        textCoButton.classList.remove("hidden");
        statusEl.textContent = "That code expired. Enter your number to start again.";
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  });
  phoneForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    phone = phoneInput.value.trim();
    if (!phone) return;
    await prepareCode();
    if (errorEl.classList.contains("hidden")) statusEl.textContent = "Now text Co from that phone.";
  });
  (async () => {
    await redirectIfAlreadyLoggedIn();
  })();
})();
