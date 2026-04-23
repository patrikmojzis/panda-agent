const identityChipNode = document.querySelector("[data-identity-chip]");
const missingIdentityNode = document.querySelector("[data-missing-identity]");
const dashboardNode = document.querySelector("[data-dashboard]");
const summaryCardsNode = document.querySelector("[data-summary-cards]");
const flowBreakdownNode = document.querySelector("[data-flow-breakdown]");
const energyTrendNode = document.querySelector("[data-energy-trend]");
const entryListNode = document.querySelector("[data-entry-list]");
const loadMoreButton = document.querySelector("[data-load-more]");
const form = document.querySelector("[data-entry-form]");
const formStatusNode = document.querySelector("[data-form-status]");
const energyValueNode = document.querySelector("[data-energy-value]");
const energyInput = form.elements.namedItem("energy");

const flowLabels = {
  spotting: "Spotting",
  light: "Light",
  medium: "Medium",
  heavy: "Heavy",
};

const state = {
  items: [],
  nextOffset: 0,
  hasMore: false,
};

function todayValue() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function readIdentityContext() {
  const context = window.panda.getContext();
  const identityId = typeof context.identityId === "string" && context.identityId.trim()
    ? context.identityId.trim()
    : "";
  const identityHandle = typeof context.identityHandle === "string" && context.identityHandle.trim()
    ? context.identityHandle.trim()
    : "";

  return {
    identityId,
    identityHandle,
    hasIdentity: Boolean(identityId || identityHandle),
    label: identityHandle || identityId,
  };
}

