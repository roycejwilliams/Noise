import { downloadJson, renderCards, renderTranscriptList, TranscriptMessage } from "./shared.js";
import { renderSidebar } from "./sidebar.js";

renderSidebar("results");

const statusEl = document.getElementById("status") as HTMLElement;
const emptyState = document.getElementById("empty-state") as HTMLElement;
const emptyMessage = document.getElementById("empty-message") as HTMLElement;
const extractionSection = document.getElementById("extraction-section") as HTMLElement;
const cardsGrid = document.getElementById("cards-grid") as HTMLElement;
const rawOutputEl = document.getElementById("raw-output") as HTMLElement;
const transcriptList = document.getElementById("transcript-list") as HTMLElement;
const downloadButton = document.getElementById("download-json") as HTMLButtonElement;
const coverageSection = document.getElementById("coverage-section") as HTMLElement;
const coverageChart = document.getElementById("coverage-chart") as HTMLElement;
const coverageTableBody = document.getElementById("coverage-table-body") as HTMLTableSectionElement;
const channelBadge = document.getElementById("channel-badge") as HTMLElement;
const testCaseSelect = document.getElementById("test-case-select") as HTMLSelectElement;
const testCaseSaved = document.getElementById("test-case-saved") as HTMLElement;
const latencySection = document.getElementById("latency-section") as HTMLElement;
const latencyTableBody = document.getElementById("latency-table-body") as HTMLTableSectionElement;
const imessageThreadDetails = document.getElementById("imessage-thread-details") as HTMLElement;
const imessageThreadList = document.getElementById("imessage-thread-list") as HTMLElement;

type CoverageCheck = {
  call_number: number;
  timestamp: string;
  missing_topics: string[];
  covered_topics: string[];
  ready_to_summarize: boolean;
  latency_ms: number;
};

type StoredResult = {
  profile: any;
  intent: any;
  raw_model_output: string;
  transcript: string;
  messages: TranscriptMessage[];
  coverage_history?: CoverageCheck[];
  turn_latency_ms?: { turn: number; latency_ms: number }[];
  channel?: "browser" | "phone";
  test_case?: "intent_layer" | null;
  imessage_thread?: TranscriptMessage[];
};

const SVG_NS = "http://www.w3.org/2000/svg";

// Single-series bar chart of tool-call latency, in call order. No legend
// (one series — the section title already says what's plotted); the max bar
// gets a direct label, the rest live in the hover tooltip and the table
// below (same values, so nothing is gated behind hover).
function renderLatencyChart(container: HTMLElement, checks: CoverageCheck[]) {
  container.innerHTML = "";

  const barWidth = 20;
  const gap = 22;
  const chartHeight = 120;
  const leftPad = 34;
  const bottomPad = 22;
  const topPad = 22;
  const width = leftPad + checks.length * (barWidth + gap);
  const height = topPad + chartHeight + bottomPad;

  const maxLatency = Math.max(...checks.map((c) => c.latency_ms), 1);
  const niceMax = Math.ceil(maxLatency / 250) * 250 || 250;
  const scaleY = (ms: number) => (ms / niceMax) * chartHeight;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.classList.add("coverage-chart-svg");

  // Gridlines at 0%, 50%, 100% of scale — recessive hairlines, with the top
  // one labeled so the max bar's direct label has a reference.
  for (const frac of [0, 0.5, 1]) {
    const y = topPad + chartHeight - chartHeight * frac;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(leftPad - 8));
    line.setAttribute("x2", String(width));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.classList.add("coverage-chart-gridline");
    svg.appendChild(line);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(leftPad - 12));
    label.setAttribute("y", String(y + 4));
    label.setAttribute("text-anchor", "end");
    label.classList.add("coverage-chart-axis-label");
    label.textContent = `${Math.round(niceMax * frac)}`;
    svg.appendChild(label);
  }

  const tooltip = document.createElement("div");
  tooltip.className = "coverage-chart-tooltip";
  tooltip.hidden = true;
  container.style.position = "relative";

  const maxCheck = checks.reduce((a, b) => (b.latency_ms > a.latency_ms ? b : a));

  checks.forEach((check, i) => {
    const x = leftPad + i * (barWidth + gap);
    const barHeight = Math.max(2, scaleY(check.latency_ms));
    const y = topPad + chartHeight - barHeight;

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(barWidth));
    rect.setAttribute("height", String(barHeight));
    rect.setAttribute("rx", "4");
    // Square the bottom corners against the baseline — rx rounds all four,
    // so clip the bottom half of the radius with a second flat rect union
    // isn't needed here since 4px on a ≥2px-tall bar reads fine, but for
    // very short bars keep the radius from exceeding half the height.
    if (barHeight < 8) rect.setAttribute("rx", String(barHeight / 2));
    rect.classList.add("coverage-chart-bar");
    rect.tabIndex = 0;
    rect.setAttribute("role", "img");
    rect.setAttribute(
      "aria-label",
      `Check ${check.call_number}: ${check.latency_ms} milliseconds`,
    );

    const showTooltip = () => {
      tooltip.innerHTML = "";
      const value = document.createElement("div");
      value.className = "coverage-chart-tooltip-value";
      value.textContent = `${check.latency_ms}ms`;
      const label2 = document.createElement("div");
      label2.className = "coverage-chart-tooltip-label";
      label2.textContent = `Check #${check.call_number}`;
      tooltip.append(value, label2);
      tooltip.hidden = false;
      tooltip.style.left = `${x + barWidth / 2}px`;
      tooltip.style.top = `${y - 8}px`;
      rect.classList.add("hovered");
    };
    const hideTooltip = () => {
      tooltip.hidden = true;
      rect.classList.remove("hovered");
    };

    rect.addEventListener("pointerenter", showTooltip);
    rect.addEventListener("pointerleave", hideTooltip);
    rect.addEventListener("focus", showTooltip);
    rect.addEventListener("blur", hideTooltip);

    svg.appendChild(rect);

    // Label the extreme only — per-bar labels would be chaos with more than
    // a couple of checks, and the table below carries every exact value.
    if (check === maxCheck) {
      const valueLabel = document.createElementNS(SVG_NS, "text");
      valueLabel.setAttribute("x", String(x + barWidth / 2));
      valueLabel.setAttribute("y", String(y - 6));
      valueLabel.setAttribute("text-anchor", "middle");
      valueLabel.classList.add("coverage-chart-value-label");
      valueLabel.textContent = `${check.latency_ms}ms`;
      svg.appendChild(valueLabel);
    }

    const xLabel = document.createElementNS(SVG_NS, "text");
    xLabel.setAttribute("x", String(x + barWidth / 2));
    xLabel.setAttribute("y", String(topPad + chartHeight + 16));
    xLabel.setAttribute("text-anchor", "middle");
    xLabel.classList.add("coverage-chart-axis-label");
    xLabel.textContent = `#${check.call_number}`;
    svg.appendChild(xLabel);
  });

  container.append(svg, tooltip);
}

