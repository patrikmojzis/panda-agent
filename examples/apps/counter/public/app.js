const countNode = document.querySelector("[data-count]");
const updatedAtNode = document.querySelector("[data-updated-at]");
const statusNode = document.querySelector("[data-status]");
const buttons = Array.from(document.querySelectorAll("button"));

function setBusy(isBusy) {
  for (const button of buttons) {
    button.disabled = isBusy;
  }
}

function setStatus(message) {
  statusNode.textContent = message;
}

async function loadSummary() {
  const result = await window.panda.view("summary");
  const summary = result.items[0] ?? {};
  countNode.textContent = String(summary.count ?? 0);
  updatedAtNode.textContent = summary.updated_at
    ? `Updated ${summary.updated_at}`
    : "Freshly stale in the best possible way.";
}

async function runAction(actionName, input, successMessage) {
  setBusy(true);
  setStatus("Working...");
  try {
    await window.panda.action(actionName, input);
    await loadSummary();
    setStatus(successMessage);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

for (const button of buttons) {
  if (button.hasAttribute("data-amount")) {
    button.addEventListener("click", async () => {
      const amount = Number(button.getAttribute("data-amount"));
      await runAction("increment", {amount}, `Incremented by ${amount}.`);
    });
    continue;
  }

  if (button.hasAttribute("data-reset")) {
    button.addEventListener("click", async () => {
      await runAction("reset", {}, "Counter reset.");
    });
  }
}

setBusy(true);
loadSummary()
  .then(() => setStatus("Ready."))
  .catch((error) => {
    setStatus(error instanceof Error ? error.message : String(error));
  })
  .finally(() => {
    setBusy(false);
  });
