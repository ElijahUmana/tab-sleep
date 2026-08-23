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
let saveTimer = null;

function render(settings) {
  for (const [key, element] of Object.entries(fields)) {
    if (element.type === "checkbox") {
      element.checked = settings[key];
    } else {
      element.value = String(settings[key]);
    }
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

async function save() {
  const rawIdleMinutes = Number(fields.idleMinutes.value);
  if (!Number.isFinite(rawIdleMinutes) || rawIdleMinutes < MIN_IDLE_MINUTES || rawIdleMinutes > MAX_IDLE_MINUTES) {
    status.textContent = `Enter a value from ${MIN_IDLE_MINUTES} to ${MAX_IDLE_MINUTES} minutes.`;
    status.dataset.kind = "error";
    return;
  }

  const settings = readSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  render(settings);
  status.textContent = "Saved.";
  status.dataset.kind = "success";
}

function scheduleSave() {
  status.textContent = "Saving…";
  status.dataset.kind = "";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void save().catch((error) => {
      status.textContent = error.message;
      status.dataset.kind = "error";
    });
  }, 200);
}

for (const element of Object.values(fields)) {
  element.addEventListener("change", scheduleSave);
  if (element.type === "number") {
    element.addEventListener("input", scheduleSave);
  }
}

restore.addEventListener("click", async () => {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
  render(DEFAULT_SETTINGS);
  status.textContent = "Defaults restored.";
  status.dataset.kind = "success";
});

const stored = await chrome.storage.local.get(SETTINGS_KEY);
render(normalizeSettings(stored[SETTINGS_KEY]));