function parseSymptoms(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function setFormStatus(message) {
  formStatusNode.textContent = message;
}

function setFormBusy(isBusy) {
  for (const element of form.querySelectorAll("input, select, textarea, button")) {
    element.disabled = isBusy;
  }
}

function renderSummary(summary) {
  const cards = [
    {
      label: "Entries Logged",
      value: summary.entry_count ?? 0,
    },
    {
      label: "Last Logged Day",
      value: summary.last_logged_on ?? "Nothing yet",
    },
    {
      label: "Average Energy",
      value: summary.avg_energy ?? "n/a",
    },
    {
      label: "Heavy Days",
      value: summary.heavy_days ?? 0,
    },
  ];

  summaryCardsNode.innerHTML = cards.map((card) => `
    <article class="stat-card">
      <p class="stat-label">${escapeHtml(card.label)}</p>
      <p class="stat-value">${escapeHtml(card.value)}</p>
    </article>
  `).join("");
}

function renderFlowBreakdown(items) {
  if (!items.length) {
    flowBreakdownNode.innerHTML = '<p class="empty">No flow data yet.</p>';
    return;
  }

  const maxCount = Math.max(...items.map((item) => Number(item.count ?? 0)), 1);
  flowBreakdownNode.innerHTML = items.map((item) => {
    const count = Number(item.count ?? 0);
    const width = Math.max(8, Math.round((count / maxCount) * 100));
    return `
      <div class="bar-row">
        <div class="bar-label">
          <span>${escapeHtml(flowLabels[item.flow] ?? item.flow ?? "Unknown")}</span>
          <span>${escapeHtml(count)}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${width}%"></div>
        </div>
      </div>
    `;
  }).join("");
}

function buildSparkline(items) {
  const ordered = [...items].reverse();
  if (ordered.length === 0) {
    return '<p class="empty">Log a couple of days and the chart wakes up.</p>';
  }

  const width = 520;
  const height = 180;
  const padding = 18;
  const maxEnergy = 5;
  const minEnergy = 1;
  const xStep = ordered.length === 1 ? 0 : (width - padding * 2) / (ordered.length - 1);

  const points = ordered.map((item, index) => {
    const energy = Number(item.energy ?? minEnergy);
    const x = padding + (index * xStep);
    const y = padding + ((maxEnergy - energy) / (maxEnergy - minEnergy || 1)) * (height - padding * 2);
    return {x, y, label: item.logged_on ?? ""};
  });

  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L ${points.at(-1)?.x ?? padding} ${height - padding} L ${points[0]?.x ?? padding} ${height - padding} Z`;
  const lastPoint = points.at(-1) ?? points[0];

  return `
    <svg class="sparkline" viewBox="0 0 ${width} ${height}" aria-label="Energy trend">
      <path class="area" d="${areaPath}"></path>
      <path class="line" d="${linePath}"></path>
      <text x="${padding}" y="${height - 4}">${escapeHtml(points[0]?.label ?? "")}</text>
      <text x="${Math.max(padding, (lastPoint?.x ?? width) - 88)}" y="${height - 4}">${escapeHtml(lastPoint?.label ?? "")}</text>
    </svg>
  `;
}

function renderEnergyTrend(items) {
  energyTrendNode.innerHTML = buildSparkline(items);
}

function renderEntries() {
  if (state.items.length === 0) {
    entryListNode.innerHTML = '<p class="empty">No entries yet. Log the first one and the app starts feeling alive.</p>';
    return;
  }

  entryListNode.innerHTML = state.items.map((item) => {
    const symptoms = parseSymptoms(item.symptoms_json);
    return `
      <article class="entry-card">
        <div class="entry-top">
          <div>
            <h3>${escapeHtml(item.logged_on ?? "Unknown date")}</h3>
            <p class="entry-meta">
              <span>${escapeHtml(flowLabels[item.flow] ?? item.flow ?? "Unknown flow")}</span>
              <span>${item.mood ? escapeHtml(item.mood) : "Mood skipped"}</span>
              <span>${item.energy ? `${escapeHtml(item.energy)}/5 energy` : "No energy score"}</span>
            </p>
          </div>
          <button type="button" class="delete" data-delete-id="${escapeHtml(item.id)}">Delete</button>
        </div>
        ${symptoms.length ? `
          <div class="pill-row">
            ${symptoms.map((symptom) => `<span class="pill">${escapeHtml(symptom)}</span>`).join("")}
          </div>
        ` : ""}
        ${item.notes ? `<p class="entry-notes">${escapeHtml(item.notes)}</p>` : ""}
      </article>
    `;
  }).join("");
}

function updateLoadMore() {
  loadMoreButton.hidden = !state.hasMore;
  loadMoreButton.disabled = false;
}

async function refreshDashboard() {
  const identity = readIdentityContext();
  identityChipNode.textContent = identity.hasIdentity ? `identity: ${identity.label}` : "identity: missing";
  missingIdentityNode.classList.toggle("hidden", identity.hasIdentity);
  dashboardNode.classList.toggle("hidden", !identity.hasIdentity);

  if (!identity.hasIdentity) {
    return;
  }

  const [summary, flowBreakdown, energyTrend, recentEntries] = await Promise.all([
    window.panda.view("summary"),
    window.panda.view("flow_breakdown"),
    window.panda.view("energy_trend"),
    window.panda.view("recent_entries"),
  ]);

  state.items = recentEntries.items ?? [];
  state.nextOffset = recentEntries.page?.nextOffset ?? state.items.length;
  state.hasMore = Boolean(recentEntries.page?.hasMore);

  renderSummary(summary.items[0] ?? {});
  renderFlowBreakdown(flowBreakdown.items ?? []);
  renderEnergyTrend(energyTrend.items ?? []);
  renderEntries();
  updateLoadMore();
}

async function loadMoreEntries() {
  loadMoreButton.disabled = true;
  try {
    const result = await window.panda.view("recent_entries", {
      offset: state.nextOffset,
    });
    state.items = state.items.concat(result.items ?? []);
    state.nextOffset = result.page?.nextOffset ?? state.items.length;
    state.hasMore = Boolean(result.page?.hasMore);
    renderEntries();
    updateLoadMore();
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : String(error));
    loadMoreButton.disabled = false;
  }
}

function collectFormInput() {
  const formData = new FormData(form);
  const symptoms = formData.getAll("symptoms").filter((value) => typeof value === "string" && value);
  const notes = String(formData.get("notes") ?? "").trim();
  const mood = String(formData.get("mood") ?? "").trim();
  const energy = Number(formData.get("energy") ?? 0);

  return {
    logged_on: String(formData.get("logged_on") ?? "").trim(),
    flow: String(formData.get("flow") ?? "").trim(),
    ...(mood ? {mood} : {}),
    ...(Number.isFinite(energy) && energy > 0 ? {energy} : {}),
    ...(symptoms.length ? {symptoms} : {}),
    ...(notes ? {notes} : {}),
  };
}

loadMoreButton.addEventListener("click", async () => {
  await loadMoreEntries();
});

entryListNode.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const id = Number(target.getAttribute("data-delete-id"));
  if (!id) {
    return;
  }

  target.setAttribute("disabled", "disabled");
  setFormStatus("Deleting entry...");
  try {
    await window.panda.action("delete_entry", {id});
    setFormStatus("Entry deleted.");
    await refreshDashboard();
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : String(error));
  } finally {
    target.removeAttribute("disabled");
  }
});

energyInput.addEventListener("input", () => {
  energyValueNode.textContent = energyInput.value;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = collectFormInput();
  setFormBusy(true);
  setFormStatus("Logging entry...");

  try {
    await window.panda.action("log_entry", payload);
    form.reset();
    form.elements.namedItem("logged_on").value = todayValue();
    form.elements.namedItem("flow").value = "medium";
    form.elements.namedItem("energy").value = "3";
    energyValueNode.textContent = "3";
    setFormStatus("Entry logged.");
    await refreshDashboard();
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setFormBusy(false);
  }
});

form.elements.namedItem("logged_on").value = todayValue();
energyValueNode.textContent = energyInput.value;

refreshDashboard().catch((error) => {
  setFormStatus(error instanceof Error ? error.message : String(error));
});
