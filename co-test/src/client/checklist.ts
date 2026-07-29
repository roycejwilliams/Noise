const statusEl = document.getElementById("status") as HTMLElement;
const autoList = document.getElementById("auto-list") as HTMLElement;
const manualList = document.getElementById("manual-list") as HTMLElement;

type ChecklistItem = {
  key: string;
  label: string;
  category: "auto" | "manual";
  test_case: "intent_layer" | "circles" | "both";
  // auto
  computed?: boolean;
  value?: string | null;
  // manual
  filled_in?: boolean;
  updated_at?: string | null;
};

function testCaseBadge(testCase: string): string {
  const label = testCase === "both" ? "Both" : testCase === "intent_layer" ? "Intent Layer" : "Circles";
  return `<span class="test-case-chip test-case-${testCase}">${label}</span>`;
}

function renderAutoItem(item: ChecklistItem): HTMLElement {
  const row = document.createElement("div");
  row.className = `checklist-item ${item.computed ? "checklist-item-done" : "checklist-item-pending"}`;
  row.innerHTML = `
    <div class="checklist-item-header">
      <span class="checklist-item-label">${item.label}</span>
      ${testCaseBadge(item.test_case)}
    </div>
    <div class="checklist-item-value">
      <span class="checklist-status-dot"></span>
      ${item.value ?? ""}
    </div>
  `;
  return row;
}

