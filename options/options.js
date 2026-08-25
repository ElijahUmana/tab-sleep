import {
  DEFAULT_SETTINGS,
  MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
  RULES_KEY,
  SETTINGS_KEY,
  normalizeSettings
} from "../lib/constants.js";
import { normalizeRules } from "../lib/rules.js";

const fields = {
  enabled: document.querySelector("#enabled"),
  idleMinutes: document.querySelector("#idleMinutes"),
  skipPinned: document.querySelector("#skipPinned"),
  skipAudible: document.querySelector("#skipAudible"),
  respectAutoDiscardable: document.querySelector("#respectAutoDiscardable"),
  skipLoading: document.querySelector("#skipLoading"),
  keepMutedPlayingAwake: document.querySelector("#keepMutedPlayingAwake"),
  pauseWhileCharging: document.querySelector("#pauseWhileCharging"),
  pauseWhenOffline: document.querySelector("#pauseWhenOffline")
};
const minBatteryField = document.querySelector("#minBatteryPercent");
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
  minBatteryField.value = settings.minBatteryPercent === null ? "" : String(settings.minBatteryPercent);
}

function readSettings() {
  return normalizeSettings({
    enabled: fields.enabled.checked,
    idleMinutes: fields.idleMinutes.value,
    skipPinned: fields.skipPinned.checked,
    skipAudible: fields.skipAudible.checked,
    respectAutoDiscardable: fields.respectAutoDiscardable.checked,
    skipLoading: fields.skipLoading.checked,
    keepMutedPlayingAwake: fields.keepMutedPlayingAwake.checked,
    pauseWhileCharging: fields.pauseWhileCharging.checked,
    pauseWhenOffline: fields.pauseWhenOffline.checked,
    minBatteryPercent: minBatteryField.value === "" ? null : minBatteryField.value
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

function setStatus(text, kind = "") {
  status.textContent = text;
  status.dataset.kind = kind;
}

for (const element of [...Object.values(fields), minBatteryField]) {
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

// ---- Rules section ---------------------------------------------------------

const ruleElements = {
  allowlistEnabled: document.querySelector("#allowlistEnabled"),
  denylistEnabled: document.querySelector("#denylistEnabled"),
  ruleType: document.querySelector("#ruleType"),
  rulePattern: document.querySelector("#rulePattern"),
  addAllowRule: document.querySelector("#addAllowRule"),
  addDenyRule: document.querySelector("#addDenyRule"),
  allowList: document.querySelector("#allowList"),
  denyList: document.querySelector("#denyList"),
  allowEmpty: document.querySelector("#allowEmpty"),
  denyEmpty: document.querySelector("#denyEmpty"),
  ruleTestUrl: document.querySelector("#ruleTestUrl"),
  ruleTestButton: document.querySelector("#ruleTestButton"),
  ruleTestResult: document.querySelector("#ruleTestResult")
};

let currentRules = normalizeRules({});

function sendEngine(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra }).then((response) => {
    if (response?.__tabSleepError) throw new Error(response.__tabSleepError);
    return response;
  });
}

const RULE_TYPE_LABELS = { domain: "Domain", "url-prefix": "URL prefix", regex: "Regular expression" };

function renderRules(rules) {
  currentRules = rules;
  for (const listName of ["allow", "deny"]) {
    const listElement = listName === "allow" ? ruleElements.allowList : ruleElements.denyList;
    const emptyElement = listName === "allow" ? ruleElements.allowEmpty : ruleElements.denyEmpty;
    listElement.replaceChildren();
    for (const rule of rules[listName]) {
      const item = document.createElement("li");
      item.className = "rule-item";
      const main = document.createElement("div");
      main.className = "rule-item-main";
      const pattern = document.createElement("span");
      pattern.className = "pattern";
      pattern.textContent = rule.pattern;
      const type = document.createElement("span");
      type.className = "type";
      type.textContent = RULE_TYPE_LABELS[rule.type] ?? rule.type;
      main.append(pattern, type);
      const actions = document.createElement("div");
      actions.className = "rule-item-actions";
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "Remove";
      removeButton.classList.add("text-button", "danger-text-button");
      removeButton.addEventListener("click", () => {
        const updated = normalizeRules({
          ...rules,
          [listName]: rules[listName].filter((candidate) => candidate !== rule)
        });
        void saveRules(updated).catch((error) => setStatus(error.message, "error"));
      });
      actions.append(removeButton);
      item.append(main, actions);
      listElement.append(item);
    }
    emptyElement.hidden = rules[listName].length > 0;
  }
  ruleElements.allowlistEnabled.checked = rules.allowlistEnabled;
  ruleElements.denylistEnabled.checked = rules.denylistEnabled;
}

async function saveRules(rules) {
  const response = await sendEngine("SET_RULES", { rules });
  renderRules(response.rules);
  setStatus("Rules saved.", "success");
}

function readRuleForm() {
  return {
    type: ruleElements.ruleType.value,
    pattern: ruleElements.rulePattern.value.trim()
  };
}

async function addRule(listName) {
  const { type, pattern } = readRuleForm();
  if (!pattern) {
    setStatus("Enter a pattern first.", "error");
    return;
  }
  if (type === "regex") {
    try { new RegExp(pattern); } catch (error) {
      setStatus(`Invalid regular expression: ${error.message}`, "error");
      return;
    }
  }
  // normalizeRules drops invalid entries, so validate through it before save.
  const candidate = normalizeRules({ [listName]: [{ type, pattern }] });
  if (candidate[listName].length !== 1) {
    setStatus("That rule could not be parsed. Check the pattern.", "error");
    return;
  }
  await saveRules(normalizeRules({
    ...currentRules,
    [listName]: [...currentRules[listName], candidate[listName][0]]
  }));
  ruleElements.rulePattern.value = "";
}

ruleElements.addAllowRule.addEventListener("click", () => void addRule("allow").catch((error) => setStatus(error.message, "error")));
ruleElements.addDenyRule.addEventListener("click", () => void addRule("deny").catch((error) => setStatus(error.message, "error")));

for (const element of [ruleElements.allowlistEnabled, ruleElements.denylistEnabled]) {
  element.addEventListener("change", () => {
    void saveRules(normalizeRules({ ...currentRules, allowlistEnabled: ruleElements.allowlistEnabled.checked, denylistEnabled: ruleElements.denylistEnabled.checked }))
      .catch((error) => setStatus(error.message, "error"));
  });
}

ruleElements.ruleTestButton.addEventListener("click", async () => {
  const url = ruleElements.ruleTestUrl.value.trim();
  if (!url) {
    ruleElements.ruleTestResult.textContent = "Enter a URL to test.";
    return;
  }
  try {
    const result = await sendEngine("TEST_RULES", { url });
    if (result.verdict === "allow-rule") {
      ruleElements.ruleTestResult.textContent = `Allowed by ${RULE_TYPE_LABELS[result.allowMatch.type]?.toLowerCase() ?? result.allowMatch.type}: ${result.allowMatch.pattern}`;
    } else if (result.verdict === "deny-rule") {
      ruleElements.ruleTestResult.textContent = `Denied by ${RULE_TYPE_LABELS[result.denyMatch.type]?.toLowerCase() ?? result.denyMatch.type}: ${result.denyMatch.pattern}`;
    } else {
      ruleElements.ruleTestResult.textContent = "No rule matches this URL.";
    }
  } catch (error) {
    ruleElements.ruleTestResult.textContent = `Test failed: ${error.message}`;
  }
});

void (async () => {
  try {
    const stored = await chrome.storage.local.get(RULES_KEY);
    renderRules(normalizeRules(stored[RULES_KEY]));
    const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [null]);
    if (current?.url && current.url.startsWith("http")) {
      ruleElements.ruleTestUrl.value = current.url;
      ruleElements.rulePattern.placeholder = new URL(current.url).hostname;
    }
  } catch (error) {
    status.textContent = `Could not load rules: ${error.message}`;
    status.dataset.kind = "error";
  }
})();
