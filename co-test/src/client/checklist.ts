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
