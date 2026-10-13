import { renderSidebar } from "./sidebar.js";

renderSidebar("sweeps");

type Row = { day: string; name: string; status: string; detail: string; asksSearched: number; goalsSearched: number; kept: number; queued: number; sends: number };

const statusEl = document.getElementById("status") as HTMLElement;
const table = document.getElementById("sweeps") as HTMLTableElement;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pill = (s: string) => `<span class="pill ${s === "ran" ? "pill-ran" : s === "error" || s === "missed" || s === "silent" ? "pill-bad" : "pill-quiet"}">${esc(s)}</span>`;

async function load() {
  const res = await fetch("/api/sweeps?days=14", { credentials: "same-origin" });
  if (!res.ok) {
    statusEl.textContent = res.status === 404 ? "Not available." : "Couldn't load the rollup.";
    return;
  }
  const { rows } = (await res.json()) as { rows: Row[] };
  if (!rows.length) {
    statusEl.textContent = "No daily sweep has run yet.";
    return;
  }
  const bad = rows.filter((r) => ["error", "missed", "silent"].includes(r.status)).length;
  statusEl.textContent = bad ? `${bad} day(s) need a look` : "Every day ran";
  let html = `<thead><tr><th>Member</th><th>Ran</th><th>Asks searched</th><th>Goals searched</th><th>Finds kept</th><th>Queued</th><th>Sends</th><th>Why</th></tr></thead><tbody>`;
  let day = "";
  for (const r of rows) {
    if (r.day !== day) {
      day = r.day;
      html += `<tr class="sweeps-day"><td colspan="8">${esc(day)}</td></tr>`;
    }
    html += `<tr><td>${esc(r.name)}</td><td>${pill(r.status)}</td><td class="num">${r.asksSearched}</td><td class="num">${r.goalsSearched}</td><td class="num">${r.kept}</td><td class="num">${r.queued}</td><td class="num">${r.sends}</td><td class="detail">${esc(r.detail)}</td></tr>`;
  }
  table.innerHTML = html + "</tbody>";
}

load().catch(() => {
  statusEl.textContent = "Couldn't load the rollup.";
});
