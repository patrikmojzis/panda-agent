const identityChipNode = document.querySelector("[data-identity-chip]");
const missingIdentityNode = document.querySelector("[data-missing-identity]");
const dashboardNode = document.querySelector("[data-dashboard]");
const summaryCardsNode = document.querySelector("[data-summary-cards]");
const kindBreakdownNode = document.querySelector("[data-kind-breakdown]");
const cardListNode = document.querySelector("[data-card-list]");
const reviewListNode = document.querySelector("[data-review-list]");
const loadMoreButton = document.querySelector("[data-load-more]");
const searchForm = document.querySelector("[data-search-form]");
const captureForm = document.querySelector("[data-capture-form]");
const formStatusNode = document.querySelector("[data-form-status]");
const confidenceInput = captureForm.elements.namedItem("confidence");
const confidenceValueNode = document.querySelector("[data-confidence-value]");

const kindLabels = {
  fact: "Fact",
  preference: "Preference",
  project: "Project",
  reminder: "Reminder",
};

const state = {
  query: "",
  tag: "",
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

function addDaysValue(days) {
  const next = new Date();
  next.setDate(next.getDate() + days);
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

function readIdentityContext() {
  const context = window.panda.getContext();
  const identityId = typeof context.identityId === "string" && context.identityId.trim()
    ? context.identityId.trim()
    : "";
  const identityHandle = typeof context.identityHandle === "string" && context.identityHandle.trim()
    ? context.identityHandle.trim()
    : "";

  return {
    hasIdentity: Boolean(identityId || identityHandle),
    label: identityHandle || identityId,
  };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function setFormStatus(message) {
  formStatusNode.textContent = message;
}

function setCaptureBusy(isBusy) {
  for (const element of captureForm.querySelectorAll("input, select, textarea, button")) {
    element.disabled = isBusy;
  }
}

function renderSummary(summary) {
  const cards = [
    ["Total", summary.total_cards ?? 0],
    ["Active", summary.active_cards ?? 0],
    ["Preferences", summary.preferences ?? 0],
    ["Review Due", summary.due_for_review ?? 0],
  ];

  summaryCardsNode.innerHTML = cards.map(([label, value]) => `
    <article class="stat-card">
      <p class="stat-label">${escapeHtml(label)}</p>
      <p class="stat-value">${escapeHtml(value)}</p>
    </article>
  `).join("");
}

function renderKindBreakdown(items) {
  if (!items.length) {
    kindBreakdownNode.innerHTML = '<p class="empty">No active cards yet.</p>';
    return;
  }

  const maxCount = Math.max(...items.map((item) => Number(item.count ?? 0)), 1);
  kindBreakdownNode.innerHTML = items.map((item) => {
    const count = Number(item.count ?? 0);
    const width = Math.max(8, Math.round((count / maxCount) * 100));
    return `
      <div class="bar-row">
        <div class="bar-label">
          <span>${escapeHtml(kindLabels[item.kind] ?? item.kind ?? "Unknown")}</span>
          <span>${escapeHtml(count)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
      </div>
    `;
  }).join("");
}

function renderCard(item, options = {}) {
  const tags = parseJsonArray(item.tags_json);
  return `
    <article class="memory-card">
      <div class="card-top">
        <div>
          <p class="card-kicker">${escapeHtml(kindLabels[item.kind] ?? item.kind ?? "Card")} · ${escapeHtml(item.captured_on ?? "")}</p>
          <h3>${escapeHtml(item.title ?? "Untitled")}</h3>
        </div>
        <span class="confidence">${escapeHtml(item.confidence ?? "n/a")}/5</span>
      </div>
      ${item.details ? `<p class="details">${escapeHtml(item.details)}</p>` : ""}
      <div class="pill-row">
        ${tags.map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}
      </div>
      <div class="card-actions">
        <span>Review ${escapeHtml(item.review_on ?? "later")}</span>
        <div>
          ${options.review ? `<button type="button" class="ghost small" data-snooze-id="${escapeHtml(item.id)}">Snooze</button>` : ""}
          <button type="button" class="ghost small" data-archive-id="${escapeHtml(item.id)}">Archive</button>
        </div>
      </div>
    </article>
  `;
}

function renderSearchItems() {
  if (!state.items.length) {
    cardListNode.innerHTML = '<p class="empty">No matching cards.</p>';
    return;
  }
  cardListNode.innerHTML = state.items.map((item) => renderCard(item)).join("");
}

function updateLoadMore() {
  loadMoreButton.hidden = !state.hasMore;
  loadMoreButton.disabled = false;
}

async function loadSearch({append = false} = {}) {
  const params = {
    ...(state.query ? {query: state.query} : {}),
    ...(state.tag ? {tag: state.tag} : {}),
  };
  const result = await window.panda.view("search_cards", {
    params,
    offset: append ? state.nextOffset : 0,
  });

  state.items = append ? state.items.concat(result.items ?? []) : result.items ?? [];
  state.nextOffset = result.page?.nextOffset ?? state.items.length;
  state.hasMore = Boolean(result.page?.hasMore);
  renderSearchItems();
  updateLoadMore();
}

async function refreshDashboard() {
  const identity = readIdentityContext();
  identityChipNode.textContent = identity.hasIdentity ? `identity: ${identity.label}` : "identity: missing";
  missingIdentityNode.classList.toggle("hidden", identity.hasIdentity);
  dashboardNode.classList.toggle("hidden", !identity.hasIdentity);

  if (!identity.hasIdentity) {
    return;
  }

  const [summary, kinds, reviews] = await Promise.all([
    window.panda.view("summary"),
    window.panda.view("kind_breakdown"),
    window.panda.view("review_queue"),
  ]);

  renderSummary(summary.items[0] ?? {});
  renderKindBreakdown(kinds.items ?? []);
  reviewListNode.innerHTML = reviews.items?.length
    ? reviews.items.map((item) => renderCard(item, {review: true})).join("")
    : '<p class="empty">Nothing due right now.</p>';
  await loadSearch();
}

function collectCaptureInput() {
  const formData = new FormData(captureForm);
  const tags = formData.getAll("tags").filter((value) => typeof value === "string" && value);
  const details = String(formData.get("details") ?? "").trim();
  const reviewOn = String(formData.get("review_on") ?? "").trim();

  return {
    captured_on: String(formData.get("captured_on") ?? "").trim(),
    kind: String(formData.get("kind") ?? "").trim(),
    title: String(formData.get("title") ?? "").trim(),
    confidence: Number(formData.get("confidence") ?? 4),
    ...(details ? {details} : {}),
    ...(tags.length ? {tags} : {}),
    ...(reviewOn ? {review_on: reviewOn} : {}),
  };
}

async function handleCardAction(target) {
  const archiveId = Number(target.getAttribute("data-archive-id"));
  const snoozeId = Number(target.getAttribute("data-snooze-id"));
  if (!archiveId && !snoozeId) {
    return;
  }

  target.disabled = true;
  try {
    if (archiveId) {
      setFormStatus("Archiving card...");
      await window.panda.action("archive_card", {id: archiveId});
      setFormStatus("Card archived.");
    } else {
      setFormStatus("Snoozing review...");
      await window.panda.action("snooze_review", {id: snoozeId, days: 14});
      setFormStatus("Review snoozed.");
    }
    await refreshDashboard();
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : String(error));
  } finally {
    target.disabled = false;
  }
}

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(searchForm);
  state.query = String(formData.get("query") ?? "").trim();
  state.tag = String(formData.get("tag") ?? "").trim();
  loadMoreButton.disabled = true;
  try {
    await loadSearch();
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : String(error));
  }
});

