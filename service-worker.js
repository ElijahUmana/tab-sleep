import { TabSleepEngine } from "./lib/engine.js";

const engine = new TabSleepEngine(chrome);

function run(label, operation) {
  void operation().catch((error) => {
    console.error(`[Tab Sleep] ${label} failed`, error);
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  run("installation", () => engine.handleInstalled(details));
});

chrome.runtime.onStartup.addListener(() => {
  run("startup", () => engine.start());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  run("alarm", () => engine.handleAlarm(alarm));
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  run("tab activation", () => engine.handleActivated(activeInfo));
});

chrome.tabs.onCreated.addListener((tab) => {
  run("tab creation", () => engine.handleCreated(tab));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  run("tab update", () => engine.handleUpdated(tabId, changeInfo, tab));
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
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


const requestFilter = { urls: ["http://*/*", "https://*/*"] };
chrome.webRequest.onBeforeRequest.addListener((details) => engine.handleRequestStarted(details), requestFilter);
chrome.webRequest.onCompleted.addListener((details) => engine.handleRequestFinished(details), requestFilter);
chrome.webRequest.onErrorOccurred.addListener((details) => engine.handleRequestFinished(details), requestFilter);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  engine.handleMessage(message, sender).then(
    (result) => sendResponse(result),
    (error) => sendResponse({ __tabSleepError: String(error?.message ?? error) })
  );
  return true;
});

run("initialization", () => engine.start());
