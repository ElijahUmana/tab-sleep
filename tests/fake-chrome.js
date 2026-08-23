const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function select(data, keys) {
  if (keys == null) return clone(data);
  if (typeof keys === "string") return keys in data ? { [keys]: clone(data[keys]) } : {};
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, clone(data[key])]));
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(data[key] ?? fallback)]));
}
function area(initial = {}) {
  const data = clone(initial);
  return { data, async get(keys) { return select(data, keys); }, async set(values) { Object.assign(data, clone(values)); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }, async clear() { for (const key of Object.keys(data)) delete data[key]; } };
}
function matches(tab, query) {
  if (query.active !== undefined && tab.active !== query.active) return false;
  if (query.windowId !== undefined && tab.windowId !== query.windowId) return false;
  if (query.lastFocusedWindow && tab.windowId !== 1) return false;
  return true;
}
export function makeTab(id, overrides = {}) {
  return { id, windowId: 1, active: false, discarded: false, pinned: false, audible: false, autoDiscardable: true, status: "complete", url: `https://example.com/tab-${id}`, title: `Tab ${id}`, ...overrides };
}
export function createFakeChrome(initialTabs = [], options = {}) {
  const tabs = initialTabs.map(clone), local = area(options.local), session = area(options.session), alarms = new Map();
  const signals = new Map(Object.entries(options.signals ?? {}).map(([key, value]) => [Number(key), value]));
  const origin = "chrome-extension://tab-sleep-test/";
  const calls = { captured: [], updated: [], discarded: [], executed: [], badges: [] };
  const chromeApi = {
    calls, tabsData: tabs, signals, testOptions: options, storage: { local, session },
    tabs: {
      async query(query = {}) { return tabs.filter((tab) => matches(tab, query)).map(clone); },
      async get(id) { const tab = tabs.find((item) => item.id === id); if (!tab) throw new Error(`No tab ${id}`); return clone(tab); },
      async update(id, changes) {
        const tab = tabs.find((item) => item.id === id);
        Object.assign(tab, clone(changes));
        if (changes.url) {
          tab.url = changes.url;
          tab.status = options.previewNeverCompletes && changes.url.startsWith(origin) ? "loading" : "complete";
          tab.discarded = false;
          if (changes.url.startsWith(`${origin}preview/preview.html`) && options.autoPreviewReady !== false) {
            const token = new URL(changes.url).searchParams.get("token");
            queueMicrotask(() => options.onPreviewReady?.({ tabId: id, token, url: changes.url }));
          }
        }
        calls.updated.push({ id, changes: clone(changes) });
        return clone(tab);
      },
      async discard(id) { const tab = tabs.find((item) => item.id === id); if (options.discardFailureIds?.includes(id)) throw new Error("discard refused"); if (!tab.active) tab.discarded = true; calls.discarded.push(id); return clone(tab); },
      async captureVisibleTab(windowId, details) { const tab = tabs.find((item) => item.windowId === windowId && item.active); if (!tab) throw new Error("no active tab"); calls.captured.push({ windowId, tabId: tab.id, details }); return "data:image/png;base64,AAAA"; }
    },
    scripting: {
      async executeScript(details) {
        calls.executed.push(clone({ target: details.target, world: details.world, files: details.files, func: Boolean(details.func) }));
        // Real Chrome throws "Unexpected property" on unknown detail keys —
        // mirror that so tests catch invalid executeScript payloads.
        const allowed = ["target", "func", "args", "world", "files", "injectImmediately", "matchOriginAsFallback"];
        for (const key of Object.keys(details)) {
          if (!allowed.includes(key)) throw new Error(`Unexpected property: '${key}'.`);
        }
        if (!details.func) return [];
        const signal = signals.get(details.target.tabId);
        const sentinel = "__tab_sleep_dom_snapshot__";
        if (Array.isArray(details.args) && details.args[0] === sentinel) {
          if (signal?.domSnapshot === false) return [{ result: null }];
          const tab = tabs.find((item) => item.id === details.target.tabId);
          return [{ result: { html: `<html><body><h1>${tab?.title ?? "page"}</h1></body></html>`, title: tab?.title, scrollX: 0, scrollY: 0, width: 1280, height: 800, devicePixelRatio: 1 } }];
        }
        if (details.world === "MAIN") return [{ result: { busy: Boolean(signal?.remoteBusy), ready: signal?.bridgeReady !== false } }];
        // Mirrors content/activity.js. A tab whose tracker was never injected
        // (no signals entry at all) returns null — the real globalThis probe
        // would be undefined there. An entry with trackerReady:false also
        // returns null, mirroring a tracker that never initialized.
        if (!signal || signal.trackerReady === false) return [{ result: null }];
        return [{ result: { visible: Boolean(signal.visible), busy: Boolean(signal.localBusy), bridgeReady: signal.bridgeReady !== false } }];
      }
    },
    windows: { WINDOW_ID_NONE: -1, async getLastFocused() { return { id: 1, focused: true }; }, async getAll() { return tabs.filter((tab, index, list) => list.findIndex((item) => item.windowId === tab.windowId) === index).map((tab) => ({ id: tab.windowId, state: options.windowStates?.[tab.windowId] ?? "normal" })); } },
    alarms: { async get(name) { return clone(alarms.get(name)); }, async create(name, info) { alarms.set(name, { name, ...clone(info), scheduledTime: 30000 }); }, async clear(name) { return alarms.delete(name); } },
    action: { async setBadgeText(details) { calls.badges.push(details); }, async setBadgeBackgroundColor() {} },
    runtime: { getURL(path) { return `${origin}${path}`; }, async openOptionsPage() {} }
  };
  options.onPreviewReady = async ({ tabId, token }) => {
    const engine = options.engineRef?.current;
    if (!engine) return;
    await engine.handlePreviewReady({ token, kind: "test" }, await chromeApi.tabs.get(tabId));
  };
  return chromeApi;
}
