import { TabSleepEngine } from "./lib/engine.js";
import { PREVIEW_INDEX_KEY, RUNTIME_STATE_KEY, SESSIONS_SNAPSHOT_ALARM_NAME, SETTINGS_KEY } from "./lib/constants.js";
import { SessionsManager, searchHistory } from "./lib/sessions.js";
import { PreviewStore } from "./lib/preview-store.js";
import { domainOf } from "./lib/policy.js";

// One shared IndexedDB store: the engine writes/deletes frozen records,
// sessions only consult token existence for still-sleeping restores.
const previewStore = new PreviewStore();
const engine = new TabSleepEngine(chrome, undefined, undefined, { previewStore });
const sessions = new SessionsManager(chrome, undefined, undefined, { previewStore });

function run(label, operation) {
  void operation().catch((error) => {
    console.error(`[Tab Sleep] ${label} failed`, error);
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  run("installation", () => Promise.all([engine.handleInstalled(details), sessions.reconcileAfterRestart()]));
});

// Auto snapshots are debounced (~10 min cadence) and only fire when tab
// topology actually changed since the last snapshot.
function markSessionsDirty() {
  sessions.markDirty();
}

async function startWithSessions() {
  await sessions.reconcileAfterRestart(async () => {
    const [state, index] = await Promise.all([
      chrome.storage.session.get(RUNTIME_STATE_KEY),
      chrome.storage.local.get(PREVIEW_INDEX_KEY)
    ]);
    return { frozenTabs: state[RUNTIME_STATE_KEY]?.frozenTabs ?? {}, previewIndex: index[PREVIEW_INDEX_KEY] ?? {} };
  });
  await engine.start();
}

chrome.runtime.onStartup.addListener(() => {
  run("startup", () => startWithSessions());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  run("alarm", () => alarm.name === SESSIONS_SNAPSHOT_ALARM_NAME ? sessions.takeAutoSnapshot() : engine.handleAlarm(alarm));
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  run("tab activation", () => engine.handleActivated(activeInfo));
});

chrome.tabs.onCreated.addListener((tab) => {
  markSessionsDirty();
  run("tab creation", () => engine.handleCreated(tab));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") markSessionsDirty();
  run("tab update", () => engine.handleUpdated(tabId, changeInfo, tab));
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  markSessionsDirty();
  run("tab removal", () => engine.handleRemoved(tabId, removeInfo));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  run("tab replacement", () => engine.handleReplaced(addedTabId, removedTabId));
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  run("window focus", () => engine.handleWindowFocusChanged(windowId));
});

chrome.windows.onRemoved.addListener((windowId) => {
  run("window removal", () => engine.handleWindowRemoved(windowId));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  run("settings update", () => engine.handleStorageChanged(changes, areaName));
});

// ---- Keyboard commands and context menus -----------------------------------

chrome.commands.onCommand.addListener((command) => {
  run(`command ${command}`, async () => {
    switch (command) {
      case "freeze-current-tab":
        await engine.freezeTabs("current");
        break;
      case "freeze-window":
        await engine.freezeTabs("window");
        break;
      case "wake-all-tabs":
        await engine.wakeTabs("all");
        break;
      case "toggle-enabled": {
        const settings = await engine.settings();
        settings.enabled = !settings.enabled;
        await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        await engine.scan();
        break;
      }
      default: throw new Error(`Unknown command: ${command}`);
    }
  });
});

const CONTEXT_MENU_ROOT = "tab-sleep-root";

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: CONTEXT_MENU_ROOT, title: "Tab Sleep", contexts: ["page", "link"] });
    chrome.contextMenus.create({ id: "freeze-this-tab", parentId: CONTEXT_MENU_ROOT, title: "Freeze this tab", contexts: ["page"] });
    chrome.contextMenus.create({ id: "freeze-others", parentId: CONTEXT_MENU_ROOT, title: "Freeze other tabs in this window", contexts: ["page"] });
    chrome.contextMenus.create({ id: "freeze-all-windows", parentId: CONTEXT_MENU_ROOT, title: "Freeze eligible tabs everywhere", contexts: ["page"] });
    chrome.contextMenus.create({ id: "keep-domain-1h", parentId: CONTEXT_MENU_ROOT, title: "Keep this site awake for 1 hour", contexts: ["page"] });
    chrome.contextMenus.create({ id: "keep-link-domain-1h", title: "Keep %s awake for 1 hour", contexts: ["link"] });
    chrome.contextMenus.create({ id: "sep-wake", parentId: CONTEXT_MENU_ROOT, type: "separator", contexts: ["page"] });
    chrome.contextMenus.create({ id: "wake-window", parentId: CONTEXT_MENU_ROOT, title: "Wake frozen tabs in this window", contexts: ["page"] });
    chrome.contextMenus.create({ id: "wake-all", parentId: CONTEXT_MENU_ROOT, title: "Wake all frozen tabs", contexts: ["page"] });
  });
}

