// Text-to-sign-in: get a short code, open iMessage prefilled with it, and
// poll until that text reaches Co (see routes/login.ts and
// api/src/services/textLogin.ts). Texting first is also what lets Co text
// the tester back on co-test's inbound-only Sendblue plan. The number is
// typed first: the code only counts when it's texted from that number.
const statusEl = document.getElementById("login-status") as HTMLElement;
const textCoButton = document.getElementById("text-co-button") as HTMLAnchorElement;
const waitingEl = document.getElementById("login-waiting") as HTMLElement;
const errorEl = document.getElementById("login-error") as HTMLElement;
const phoneForm = document.getElementById("login-phone-form") as HTMLFormElement;
const phoneInput = document.getElementById("login-phone") as HTMLInputElement;

const POLL_MS = 2000;
let pollTimer: number | null = null;

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

let phone = "";

async function prepareCode() {
  errorEl.classList.add("hidden");
  try {
    const data = await (
      await fetch("/api/login/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) })
    ).json();
    if (!data.success && data.error) throw new Error(data.error);
    if (!data.success || !data.text_in_number) throw new Error("Couldn't start sign-in. Refresh to try again.");
    const message = `Hi Co! (test site code: ${data.code})`;
    // iOS and Android use different separators before body= on sms: links.
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
        window.clearInterval(pollTimer!);
        statusEl.textContent = "Signed in.";
        window.location.href = "/phone";
      } else if (data.status === "expired") {
        window.clearInterval(pollTimer!);
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

phoneForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  phone = phoneInput.value.trim();
  if (!phone) return;
  await prepareCode();
  if (errorEl.classList.contains("hidden")) statusEl.textContent = "Now text Co from that phone.";
});

// The code only ever lives in the iMessage prefill, never on screen, so
// nobody looking at the page can see or use it. The button always shows:
// phones and Macs both open Messages from an sms: link.
(async () => {
  await redirectIfAlreadyLoggedIn();
})();
