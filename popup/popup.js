const elements = {
  enabled: document.querySelector("#enabled"),
  protected: document.querySelector("#protected"),
  currentTabDescription: document.querySelector("#currentTabDescription"),
  sleepingCount: document.querySelector("#sleepingCount"),
  idleTime: document.querySelector("#idleTime"),
  statusText: document.querySelector("#statusText"),
  totalCount: document.querySelector("#totalCount"),
  sleepNow: document.querySelector("#sleepNow"),
  options: document.querySelector("#options"),
  message: document.querySelector("#message")
};

let latestStatus = null;

function formatMinutes(value) {
  return Number.isInteger(value) ? `${value} min` : `${value.toFixed(1)} min`;
}

function render(status) {
  latestStatus = status;
  elements.enabled.checked = status.settings.enabled;
  elements.protected.checked = status.currentTabProtected;
  elements.protected.disabled = status.currentTabState !== "awake";
  elements.currentTabDescription.textContent = status.currentTabState === "awake"
    ? "Keep this page awake while you work."
    : "Showing the frozen page. Click anywhere on it to wake the live site.";
  elements.sleepingCount.textContent = String(status.summary.frozen);
  elements.idleTime.textContent = formatMinutes(status.settings.idleMinutes);
  elements.statusText.textContent = status.settings.enabled
    ? `${status.summary.sleeping} sleeping · ${status.summary.previewing} frozen page${status.summary.previewing === 1 ? "" : "s"} open`
    : "Automatic freeze is paused";
  elements.totalCount.textContent = `${status.metrics.totalFrozen} frozen · ${status.metrics.totalWoken} woken`;
  elements.sleepNow.disabled = status.summary.eligibleNow === 0;
}

function showMessage(text, kind = "info") {
  elements.message.textContent = text;
  elements.message.dataset.kind = kind;
}

async function send(type, extra = {}) {
  showMessage("");
  try {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (response?.__tabSleepError) throw new Error(response.__tabSleepError);
    return response;
  } catch (error) {
    showMessage(error.message, "error");
    throw error;
  }
}

async function refresh() {
  render(await send("GET_STATUS"));
}

elements.enabled.addEventListener("change", async () => {
  elements.enabled.disabled = true;
  try {
    render(await send("SET_ENABLED", { enabled: elements.enabled.checked }));
  } finally {
    elements.enabled.disabled = false;
  }
});

elements.protected.addEventListener("change", async () => {
  elements.protected.disabled = true;
  try {
    render(await send("SET_CURRENT_TAB_PROTECTED", { protected: elements.protected.checked }));
  } finally {
    elements.protected.disabled = latestStatus?.currentTabState !== "awake";
  }
});

elements.sleepNow.addEventListener("click", async () => {
  elements.sleepNow.disabled = true;
  elements.sleepNow.textContent = "Freezing…";
  try {
    const result = await send("SLEEP_OTHER_TABS");
    render(result.status);
    showMessage(
      result.failures.length
        ? `${result.frozen.length} frozen · ${result.failures.length} failed.`
        : result.frozen.length === 1
          ? "1 tab frozen."
          : `${result.frozen.length} tabs frozen.`,
      result.failures.length ? "error" : "success"
    );
  } finally {
    elements.sleepNow.innerHTML = '<span aria-hidden="true">☾</span> Freeze inactive tabs now';
    elements.sleepNow.disabled = latestStatus?.summary.eligibleNow === 0;
  }
});

elements.options.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

void refresh();
