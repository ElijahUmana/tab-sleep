import {
  DEFAULT_SETTINGS,
  MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
  SETTINGS_KEY,
  normalizeSettings
} from "../lib/constants.js";

const fields = {
  enabled: document.querySelector("#enabled"),
  idleMinutes: document.querySelector("#idleMinutes"),
  skipPinned: document.querySelector("#skipPinned"),
  skipAudible: document.querySelector("#skipAudible"),
  respectAutoDiscardable: document.querySelector("#respectAutoDiscardable"),
  skipLoading: document.querySelector("#skipLoading")
};
const status = document.querySelector("#saveStatus");
const restore = document.querySelector("#restore");
let numberSaveTimer = null;

function setBusy(value) {
  document.body.toggleAttribute("aria-busy", value);
  for (const element of Object.values(fields)) element.disabled = value;
  restore.disabled = value;
}

function render(settings) {
  for (const [key, element] of Object.entries(fields)) {
    element[element.type === "checkbox" ? "checked" : "value"] = element.type === "checkbox"
      ? settings[key]
      : String(settings[key]);
  }
}

function readSettings() {
  return normalizeSettings({
    enabled: fields.enabled.checked,
    idleMinutes: fields.idleMinutes.value,
    skipPinned: fields.skipPinned.checked,
    skipAudible: fields.skipAudible.checked,
    respectAutoDiscardable: fields.respectAutoDiscardable.checked,
    skipLoading: fields.skipLoading.checked
  });
}

function validIdleMinutes() {
  const value = Number(fields.idleMinutes.value);
  const halfMinuteSteps = Number.isInteger(value * 2);
  return Number.isFinite(value) && value >= MIN_IDLE_MINUTES && value <= MAX_IDLE_MINUTES && halfMinuteSteps;
}

async function save() {
  if (!validIdleMinutes()) {
    status.textContent = `Enter ${MIN_IDLE_MINUTES}–${MAX_IDLE_MINUTES} minutes in 0.5-minute increments.`;
    status.dataset.kind = "error";
    return false;
  }
  const settings = readSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  render(settings);
  status.textContent = "Saved.";
  status.dataset.kind = "success";
  return true;
}

function reportError(error) {
  status.textContent = `Could not save settings: ${error.message}`;
  status.dataset.kind = "error";
}

for (const element of Object.values(fields)) {
  if (element.type === "number") {
    element.addEventListener("input", () => {
      status.textContent = "Saving…";
      status.dataset.kind = "";
      clearTimeout(numberSaveTimer);
      numberSaveTimer = setTimeout(() => void save().catch(reportError), 200);
    });
    element.addEventListener("change", () => {
      clearTimeout(numberSaveTimer);
      void save().catch(reportError);
    });
  } else {
    element.addEventListener("change", () => void save().catch(reportError));
  }
}

window.addEventListener("pagehide", () => {
  if (!numberSaveTimer || !validIdleMinutes()) return;
  clearTimeout(numberSaveTimer);
  numberSaveTimer = null;
  void chrome.storage.local.set({ [SETTINGS_KEY]: readSettings() });
});

restore.addEventListener("click", async () => {
  setBusy(true);
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
    render(DEFAULT_SETTINGS);
    status.textContent = "Defaults restored.";
    status.dataset.kind = "success";
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
});

setBusy(true);
try {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  render(normalizeSettings(stored[SETTINGS_KEY]));
} catch (error) {
  status.textContent = `Could not load settings: ${error.message}`;
  status.dataset.kind = "error";
} finally {
  setBusy(false);
}
