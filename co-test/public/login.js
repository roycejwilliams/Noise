"use strict";
(() => {
  // src/client/login.ts
  var statusEl = document.getElementById("login-status");
  var textCoButton = document.getElementById("text-co-button");
  var waitingEl = document.getElementById("login-waiting");
  var desktopEl = document.getElementById("login-desktop");
  var errorEl = document.getElementById("login-error");
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
  async function prepareCode() {
    errorEl.classList.add("hidden");
    try {
      const data = await (await fetch("/api/login/start", { method: "POST" })).json();
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
        if (data.status === "signed_in") {
          window.clearInterval(pollTimer);
          statusEl.textContent = "Signed in.";
          window.location.href = "/phone";
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
  var isPhone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  (async () => {
    if (await redirectIfAlreadyLoggedIn()) return;
    if (!isPhone) {
      textCoButton.classList.add("hidden");
      statusEl.textContent = "Sign in from your phone.";
      desktopEl.classList.remove("hidden");
      return;
    }
    await prepareCode();
  })();
})();
