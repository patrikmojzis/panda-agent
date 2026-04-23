const appChipNode = document.querySelector("[data-app-chip]");
const summaryCardsNode = document.querySelector("[data-summary-cards]");
const severityLanesNode = document.querySelector("[data-severity-lanes]");
const incidentListNode = document.querySelector("[data-incident-list]");
const activityListNode = document.querySelector("[data-activity-list]");
const loadMoreButton = document.querySelector("[data-load-more]");
const filterForm = document.querySelector("[data-filter-form]");
const openForm = document.querySelector("[data-open-form]");
const formStatusNode = document.querySelector("[data-form-status]");

const severityLabels = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const statusLabels = {
  investigating: "Investigating",
  watching: "Watching",
  mitigated: "Mitigated",
  resolved: "Resolved",
};

const state = {
  status: "",
  severity: "",
  query: "",
  incidents: [],
  nextOffset: 0,
  hasMore: false,
};

function todayValue() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function tomorrowValue() {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  const month = String(next.getMonth() + 1).padStart(2, "0");
  const day = String(next.getDate()).padStart(2, "0");
  return `${next.getFullYear()}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value) {
  if (typeof value !== "string" || !value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function setFormStatus(message) {
  formStatusNode.textContent = message;
}

function setOpenBusy(isBusy) {
  for (const element of openForm.querySelectorAll("input, select, textarea, button")) {
    element.disabled = isBusy;
  }
}

function renderSummary(summary) {
  const cards = [
    ["Total", summary.total_incidents ?? 0],
    ["Active", summary.active_incidents ?? 0],
    ["Watching", summary.watching ?? 0],
    ["Critical", summary.active_critical ?? 0],
  ];

  summaryCardsNode.innerHTML = cards.map(([label, value]) => `
    <article class="stat-card">
      <p class="stat-label">${escapeHtml(label)}</p>
      <p class="stat-value">${escapeHtml(value)}</p>
    </article>
  `).join("");
}

function renderSeverityLanes(items) {
  if (!items.length) {
    severityLanesNode.innerHTML = '<p class="empty">No active incidents.</p>';
    return;
  }

  const maxCount = Math.max(...items.map((item) => Number(item.count ?? 0)), 1);
  severityLanesNode.innerHTML = items.map((item) => {
    const count = Number(item.count ?? 0);
    const width = Math.max(8, Math.round((count / maxCount) * 100));
    return `
      <div class="bar-row">
        <div class="bar-label">
          <span>${escapeHtml(severityLabels[item.severity] ?? item.severity ?? "Unknown")}</span>
          <span>${escapeHtml(count)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill severity-${escapeHtml(item.severity ?? "low")}" style="width:${width}%"></div></div>
      </div>
    `;
  }).join("");
}

function renderIncident(item) {
  return `
    <article class="incident-card severity-${escapeHtml(item.severity ?? "low")}">
      <div class="incident-top">
        <div>
          <p class="kicker">${escapeHtml(severityLabels[item.severity] ?? item.severity ?? "Incident")} · ${escapeHtml(statusLabels[item.status] ?? item.status ?? "Status")}</p>
          <h3>${escapeHtml(item.title ?? "Untitled incident")}</h3>
        </div>
        <span class="due">Due ${escapeHtml(item.due_on ?? "soon")}</span>
      </div>
      ${item.details ? `<p class="details">${escapeHtml(item.details)}</p>` : ""}
      <div class="incident-meta">
        <span>Owner: ${escapeHtml(item.owner || "unassigned")}</span>
        <span>Source: ${escapeHtml(item.source || "manual")}</span>
        <span>Opened: ${escapeHtml(item.opened_at || "")}</span>
      </div>
      <div class="incident-actions">
        <button type="button" class="ghost small" data-watch-id="${escapeHtml(item.id)}">Watch</button>
        <button type="button" class="ghost small" data-resolve-id="${escapeHtml(item.id)}">Resolve</button>
      </div>
    </article>
  `;
}

function renderIncidents() {
  if (!state.incidents.length) {
    incidentListNode.innerHTML = '<p class="empty">No incidents match those filters.</p>';
    return;
  }

  incidentListNode.innerHTML = state.incidents.map((item) => renderIncident(item)).join("");
}

function updateLoadMore() {
  loadMoreButton.hidden = !state.hasMore;
  loadMoreButton.disabled = false;
}

async function loadIncidents({append = false} = {}) {
  const params = {
    ...(state.status ? {status: state.status} : {}),
    ...(state.severity ? {severity: state.severity} : {}),
    ...(state.query ? {query: state.query} : {}),
  };
  const result = await window.panda.view("incident_list", {
    params,
    offset: append ? state.nextOffset : 0,
  });

  state.incidents = append ? state.incidents.concat(result.items ?? []) : result.items ?? [];
  state.nextOffset = result.page?.nextOffset ?? state.incidents.length;
  state.hasMore = Boolean(result.page?.hasMore);
  renderIncidents();
  updateLoadMore();
}

function renderActivity(items) {
  activityListNode.innerHTML = items.length
    ? items.map((item) => `
      <article class="activity-row">
        <span>${escapeHtml(formatDateTime(item.created_at))}</span>
        <strong>${escapeHtml(item.event_type ?? "event")}</strong>
        <span>${escapeHtml(item.title ?? `#${item.incident_id}`)}</span>
        <em>${escapeHtml(item.note ?? "")}</em>
      </article>
    `).join("")
    : '<p class="empty">No activity yet.</p>';
}

async function refreshDashboard() {
  const [summary, lanes, activity] = await Promise.all([
    window.panda.view("summary"),
    window.panda.view("severity_lanes"),
    window.panda.view("activity_feed"),
  ]);
  renderSummary(summary.items[0] ?? {});
  renderSeverityLanes(lanes.items ?? []);
  renderActivity(activity.items ?? []);
  await loadIncidents();
}

function collectOpenInput() {
  const formData = new FormData(openForm);
  const owner = String(formData.get("owner") ?? "").trim();
  const dueOn = String(formData.get("due_on") ?? "").trim();
  const details = String(formData.get("details") ?? "").trim();

  return {
    opened_at: String(formData.get("opened_at") ?? "").trim(),
    title: String(formData.get("title") ?? "").trim(),
    severity: String(formData.get("severity") ?? "").trim(),
    source: String(formData.get("source") ?? "").trim(),
    ...(owner ? {owner} : {}),
    ...(dueOn ? {due_on: dueOn} : {}),
    ...(details ? {details} : {}),
  };
}

async function handleIncidentAction(target) {
  const watchId = Number(target.getAttribute("data-watch-id"));
  const resolveId = Number(target.getAttribute("data-resolve-id"));
  if (!watchId && !resolveId) {
    return;
  }

  target.disabled = true;
  try {
    if (watchId) {
      setFormStatus("Marking watched...");
      await window.panda.action("triage_incident", {id: watchId, status: "watching"});
      setFormStatus("Incident moved to watching.");
    } else {
      setFormStatus("Resolving incident...");
      await window.panda.action("resolve_incident", {id: resolveId, note: "Resolved from Ops Radar."});
      setFormStatus("Incident resolved.");
    }
    await refreshDashboard();
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : String(error));
  } finally {
    target.disabled = false;
  }
}

filterForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(filterForm);
  state.status = String(formData.get("status") ?? "").trim();
  state.severity = String(formData.get("severity") ?? "").trim();
  state.query = String(formData.get("query") ?? "").trim();
  loadMoreButton.disabled = true;
  try {
    await loadIncidents();
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : String(error));
  }
});

loadMoreButton.addEventListener("click", async () => {
  loadMoreButton.disabled = true;
  try {
    await loadIncidents({append: true});
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : String(error));
    loadMoreButton.disabled = false;
  }
});

incidentListNode.addEventListener("click", async (event) => {
  const target = event.target;
  if (target instanceof HTMLButtonElement) {
    await handleIncidentAction(target);
  }
});

openForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = collectOpenInput();
  setOpenBusy(true);
  setFormStatus("Opening incident...");
  try {
    await window.panda.action("open_incident", payload);
    openForm.reset();
    openForm.elements.namedItem("opened_at").value = todayValue();
    openForm.elements.namedItem("due_on").value = tomorrowValue();
    setFormStatus("Incident opened.");
    await refreshDashboard();
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setOpenBusy(false);
  }
});

async function main() {
  const bootstrap = await window.panda.bootstrap();
  window.panda.setContext(bootstrap.context ?? {});
  appChipNode.textContent = bootstrap.app.name;
  openForm.elements.namedItem("opened_at").value = todayValue();
  openForm.elements.namedItem("due_on").value = tomorrowValue();
  await refreshDashboard();
}

main().catch((error) => {
  setFormStatus(error instanceof Error ? error.message : String(error));
});
