const elements = {
  enabled: document.querySelector("#enabled"),
  protected: document.querySelector("#protected"),
  currentTabDescription: document.querySelector("#currentTabDescription"),
  sleepingCount: document.querySelector("#sleepingCount"),
  idleTime: document.querySelector("#idleTime"),
  reclaimedMemory: document.querySelector("#reclaimedMemory"),
  statusText: document.querySelector("#statusText"),
  totalCount: document.querySelector("#totalCount"),
  sleepNow: document.querySelector("#sleepNow"),
  options: document.querySelector("#options"),
  whyAwakeToggle: document.querySelector("#whyAwakeToggle"),
  whyAwakePanel: document.querySelector("#whyAwakePanel"),
  freezeWindow: document.querySelector("#freezeWindow"),
  freezeOthers: document.querySelector("#freezeOthers"),
  freezeAll: document.querySelector("#freezeAll"),
  wakeAll: document.querySelector("#wakeAll"),
  keepDomain: document.querySelector("#keepDomain"),
  nextScanLine: document.querySelector("#nextScanLine"),
  message: document.querySelector("#message")
};

let latestStatus = null;

function formatMinutes(value) {
  return Number.isInteger(value) ? `${value} min` : `${value.toFixed(1)} min`;
}

function formatMemory(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const mib = bytes / (1024 * 1024);
  return mib >= 100 ? `${Math.round(mib)} MB` : `${mib.toFixed(0)} MB`;
}

// Estimated live-page memory released by freezing. Frozen tabs keep only the
// lightweight preview page; Chrome measures a typical web page renderer at
// 50–150 MB, so this stays a conservative estimate, not a measurement.
const ESTIMATED_BYTES_PER_FROZEN_TAB = 75 * 1024 * 1024;

function formatNextScan(at) {
  if (!at) return "";
  const seconds = Math.max(0, Math.round((at - Date.now()) / 1000));
  return seconds < 60 ? `Next evaluation in ${seconds}s` : `Next evaluation in ${Math.round(seconds / 60)} min`;
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
  elements.reclaimedMemory.textContent = formatMemory(status.summary.frozen * ESTIMATED_BYTES_PER_FROZEN_TAB);
  elements.statusText.textContent = status.settings.enabled
    ? `${status.summary.sleeping} sleeping · ${status.summary.previewing} frozen page${status.summary.previewing === 1 ? "" : "s"} open`
    : "Automatic freeze is paused";
  elements.totalCount.textContent = `${status.metrics.totalFrozen} frozen · ${status.metrics.totalWoken} woken`;
  elements.sleepNow.disabled = status.summary.eligibleNow === 0;
  elements.nextScanLine.textContent = status.settings.enabled ? formatNextScan(status.nextScanAt) : "Automatic freeze is paused";
  // The awake trace is only meaningful for an unfrozen tab.
  elements.whyAwakeToggle.hidden = status.currentTabState !== "awake";
  if (status.currentTabState !== "awake") {
    elements.whyAwakePanel.hidden = true;
    elements.whyAwakeToggle.setAttribute("aria-expanded", "false");
  }
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

elements.whyAwakeToggle.addEventListener("click", async () => {
  const expanded = elements.whyAwakeToggle.getAttribute("aria-expanded") === "true";
  if (expanded) {
    elements.whyAwakeToggle.setAttribute("aria-expanded", "false");
    elements.whyAwakePanel.hidden = true;
    return;
  }
  try {
    const trace = await send("WHY_CURRENT_TAB");
    elements.whyAwakePanel.replaceChildren(
      ...trace.reasons.map((reason) => {
        const item = document.createElement("li");
        const code = document.createElement("span");
        code.className = "code";
        code.textContent = reason.label;
        item.append(code);
        return item;
      })
    );
    if (!trace.reasons.length) {
      const item = document.createElement("li");
      item.textContent = "Eligible to freeze on the next scan.";
      elements.whyAwakePanel.append(item);
    }
    elements.whyAwakeToggle.setAttribute("aria-expanded", "true");
    elements.whyAwakePanel.hidden = false;
  } catch {
    // send() already surfaced the error through the message line.
  }
});

async function runBulk(button, action) {
  button.disabled = true;
  try {
    const result = await action();
    render(result.status);
    showMessage(result.summary ?? "", "success");
  } catch {
    // send() already surfaced the error through the message line.
  } finally {
    button.disabled = false;
  }
}

elements.freezeWindow.addEventListener("click", () => runBulk(elements.freezeWindow, () => send("FREEZE_TABS", { scope: "window" })).then(() => undefined));
elements.freezeOthers.addEventListener("click", () => runBulk(elements.freezeOthers, () => send("FREEZE_TABS", { scope: "others" })).then(() => undefined));
elements.freezeAll.addEventListener("click", () => runBulk(elements.freezeAll, () => send("FREEZE_TABS", { scope: "all" })).then(() => undefined));

elements.wakeAll.addEventListener("click", () =>
  runBulk(elements.wakeAll, async () => {
    const result = await send("WAKE_TABS", { scope: "all" });
    return { ...result, summary: result.failures.length
      ? `${result.woken.length} woken · ${result.failures.length} failed.`
      : `${result.woken.length} tab${result.woken.length === 1 ? "" : "s"} woken.` };
  }).then(() => undefined)
);

elements.keepDomain.addEventListener("click", () =>
  runBulk(elements.keepDomain, async () => {
    const result = await send("ADD_TEMPORARY_KEEP_AWAKE", { scope: "domain", minutes: 60 });
    return { ...result, summary: "This site will stay awake for the next hour." };
  }).then(() => undefined)
);

elements.options.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

void refresh();
