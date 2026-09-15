// Text-to-sign-in: get a short code, open iMessage prefilled with it, and
// poll until that text reaches Co (see routes/login.ts and
// api/src/services/textLogin.ts). Texting first is also what lets Co text
// the tester back on co-test's inbound-only Sendblue plan.
const statusEl = document.getElementById("login-status") as HTMLElement;
const textCoButton = document.getElementById("text-co-button") as HTMLAnchorElement;
const waitingEl = document.getElementById("login-waiting") as HTMLElement;
const desktopEl = document.getElementById("login-desktop") as HTMLElement;
const messageEl = document.getElementById("login-message") as HTMLElement;
const numberEl = document.getElementById("login-number") as HTMLElement;
const errorEl = document.getElementById("login-error") as HTMLElement;

const POLL_MS = 2000;
let pollTimer: number | null = null;

function formatUs(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

function showError(message: string) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

async function redirectIfAlreadyLoggedIn(): Promise<boolean> {
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
    // iOS and Android use different separators before body= on sms: links.
    const separator = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "&" : "?";
    textCoButton.href = `sms:${data.text_in_number}${separator}body=${encodeURIComponent(message)}`;
    textCoButton.removeAttribute("aria-disabled");
    messageEl.textContent = `"${message}"`;
    numberEl.textContent = formatUs(data.text_in_number);
    if (!/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) desktopEl.classList.remove("hidden");
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
        window.clearInterval(pollTimer!);
        statusEl.textContent = "Signed in.";
        window.location.href = "/phone";
      } else if (data.status === "expired") {
        window.clearInterval(pollTimer!);
        waitingEl.classList.add("hidden");
        statusEl.textContent = "That code expired. Here's a new one.";
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

(async () => {
  if (!(await redirectIfAlreadyLoggedIn())) await prepareCode();
})();