function renderCoverageTable(tbody: HTMLTableSectionElement, checks: CoverageCheck[]) {
  tbody.innerHTML = "";
  for (const check of checks) {
    const row = document.createElement("tr");

    const cells = [
      `#${check.call_number}`,
      new Date(check.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      `${check.latency_ms}ms`,
      `${check.covered_topics.length}/9`,
      check.ready_to_summarize ? "Yes" : "No",
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
}

function renderCoverageSection(checks: CoverageCheck[]) {
  if (!checks.length) {
    coverageSection.classList.add("hidden");
    return;
  }
  coverageSection.classList.remove("hidden");
  renderLatencyChart(coverageChart, checks);
  renderCoverageTable(coverageTableBody, checks);
}

function renderLatencySection(turns: { turn: number; latency_ms: number }[]) {
  if (!turns.length) {
    latencySection.classList.add("hidden");
    return;
  }
  latencySection.classList.remove("hidden");
  latencyTableBody.innerHTML = "";
  for (const t of turns) {
    const row = document.createElement("tr");
    const turnCell = document.createElement("td");
    turnCell.textContent = `#${t.turn}`;
    const latencyCell = document.createElement("td");
    latencyCell.textContent = `${t.latency_ms}ms`;
    row.append(turnCell, latencyCell);
    latencyTableBody.appendChild(row);
  }
}

function renderImessageThread(thread: TranscriptMessage[]) {
  if (!thread.length) {
    imessageThreadDetails.classList.add("hidden");
    return;
  }
  imessageThreadDetails.classList.remove("hidden");
  renderTranscriptList(imessageThreadList, thread);
}

function renderChannelBadge(channel: string | undefined) {
  const label = channel === "phone" ? "Real phone call" : "Browser (direct EVI)";
  channelBadge.textContent = label;
  channelBadge.classList.toggle("phone", channel === "phone");
}

function wireTestCaseSelect(sessionId: string, currentValue: string | null | undefined) {
  testCaseSelect.value = currentValue ?? "";
  testCaseSelect.addEventListener("change", async () => {
    if (!testCaseSelect.value) return;
    try {
      const res = await fetch(`/api/session/${sessionId}/tag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test_case: testCaseSelect.value }),
      });
      const json = await res.json();
      if (json.success) {
        testCaseSaved.classList.remove("hidden");
        window.setTimeout(() => testCaseSaved.classList.add("hidden"), 1500);
      }
    } catch (err) {
      console.error("Failed to save test case tag:", err);
    }
  });
}

function getSessionId(): string | null {
  const match = window.location.pathname.match(/^\/call\/([^/]+)\/results\/?$/);
  return match ? match[1] : null;
}

function showEmptyState(message: string) {
  emptyMessage.textContent = message;
  emptyState.classList.remove("hidden");
  extractionSection.classList.add("hidden");
}

async function load() {
  const sessionId = getSessionId();
  if (!sessionId) {
    statusEl.textContent = "Invalid session";
    showEmptyState("This isn't a valid session link.");
    return;
  }

  try {
    const res = await fetch(`/api/session/${sessionId}/results`);
    const json = await res.json();

    if (!json.success) {
      statusEl.textContent = "Error";
      showEmptyState("Something went wrong loading this session.");
      return;
    }

    if (json.status === "not_found") {
      statusEl.textContent = "Not found";
      showEmptyState("No session found for this link.");
      return;
    }

    if (json.status === "not_ready") {
      statusEl.textContent = "Not ready";
      showEmptyState("This call hasn't finished yet — no extraction is available for it.");
      return;
    }

    const data: StoredResult = json.data;
    statusEl.textContent = "Ready";
    emptyState.classList.add("hidden");
    extractionSection.classList.remove("hidden");

    renderCards(cardsGrid, data.profile, data.intent);
    renderChannelBadge(data.channel);
    wireTestCaseSelect(sessionId, data.test_case);
    renderLatencySection(data.turn_latency_ms ?? []);
    renderCoverageSection(data.coverage_history ?? []);
    renderImessageThread(data.imessage_thread ?? []);
    rawOutputEl.textContent = JSON.stringify(data, null, 2);
    renderTranscriptList(transcriptList, data.messages ?? []);

    downloadButton.addEventListener("click", () => {
      downloadJson(data, "co-profile.json");
    });
  } catch (err) {
    console.error("Failed to load results:", err);
    statusEl.textContent = "Error";
    showEmptyState("Something went wrong loading this session.");
  }
}

load();