function renderManualItem(item: ChecklistItem): HTMLElement {
  const row = document.createElement("div");
  row.className = `checklist-item ${item.filled_in ? "checklist-item-done" : "checklist-item-awaiting"}`;

  const header = document.createElement("div");
  header.className = "checklist-item-header";
  header.innerHTML = `
    <span class="checklist-item-label">${item.label}</span>
    ${testCaseBadge(item.test_case)}
  `;
  row.appendChild(header);

  const valueRow = document.createElement("div");
  valueRow.className = "checklist-item-value";
  valueRow.innerHTML = `
    <span class="checklist-status-dot"></span>
    ${item.filled_in ? item.value : '<span class="checklist-awaiting-label">Awaiting input</span>'}
  `;
  row.appendChild(valueRow);

  const form = document.createElement("div");
  form.className = "checklist-form";
  const textarea = document.createElement("textarea");
  textarea.className = "checklist-textarea";
  textarea.placeholder = item.filled_in ? "Update this answer…" : "Enter your answer…";
  textarea.value = item.filled_in ? (item.value ?? "") : "";
  const saveButton = document.createElement("button");
  saveButton.className = "download-button";
  saveButton.textContent = item.filled_in ? "Update" : "Save";
  saveButton.addEventListener("click", async () => {
    const value = textarea.value.trim();
    if (!value) return;
    saveButton.disabled = true;
    try {
      const res = await fetch(`/api/checklist/${item.key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      const json = await res.json();
      if (json.success) await load();
    } catch (err) {
      console.error("Failed to save checklist item:", err);
    } finally {
      saveButton.disabled = false;
    }
  });
  form.append(textarea, saveButton);
  row.appendChild(form);

  return row;
}

async function load() {
  try {
    const res = await fetch("/api/checklist");
    const json = await res.json();
    if (!json.success) throw new Error("Failed to load checklist");

    const items: ChecklistItem[] = json.items;
    const auto = items.filter((i) => i.category === "auto");
    const manual = items.filter((i) => i.category === "manual");

    autoList.innerHTML = "";
    for (const item of auto) autoList.appendChild(renderAutoItem(item));

    manualList.innerHTML = "";
    for (const item of manual) manualList.appendChild(renderManualItem(item));

    const autoDone = auto.filter((i) => i.computed).length;
    const manualDone = manual.filter((i) => i.filled_in).length;
    statusEl.textContent = `${autoDone}/${auto.length} auto-verified computed · ${manualDone}/${manual.length} human-input filled in`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Failed to load checklist";
  }
}

load();

// Circles pipeline test panel — every render/action here is explicitly
// simulated: true, and the buttons only ever call co-test's own internal
// /api/circles-test/* routes, never anything that touches a real Sendblue
// send.
const simStateEl = document.getElementById("sim-state") as HTMLElement;
const simSeedBtn = document.getElementById("sim-seed") as HTMLButtonElement;
const simMatchBtn = document.getElementById("sim-match") as HTMLButtonElement;
const simResetBtn = document.getElementById("sim-reset") as HTMLButtonElement;
const simScenarioSelect = document.getElementById("sim-scenario-select") as HTMLSelectElement;
const simScenarioDescEl = document.getElementById("sim-scenario-desc") as HTMLElement;
const simScenarioResultEl = document.getElementById("sim-scenario-result") as HTMLElement;

type SimMember = { id: string; first_name: string };
type SimCircleMember = { member_id: string; status: string; first_name: string };
type SimMoment = {
  id: string;
  moments_name: string;
  status: string;
  venue: string | null;
  candidate_windows: { label: string }[] | null;
  suggested_time: string | null;
};
type SimMomentResponse = { user_id: string; response: string | null; selected_windows: number[] | null; first_name: string };

type ScenarioCatalogEntry = { id: string; label: string; description: string; expectedNote: string };
type ScenarioRun = {
  scenarioId: string;
  scenarioLabel: string;
  finalScore: number | null;
  consideredCandidates: number;
  memberNames: string[];
  excludedNames: string[];
  rejectionReason: string | null;
  passed: boolean | null;
  expectedNote: string;
  ranAt: string;
};

let scenarioCatalog: ScenarioCatalogEntry[] = [];

async function loadScenarioCatalog() {
  try {
    const json = await (await fetch("/api/circles-test/scenarios")).json();
    if (!json.success) return;
    scenarioCatalog = json.scenarios;
    for (const s of scenarioCatalog) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.id} — ${s.label}`;
      simScenarioSelect.appendChild(opt);
    }
    updateScenarioDesc();
  } catch (err) {
    console.error("Failed to load scenario catalog:", err);
  }
}

function updateScenarioDesc() {
  const selected = scenarioCatalog.find((s) => s.id === simScenarioSelect.value);
  simScenarioDescEl.textContent = selected
    ? `${selected.description} Expected: ${selected.expectedNote}`
    : "Randomized, varied-but-compatible profiles — good for general stress-testing, not a known-answer check.";
}

simScenarioSelect.addEventListener("change", updateScenarioDesc);

function renderScenarioResult(run: ScenarioRun | null) {
  simScenarioResultEl.innerHTML = "";
  if (!run) return;

  const block = document.createElement("div");
  block.className = "sim-block sim-scenario-block";

  const badgeClass = run.passed === true ? "sim-badge-pass" : run.passed === false ? "sim-badge-fail" : "sim-badge-exploratory";
  const badgeText = run.passed === true ? "PASS" : run.passed === false ? "FAIL" : "EXPLORATORY";

  const scoreText = run.finalScore === null ? "n/a (rejected before scoring)" : run.finalScore.toFixed(3);

  block.innerHTML = `
    <div class="sim-block-title">
      Scenario ${run.scenarioId} — ${run.scenarioLabel}
      <span class="sim-badge ${badgeClass}">${badgeText}</span>
    </div>
    <div class="sim-scenario-row"><span class="sim-scenario-key">Compatibility score</span><span>${scoreText}</span></div>
    <div class="sim-scenario-row"><span class="sim-scenario-key">Candidates considered</span><span>${run.consideredCandidates}</span></div>
    <div class="sim-scenario-row"><span class="sim-scenario-key">Grouped</span><span>${run.memberNames.length ? run.memberNames.join(", ") : "(no circle formed)"}</span></div>
    <div class="sim-scenario-row"><span class="sim-scenario-key">Excluded</span><span>${run.excludedNames.length ? run.excludedNames.join(", ") : "—"}</span></div>
    ${run.rejectionReason ? `<div class="sim-scenario-row"><span class="sim-scenario-key">Rejection reason</span><span>${run.rejectionReason}</span></div>` : ""}
    <div class="sim-scenario-note">Expected: ${run.expectedNote}</div>
  `;
  simScenarioResultEl.appendChild(block);
}

async function simPost(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`/api/circles-test/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function renderSimState(data: {
  members: SimMember[];
  circle: { id: string; circle_name: string; status: string } | null;
  circle_members: SimCircleMember[];
  moment: SimMoment | null;
  moment_responses: SimMomentResponse[];
}) {
  // Step 2 (Run matching) only makes sense once step 1 (Seed) has actually
  // put members in the DB — reflects real state on every load, not just
  // right after clicking Seed, so a page reload doesn't leave it wrongly
  // enabled or disabled.
  simMatchBtn.disabled = data.members.length === 0;

  simStateEl.innerHTML = "";

  if (!data.members.length) {
    const empty = document.createElement("p");
    empty.className = "sim-empty";
    empty.textContent = "No simulated members seeded yet.";
    simStateEl.appendChild(empty);
    return;
  }

  const membersBlock = document.createElement("div");
  membersBlock.className = "sim-block";
  membersBlock.innerHTML = `<div class="sim-block-title">Seeded members (${data.members.length})</div>`;
  for (const m of data.members) {
    const row = document.createElement("div");
    row.className = "sim-member-row";
    const circleStatus = data.circle_members.find((cm) => cm.member_id === m.id)?.status;
    row.innerHTML = `<span class="sim-member-name">${m.first_name}</span><span class="sim-member-status">${circleStatus ?? "not in a circle"}</span>`;
    membersBlock.appendChild(row);
  }
  simStateEl.appendChild(membersBlock);

  if (!data.circle) return;

  const circleBlock = document.createElement("div");
  circleBlock.className = "sim-block";
  circleBlock.innerHTML = `<div class="sim-block-title">${data.circle.circle_name} — ${data.circle.status}</div>`;

  if (data.circle.status === "pending_approval") {
    const row = document.createElement("div");
    row.className = "sim-member-row";
    row.innerHTML = `<span>Moderator decision</span>`;
    const actions = document.createElement("div");
    actions.className = "sim-actions";
    const approve = document.createElement("button");
    approve.className = "sim-btn";
    approve.textContent = "Approve circle";
    approve.onclick = async () => {
      await simPost("moderator-approval", { target: { type: "circle", circleId: data.circle!.id }, action: "approve" });
      loadSimState();
    };
    const reject = document.createElement("button");
    reject.className = "sim-btn sim-btn-reject";
    reject.textContent = "Reject circle";
    reject.onclick = async () => {
      await simPost("moderator-approval", { target: { type: "circle", circleId: data.circle!.id }, action: "reject" });
      loadSimState();
    };
    actions.append(approve, reject);
    row.appendChild(actions);
    circleBlock.appendChild(row);
  } else if (data.circle.status === "active") {
    for (const cm of data.circle_members) {
      const row = document.createElement("div");
      row.className = "sim-member-row";
      row.innerHTML = `<span class="sim-member-name">${cm.first_name}</span><span class="sim-member-status">${cm.status}</span>`;
      if (cm.status === "pending") {
        const actions = document.createElement("div");
        actions.className = "sim-actions";
        const accept = document.createElement("button");
        accept.className = "sim-btn";
        accept.textContent = "Accept";
        accept.onclick = async () => {
          await simPost("circle-response", { circle_id: data.circle!.id, member_id: cm.member_id, action: "accept" });
          loadSimState();
        };
        const decline = document.createElement("button");
        decline.className = "sim-btn sim-btn-reject";
        decline.textContent = "Decline";
        decline.onclick = async () => {
          await simPost("circle-response", { circle_id: data.circle!.id, member_id: cm.member_id, action: "decline" });
          loadSimState();
        };
        actions.append(accept, decline);
        row.appendChild(actions);
      }
      circleBlock.appendChild(row);
    }
  }
  simStateEl.appendChild(circleBlock);

  if (!data.moment) return;

  const momentBlock = document.createElement("div");
  momentBlock.className = "sim-block";
  momentBlock.innerHTML = `<div class="sim-block-title">${data.moment.moments_name} — ${data.moment.status}</div>`;

  if (data.moment.status === "polling" && data.moment.candidate_windows?.length) {
    for (const resp of data.moment_responses) {
      const row = document.createElement("div");
      row.className = "sim-member-row";
      const respondedLabel = resp.selected_windows?.length
        ? resp.selected_windows.map((i) => data.moment!.candidate_windows![i - 1]?.label).join(", ")
        : "no reply yet";
      row.innerHTML = `<span class="sim-member-name">${resp.first_name}</span><span class="sim-member-status">${respondedLabel}</span>`;
      const actions = document.createElement("div");
      actions.className = "sim-actions";
      data.moment.candidate_windows.forEach((w, i) => {
        const btn = document.createElement("button");
        btn.className = "sim-btn";
        btn.textContent = w.label;
        btn.onclick = async () => {
          await simPost("availability-response", {
            moment_id: data.moment!.id,
            member_id: resp.user_id,
            selected_windows: [i + 1],
          });
          loadSimState();
        };
        actions.appendChild(btn);
      });
      row.appendChild(actions);
      momentBlock.appendChild(row);
    }
    const resolveBtn = document.createElement("button");
    resolveBtn.className = "sim-btn";
    resolveBtn.textContent = "Resolve consensus now";
    resolveBtn.style.marginTop = "8px";
    resolveBtn.onclick = async () => {
      await simPost("resolve-consensus", { moment_id: data.moment!.id });
      loadSimState();
    };
    momentBlock.appendChild(resolveBtn);
  } else if (data.moment.status === "pending_venue_approval") {
    const row = document.createElement("div");
    row.className = "sim-member-row";
    row.innerHTML = `<span>Venue: ${data.moment.venue ?? "TBD"} — ${data.moment.suggested_time ?? ""}</span>`;
    const actions = document.createElement("div");
    actions.className = "sim-actions";
    const approve = document.createElement("button");
    approve.className = "sim-btn";
    approve.textContent = "Approve venue";
    approve.onclick = async () => {
      await simPost("moderator-approval", { target: { type: "venue", momentId: data.moment!.id }, action: "approve" });
      loadSimState();
    };
    const reject = document.createElement("button");
    reject.className = "sim-btn sim-btn-reject";
    reject.textContent = "Reject venue";
    reject.onclick = async () => {
      await simPost("moderator-approval", { target: { type: "venue", momentId: data.moment!.id }, action: "reject" });
      loadSimState();
    };
    actions.append(approve, reject);
    row.appendChild(actions);
    momentBlock.appendChild(row);
  } else if (data.moment.status === "confirmed") {
    const row = document.createElement("div");
    row.className = "sim-member-row";
    row.innerHTML = `<span>Confirmed — pipeline resolved end to end.</span>`;
    momentBlock.appendChild(row);
  }
  simStateEl.appendChild(momentBlock);
}

async function loadSimState() {
  try {
    const json = await (await fetch("/api/circles-test/state")).json();
    if (json.success) {
      renderSimState(json);
      renderScenarioResult(json.scenario_run ?? null);
    }
  } catch (err) {
    console.error("Failed to load Circles sim state:", err);
  }
}

simSeedBtn.addEventListener("click", async () => {
  simSeedBtn.disabled = true;
  try {
    const scenario = simScenarioSelect.value || undefined;
    await simPost("seed", scenario ? { scenario } : undefined);
    await loadSimState();
  } finally {
    simSeedBtn.disabled = false;
  }
});

simMatchBtn.addEventListener("click", async () => {
  simMatchBtn.disabled = true;
  try {
    const result = await simPost("match");
    // "No circle formed" can be the scenario's own designed-correct answer
    // (Scenario B) — only alert when there's no scenario result to explain
    // it, so an expected rejection doesn't read as a broken test.
    if (!result.success && !result.scenario) alert(result.error ?? "Matching failed.");
    await loadSimState();
  } finally {
    simMatchBtn.disabled = false;
  }
});

simResetBtn.addEventListener("click", async () => {
  simResetBtn.disabled = true;
  try {
    await simPost("reset");
    await loadSimState();
  } finally {
    simResetBtn.disabled = false;
  }
});

loadScenarioCatalog();
loadSimState();

// Real user vs. filler pool — every render/action here is scoped to
// /api/dynamic-test/*, which only ever touches this feature's own generated
// filler data plus (read-only, or via the one explicit Approve action) the
// current real, OTP-verified phone-test user.
const dynRealUserEl = document.getElementById("dyn-real-user") as HTMLElement;
const dynSeedBtn = document.getElementById("dyn-seed") as HTMLButtonElement;
const dynRunAllBtn = document.getElementById("dyn-run-all") as HTMLButtonElement;
const dynResetBtn = document.getElementById("dyn-reset") as HTMLButtonElement;
const dynResultsEl = document.getElementById("dyn-results") as HTMLElement;
const dynPlacementVariantSelect = document.getElementById("dyn-placement-variant") as HTMLSelectElement;
const dynAttemptPlacementBtn = document.getElementById("dyn-attempt-placement") as HTMLButtonElement;
const dynPlacementStateEl = document.getElementById("dyn-placement-state") as HTMLElement;

type DynamicRealUser = {
  userId: string;
  first_name: string;
  city: string | null;
  life_chapters: string[];
  goals: string[];
  activity_preferences: string[];
  activeAskText: string | null;
  hasSignal: boolean;
};

type DynamicGeneratedProfile = { first_name: string; goals: string[]; activity_preferences: string[]; life_chapters: string[] };

type DynamicRun = {
  variant: "A" | "B" | "C";
  variantLabel: string;
  finalScore: number | null;
  consideredCandidates: number;
  memberNames: string[];
  excludedNames: string[];
  rejectionReason: string | null;
  passed: boolean | null;
  generatedProfiles: DynamicGeneratedProfile[];
  ranAt: string;
};

async function dynFetch(path: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(`/api/dynamic-test/${path}`, opts);
  return res.json();
}

async function dynPost(path: string, body?: unknown): Promise<any> {
  return dynFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function loadDynRealUser(): Promise<DynamicRealUser | null> {
  const json = await dynFetch("real-user");
  const user: DynamicRealUser | null = json.success ? json.user : null;
  if (!user) {
    dynRealUserEl.textContent = "No verified real test user yet — text or call in and complete OTP verification first.";
  } else if (!user.hasSignal) {
    dynRealUserEl.textContent = `Testing against: ${user.first_name} — no captured profile signal yet (no goals/chapters/activities). Have them say more before seeding.`;
  } else {
    const askNote = user.activeAskText ? ` · active ask: "${user.activeAskText}"` : "";
    dynRealUserEl.textContent = `Testing against: ${user.first_name} — ${user.life_chapters.join(", ") || "no chapters"} · ${user.goals.join("; ") || "no goals"}${askNote}`;
  }
  return user;
}

function renderDynamicProfileList(profiles: DynamicGeneratedProfile[], includedNames: string[]): string {
  return profiles
    .map((p) => {
      const included = includedNames.includes(p.first_name);
      return `<div class="dyn-profile-row ${included ? "dyn-profile-included" : "dyn-profile-excluded"}">
        <span class="dyn-profile-name">${p.first_name}${included ? " ✓" : ""}</span>
        <span class="dyn-profile-detail">${p.life_chapters.join(", ")} — ${p.goals.join("; ")}</span>
      </div>`;
    })
    .join("");
}

function renderDynamicRuns(runs: DynamicRun[]) {
  dynResultsEl.innerHTML = "";
  if (!runs.length) {
    const empty = document.createElement("p");
    empty.className = "sim-empty";
    empty.textContent = "No diagnostic runs yet.";
    dynResultsEl.appendChild(empty);
    return;
  }
  for (const run of runs) {
    const badgeClass = run.passed === true ? "sim-badge-pass" : run.passed === false ? "sim-badge-fail" : "sim-badge-exploratory";
    const badgeText = run.passed === true ? "PASS" : run.passed === false ? "FAIL" : "OBSERVE";
    const scoreText = run.finalScore === null ? "n/a (rejected before scoring)" : run.finalScore.toFixed(3);

    const block = document.createElement("div");
    block.className = "sim-block sim-scenario-block";
    block.innerHTML = `
      <div class="sim-block-title">
        Dynamic-${run.variant} — ${run.variantLabel}
        <span class="sim-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="sim-scenario-row"><span class="sim-scenario-key">Compatibility score</span><span>${scoreText}</span></div>
      <div class="sim-scenario-row"><span class="sim-scenario-key">Candidates considered</span><span>${run.consideredCandidates}</span></div>
      ${run.rejectionReason ? `<div class="sim-scenario-row"><span class="sim-scenario-key">Rejection reason</span><span>${run.rejectionReason}</span></div>` : ""}
      <div class="dyn-profile-list">${renderDynamicProfileList(run.generatedProfiles, run.memberNames)}</div>
    `;
    dynResultsEl.appendChild(block);
  }
}

async function loadDynRuns() {
  const json = await dynFetch("runs");
  if (json.success) renderDynamicRuns(json.runs ?? []);
}

type DynPlacementCircle = { id: string; circle_name: string; status: string } | null;
type DynPlacementMember = { member_id: string; status: string; first_name: string; is_simulated: boolean };

function renderDynPlacementState(circle: DynPlacementCircle, members: DynPlacementMember[]) {
  dynPlacementStateEl.innerHTML = "";
  if (!circle) return;

  const block = document.createElement("div");
  block.className = "sim-block";
  block.innerHTML = `<div class="sim-block-title">${circle.circle_name} — ${circle.status}</div>`;

  if (circle.status === "pending_approval") {
    const row = document.createElement("div");
    row.className = "sim-member-row";
    row.innerHTML = `<span>Real circle formed — approving sends a real iMessage to the real member.</span>`;
    const actions = document.createElement("div");
    actions.className = "sim-actions";
    const approve = document.createElement("button");
    approve.className = "sim-btn";
    approve.textContent = "Approve (sends real text)";
    approve.onclick = async () => {
      if (!confirm("This sends a real iMessage to the real test user's real phone number. Continue?")) return;
      approve.disabled = true;
      try {
        const result = await dynPost("approve", { circle_id: circle.id });
        if (!result.success) alert(result.error ?? "Approve failed.");
        await loadDynPlacementState();
      } finally {
        approve.disabled = false;
      }
    };
    const reject = document.createElement("button");
    reject.className = "sim-btn sim-btn-reject";
    reject.textContent = "Reject";
    reject.onclick = async () => {
      await dynPost("reject", { circle_id: circle.id });
      await loadDynPlacementState();
    };
    actions.append(approve, reject);
    row.appendChild(actions);
    block.appendChild(row);
  } else if (circle.status === "active") {
    for (const m of members) {
      const row = document.createElement("div");
      row.className = "sim-member-row";
      row.innerHTML = `<span class="sim-member-name">${m.is_simulated ? m.first_name : `${m.first_name} (real)`}</span><span class="sim-member-status">${m.status}</span>`;
      block.appendChild(row);
    }
  }
  dynPlacementStateEl.appendChild(block);
}

async function loadDynPlacementState() {
  const json = await dynFetch("circle-state");
  if (json.success) renderDynPlacementState(json.circle ?? null, json.circle_members ?? []);
}

// Steps 2/3 only make sense once step 1 (generate filler pools) has
// actually happened — reflects real state on every load, same reasoning as
// the Circles pipeline test's simMatchBtn above.
async function loadDynPoolsState() {
  const json = await dynFetch("pools-state");
  const seeded = json.success && json.seeded;
  dynRunAllBtn.disabled = !seeded;
  dynPlacementVariantSelect.disabled = !seeded;
  dynAttemptPlacementBtn.disabled = !seeded;
}

dynSeedBtn.addEventListener("click", async () => {
  dynSeedBtn.disabled = true;
  try {
    const result = await dynPost("seed");
    if (!result.success) alert(result.error ?? "Seeding failed.");
    await loadDynRealUser();
    await loadDynPoolsState();
  } finally {
    dynSeedBtn.disabled = false;
  }
});

dynRunAllBtn.addEventListener("click", async () => {
  dynRunAllBtn.disabled = true;
  try {
    const result = await dynPost("run-all");
    if (!result.success) alert(result.error ?? "Diagnostic run failed.");
    await loadDynRuns();
  } finally {
    await loadDynPoolsState();
  }
});

dynResetBtn.addEventListener("click", async () => {
  dynResetBtn.disabled = true;
  try {
    await dynPost("reset");
    await loadDynRealUser();
    await loadDynRuns();
    await loadDynPlacementState();
    await loadDynPoolsState();
  } finally {
    dynResetBtn.disabled = false;
  }
});

dynAttemptPlacementBtn.addEventListener("click", async () => {
  dynAttemptPlacementBtn.disabled = true;
  try {
    const variant = dynPlacementVariantSelect.value;
    const result = await dynPost("attempt-placement", { variant });
    if (!result.success) alert(result.error ?? "No qualifying circle formed.");
    await loadDynPlacementState();
  } finally {
    dynAttemptPlacementBtn.disabled = false;
  }
});

loadDynRealUser();
loadDynRuns();
loadDynPlacementState();
