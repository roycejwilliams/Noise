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

// Promises made vs kept, per goal (team only, from the decision log).
type PromiseRow = { member: string; goalId: number | null; goal: string; made: number; kept: number; partial: number; missed: number; admitted: number; released: number; open: number; slipped: number; lastAt: string };
const promisesStatus = document.getElementById("promises-status") as HTMLElement | null;
const promisesTable = document.getElementById("promises") as HTMLTableElement | null;
async function loadPromises() {
  if (!promisesStatus || !promisesTable) return;
  const res = await fetch("/api/sweeps/promises?days=30", { credentials: "same-origin" });
  if (!res.ok) {
    promisesStatus.textContent = res.status === 404 ? "Not available." : "Couldn't load promises.";
    return;
  }
  const { rows } = (await res.json()) as { rows: PromiseRow[] };
  if (!rows.length) {
    promisesStatus.textContent = "No commitments logged in the last 30 days.";
    return;
  }
  const sum = (k: keyof PromiseRow) => rows.reduce((n, r) => n + (r[k] as number), 0);
  const made = sum("made");
  const kept = sum("kept");
  const missed = sum("missed");
  promisesStatus.textContent = `${made} made, ${kept} kept, ${sum("partial")} partial, ${missed} missed (${sum("admitted")} admitted), ${sum("open")} open, ${sum("slipped")} slips${made ? ` (${Math.round((kept / Math.max(1, made - sum("open") - sum("released"))) * 100)}% kept of those settled)` : ""}`;
  let html = `<thead><tr><th>Member</th><th>Goal</th><th>Made</th><th>Kept</th><th>Partial</th><th>Missed</th><th>Released</th><th>Open</th><th>Slips</th><th>Last</th></tr></thead><tbody>`;
  for (const r of rows) {
    const bad = r.missed > 0;
    html += `<tr><td>${esc(r.member)}</td><td>${esc(r.goal)}</td><td class="num">${r.made}</td><td class="num">${r.kept}</td><td class="num">${r.partial}</td><td class="num">${bad ? `<span class="pill pill-bad">${r.missed}</span>${r.admitted ? ` <span class="detail">(${r.admitted} admitted)</span>` : ""}` : r.missed}</td><td class="num">${r.released}</td><td class="num">${r.open}</td><td class="num">${r.slipped}</td><td class="detail">${esc(r.lastAt.slice(0, 16).replace("T", " "))}</td></tr>`;
  }
  promisesTable.innerHTML = html + "</tbody>";
}
loadPromises().catch(() => {
  if (promisesStatus) promisesStatus.textContent = "Couldn't load promises.";
});
