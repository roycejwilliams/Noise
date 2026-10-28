import { renderSidebar } from "./sidebar.js";

renderSidebar("sweeps");

// incomplete / failed / placesDown / unverified (2026-10-28): asks and goals a timed-out place left incomplete, ones that failed, places
// down in a way a retry won't fix (a key, credit, a cap: shown, never retried), and web results dropped at the check against their own
// page, in the day's last run (api dailySweep.ts RollupRow). Older rows lack them.
type Row = { day: string; name: string; status: string; detail: string; asksSearched: number; goalsSearched: number; kept: number; queued: number; sends: number; incomplete?: number; failed?: number; placesDown?: number; unverified?: number };

const statusEl = document.getElementById("status") as HTMLElement;
const table = document.getElementById("sweeps") as HTMLTableElement;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const flag = (n: number) => (n > 0 ? `<span class="pill pill-bad">${n}</span>` : "0");
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
  const bad = rows.filter((r) => ["error", "missed", "silent"].includes(r.status) || (r.incomplete ?? 0) > 0 || (r.failed ?? 0) > 0 || (r.placesDown ?? 0) > 0).length;
  statusEl.textContent = bad ? `${bad} day(s) need a look` : "Every day ran";
  let html = `<thead><tr><th>Member</th><th>Ran</th><th>Asks searched</th><th>Goals searched</th><th>Finds kept</th><th>Queued</th><th>Sends</th><th>Incomplete</th><th>Failed</th><th>Places down</th><th>Web dropped unverified</th><th>Why</th></tr></thead><tbody>`;
  let day = "";
  for (const r of rows) {
    if (r.day !== day) {
      day = r.day;
      html += `<tr class="sweeps-day"><td colspan="12">${esc(day)}</td></tr>`;
    }
    html += `<tr><td>${esc(r.name)}</td><td>${pill(r.status)}</td><td class="num">${r.asksSearched}</td><td class="num">${r.goalsSearched}</td><td class="num">${r.kept}</td><td class="num">${r.queued}</td><td class="num">${r.sends}</td><td class="num">${flag(r.incomplete ?? 0)}</td><td class="num">${flag(r.failed ?? 0)}</td><td class="num">${flag(r.placesDown ?? 0)}</td><td class="num">${r.unverified ?? 0}</td><td class="detail">${esc(r.detail)}</td></tr>`;
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

// Possible legacy flips (team only, read-only): asks the old morning job may have switched off.
type FlipRow = { firstName: string; text: string; createdAt: string; checkedAt: string };
const flipsStatus = document.getElementById("flips-status") as HTMLElement | null;
const flipsTable = document.getElementById("flips") as HTMLTableElement | null;
async function loadFlips() {
  if (!flipsStatus || !flipsTable) return;
  const res = await fetch("/api/sweeps/legacy-flips", { credentials: "same-origin" });
  if (!res.ok) {
    flipsStatus.textContent = res.status === 404 ? "Not available." : "Couldn't load the list.";
    return;
  }
  const { rows } = (await res.json()) as { rows: FlipRow[] };
  flipsStatus.textContent = rows.length ? `${rows.length} possible` : "None found.";
  if (!rows.length) return;
  let html = `<thead><tr><th>Member</th><th>Ask</th><th>Made</th><th>Marked</th></tr></thead><tbody>`;
  for (const r of rows) html += `<tr><td>${esc(r.firstName)}</td><td>${esc(r.text)}</td><td class="detail">${esc(r.createdAt.slice(0, 10))}</td><td class="detail">${esc(r.checkedAt.slice(0, 10))}</td></tr>`;
  flipsTable.innerHTML = html + "</tbody>";
}
loadFlips().catch(() => {
  if (flipsStatus) flipsStatus.textContent = "Couldn't load the list.";
});

// Own work with no task (team only, read-only): searched meanwhile, listed so someone can decide.
type OwnWorkRow = { what: string; firstName: string; text: string; work: string | null; at: string };
const ownStatus = document.getElementById("ownwork-status") as HTMLElement | null;
const ownTable = document.getElementById("ownwork") as HTMLTableElement | null;
async function loadOwnWork() {
  if (!ownStatus || !ownTable) return;
  const res = await fetch("/api/sweeps/own-work", { credentials: "same-origin" });
  if (!res.ok) {
    ownStatus.textContent = res.status === 404 ? "Not available." : "Couldn't load the list.";
    return;
  }
  const { rows } = (await res.json()) as { rows: OwnWorkRow[] };
  ownStatus.textContent = rows.length ? `${rows.length} in the last week` : "None in the last week.";
  if (!rows.length) return;
  let html = `<thead><tr><th>Member</th><th>What</th><th>Request</th><th>Work part</th><th>Last seen</th></tr></thead><tbody>`;
  for (const r of rows) html += `<tr><td>${esc(r.firstName)}</td><td>${esc(r.what)}</td><td>${esc(r.text)}</td><td class="detail">${esc(r.work ?? "")}</td><td class="detail">${esc(r.at.slice(0, 10))}</td></tr>`;
  ownTable.innerHTML = html + "</tbody>";
}
loadOwnWork().catch(() => {
  if (ownStatus) ownStatus.textContent = "Couldn't load the list.";
});

// When members engage (team only, measure only): nothing reads this to time a send.
type RhythmRow = { name: string; zone: string; started: number; byHour: number[]; byWeekday: number[]; peakHours: string | null; peakDay: string | null; proactive: number; replied: number; medianReplyMin: number | null };
const rhythmStatus = document.getElementById("rhythm-status") as HTMLElement | null;
const rhythmTable = document.getElementById("rhythm") as HTMLTableElement | null;
const mins = (m: number | null) => (m === null ? "" : m < 90 ? `${m} min` : `${Math.round(m / 60)} h`);
async function loadRhythm() {
  if (!rhythmStatus || !rhythmTable) return;
  const res = await fetch("/api/sweeps/rhythm?days=28", { credentials: "same-origin" });
  if (!res.ok) {
    rhythmStatus.textContent = res.status === 404 ? "Not available." : "Couldn't load the rhythm view.";
    return;
  }
  const { rows } = (await res.json()) as { rows: RhythmRow[] };
  rhythmStatus.textContent = rows.length ? `${rows.length} member(s) with texts in the last 28 days` : "No texts in the last 28 days.";
  if (!rows.length) return;
  let html = `<thead><tr><th>Member</th><th>Opened</th><th>Busiest hours</th><th>Busiest day</th><th>Cue texted first</th><th>Texted back</th><th>Median wait</th><th>Zone</th></tr></thead><tbody>`;
  for (const r of rows) html += `<tr><td>${esc(r.name)}</td><td class="num">${r.started}</td><td>${esc(r.peakHours ?? "too few to say")}</td><td>${esc(r.peakDay ?? "")}</td><td class="num">${r.proactive}</td><td class="num">${r.replied}</td><td class="num">${esc(mins(r.medianReplyMin))}</td><td class="detail">${esc(r.zone)}</td></tr>`;
  rhythmTable.innerHTML = html + "</tbody>";
}
loadRhythm().catch(() => {
  if (rhythmStatus) rhythmStatus.textContent = "Couldn't load the rhythm view.";
});

// Cue's failures per day (team only): members, the team and test members apart (api/src/harness/failureCount.ts).
type Trio = { member: number; team: number; test: number };
type FailureRow = { day: string; fallbacks: Trio; cuts: Trio; redrafted: Trio; noHelp: Trio; membersHit: number; memberTexts: number };
const failuresStatus = document.getElementById("failures-status") as HTMLElement | null;
const failuresTable = document.getElementById("failures") as HTMLTableElement | null;
const trio = (t: Trio) => `${t.member} / ${t.team} / ${t.test}`;
async function loadFailures() {
  if (!failuresStatus || !failuresTable) return;
  const res = await fetch("/api/sweeps/failures?days=14", { credentials: "same-origin" });
  if (!res.ok) {
    failuresStatus.textContent = res.status === 404 ? "Not available." : "Couldn't load the failures view.";
    return;
  }
  const { rows } = (await res.json()) as { rows: FailureRow[] };
  failuresStatus.textContent = "Each cell is members / team / test members. The last 14 days, newest first.";
  let html = `<thead><tr><th>Day</th><th>Members hit</th><th>Fallback lines</th><th>No reply at all</th><th>Couldn't help</th><th>Redrafted fine</th><th>Member texts</th></tr></thead><tbody>`;
  for (const r of rows) {
    const bad = r.memberTexts > 0 && r.membersHit > 0;
    html += `<tr><td>${esc(r.day)}</td><td class="num">${bad ? `<span class="pill pill-bad">${r.membersHit}</span>` : r.membersHit}</td><td class="num">${trio(r.fallbacks)}</td><td class="num">${trio(r.cuts)}</td><td class="num">${trio(r.noHelp)}</td><td class="num">${trio(r.redrafted)}</td><td class="num">${r.memberTexts}</td></tr>`;
  }
  failuresTable.innerHTML = html + "</tbody>";
}
loadFailures().catch(() => {
  if (failuresStatus) failuresStatus.textContent = "Couldn't load the failures view.";
});

// ---------------------------------------------------------------- trace text (api/src/services/llmTraceText.ts)
type TraceRow = { spanId: string; userId: string | null; functionId: string; createdAt: string; input: string | null; output: string | null };
const traceForm = document.getElementById("trace-form") as HTMLFormElement | null;
const traceInput = document.getElementById("trace-id") as HTMLInputElement | null;
const traceStatus = document.getElementById("trace-status") as HTMLElement | null;
const traceRows = document.getElementById("trace-rows") as HTMLElement | null;
const pretty = (t: string | null) => {
  if (t == null) return "(none)";
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
};
async function loadTrace(id: string) {
  if (!traceStatus || !traceRows) return;
  traceRows.innerHTML = "";
  traceStatus.textContent = "Loading…";
  const res = await fetch(`/api/sweeps/trace/${encodeURIComponent(id)}`, { credentials: "same-origin" });
  const body = (await res.json().catch(() => ({}))) as { rows?: TraceRow[]; error?: string; retentionDays?: number };
  if (!res.ok) {
    traceStatus.textContent = res.status === 404 ? "Not available." : body.error ?? "Couldn't read the trace text.";
    return;
  }
  const rows = body.rows ?? [];
  if (!rows.length) {
    traceStatus.textContent = `Nothing stored for that trace: older than ${body.retentionDays ?? 14} days, removed with the member, or the call kept no text.`;
    return;
  }
  traceStatus.textContent = `${rows.length} model request(s)`;
  traceRows.innerHTML = rows
    .map((r, i) => `<div class="trace-row"><h3>${i + 1}. ${esc(r.functionId)} · ${esc(new Date(r.createdAt).toLocaleString())} · span ${esc(r.spanId)}${r.userId ? ` · user ${esc(r.userId)}` : " · no user"}</h3><div>Prompt</div><pre>${esc(pretty(r.input))}</pre><div>Answer</div><pre>${esc(pretty(r.output))}</pre></div>`)
    .join("");
}
traceForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = (traceInput?.value ?? "").trim();
  if (id) {
    history.replaceState(null, "", `?trace=${encodeURIComponent(id)}`);
    loadTrace(id).catch(() => traceStatus && (traceStatus.textContent = "Couldn't read the trace text."));
  }
});
{
  const fromUrl = new URLSearchParams(location.search).get("trace");
  if (fromUrl && traceInput) {
    traceInput.value = fromUrl;
    loadTrace(fromUrl).catch(() => traceStatus && (traceStatus.textContent = "Couldn't read the trace text."));
  }
}