loadMoreButton.addEventListener("click", async () => {
  loadMoreButton.disabled = true;
  try {
    await loadSearch({append: true});
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : String(error));
    loadMoreButton.disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (target instanceof HTMLButtonElement) {
    await handleCardAction(target);
  }
});

confidenceInput.addEventListener("input", () => {
  confidenceValueNode.textContent = confidenceInput.value;
});

captureForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = collectCaptureInput();
  setCaptureBusy(true);
  setFormStatus("Capturing card...");
  try {
    await window.panda.action("capture_card", payload);
    captureForm.reset();
    captureForm.elements.namedItem("captured_on").value = todayValue();
    captureForm.elements.namedItem("review_on").value = addDaysValue(14);
    captureForm.elements.namedItem("confidence").value = "4";
    confidenceValueNode.textContent = "4";
    setFormStatus("Card captured.");
    await refreshDashboard();
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setCaptureBusy(false);
  }
});

async function main() {
  const bootstrap = await window.panda.bootstrap();
  window.panda.setContext(bootstrap.context ?? {});
  captureForm.elements.namedItem("captured_on").value = todayValue();
  captureForm.elements.namedItem("review_on").value = addDaysValue(14);
  confidenceValueNode.textContent = confidenceInput.value;
  await refreshDashboard();
}

main().catch((error) => {
  setFormStatus(error instanceof Error ? error.message : String(error));
});