// Context-menu info carries the page/link URL directly; resolve the tab from
// the event rather than the last-focused window so right-clicks in any
// window target the right tab.
async function menuTargetTab(info) {
  if (!Number.isInteger(info?.tabId) || info.tabId < 0) throw new Error("No tab for this context-menu entry");
  return chrome.tabs.get(info.tabId);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  run(`context menu ${info.menuItemId}`, async () => {
    switch (info.menuItemId) {
      case "freeze-this-tab":
        if (!(tab && Number.isInteger(tab.id))) throw new Error("No tab for this context-menu entry");
        await engine.freezeTabs("current");
        break;
      case "freeze-others":
        await engine.freezeTabs("others");
        break;
      case "freeze-all-windows":
        await engine.freezeTabs("all");
        break;
      case "keep-domain-1h":
        await engine.addTemporaryKeepAwake("domain", undefined, 60);
        break;
      case "keep-link-domain-1h": {
        const linkUrl = String(info.linkUrl ?? "");
        const domain = domainOf(linkUrl);
        if (!domain) throw new Error("Link URL has no domain");
        await engine.addTemporaryKeepAwake("domain", domain, 60);
        break;
      }
      case "wake-window":
        await engine.wakeTabs("window");
        break;
      case "wake-all":
        await engine.wakeTabs("all");
        break;
      default:
        if (info.menuItemId !== CONTEXT_MENU_ROOT) throw new Error(`Unknown context menu item: ${info.menuItemId}`);
    }
  });
});

setupContextMenus();


const requestFilter = { urls: ["http://*/*", "https://*/*"] };
chrome.webRequest.onBeforeRequest.addListener((details) => engine.handleRequestStarted(details), requestFilter);
chrome.webRequest.onCompleted.addListener((details) => engine.handleRequestFinished(details), requestFilter);
chrome.webRequest.onErrorOccurred.addListener((details) => engine.handleRequestFinished(details), requestFilter);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  routeMessage(message, sender).then(
    (result) => sendResponse(result),
    (error) => sendResponse({ __tabSleepError: String(error?.message ?? error) })
  );
  return true;
});

async function routeMessage(message, sender) {
  if (message?.type?.startsWith("SESSIONS_")) return handleSessionsMessage(message);
  return engine.handleMessage(message, sender);
}

async function handleSessionsMessage(message) {
  switch (message.type) {
    case "SESSIONS_LIST": {
      const [list, manifest] = await Promise.all([sessions.listSessions(), sessions.getRecoveryManifest()]);
      return { sessions: list, recoveryUpdatedAt: manifest.updatedAt ?? null };
    }
    case "SESSIONS_SAVE_NAMED": return { session: await sessions.saveNamedSession(message.name) };
    case "SESSIONS_DELETE": return sessions.deleteSession(message.sessionId);
    case "SESSIONS_RESTORE_SESSION": return sessions.restoreSession(message.sessionId);
    case "SESSIONS_RESTORE_WINDOW": return sessions.restoreWindow(message.sessionId, message.windowIndex);
    case "SESSIONS_RESTORE_GROUP": return sessions.restoreGroup(message.sessionId, message.groupIndex);
    case "SESSIONS_RESTORE_TAB": return sessions.restoreTab(message.sessionId, message.entryIndex);
    case "SESSIONS_SEARCH_HISTORY": {
      const storage = await sessions.readStorage();
      return { history: searchHistory(storage.history, message.query) };
    }
    case "SESSIONS_EXPORT": return { payload: await sessions.exportAll() };
    case "SESSIONS_IMPORT": return sessions.importAll(String(message.payloadText ?? ""));
    case "SESSIONS_RECOVERY_MANIFEST": return { manifest: await sessions.getRecoveryManifest() };
    case "SESSIONS_RECOVER_TAB": return sessions.recoverFromManifest(String(message.token ?? ""));
    case "SESSIONS_SNAPSHOT_NOW": return { session: await sessions.takeAutoSnapshot() };
    default: throw new Error(`Unknown Tab Sleep sessions message: ${message?.type ?? "missing"}`);
  }
}

run("initialization", () => startWithSessions());
