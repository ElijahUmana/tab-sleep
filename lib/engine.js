import {
  ALARM_NAME,
  CAPTURE_FORMAT,
  CAPTURE_QUALITY,
  METRICS_KEY,
  PREVIEW_INDEX_KEY,
  PREVIEW_LOAD_TIMEOUT_MS,
  RUNTIME_STATE_KEY,
  SCAN_PERIOD_MINUTES,
  SCAN_TICK_MS,
  SETTINGS_KEY,
  normalizeMetrics,
  normalizeSettings,
  previewStorageKey
} from "./constants.js";
import { getAwakeTabBlockReason, isPreviewableUrl, summarizeTabs } from "./policy.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
const message = (error) => String(error?.message ?? error);
// Marker proving an executeScript call came from this snapshot path. It must
// ride in `args` — real Chrome throws "Unexpected property" on unknown keys.
const DOM_SNAPSHOT_SENTINEL = "__tab_sleep_dom_snapshot__";

function emptyState() {
  return {
    signals: {},
    requestStartedAt: {},
    requestTabs: {},
    protectedTabIds: {},
    captures: {},
    frozenTabs: {},
    inactiveSince: {}
  };
}

function normalizeState(input = {}) {
  const result = emptyState();
  for (const key of Object.keys(result)) {
    result[key] = input[key] && typeof input[key] === "object" ? input[key] : {};
  }
  return result;
}

export class TabSleepEngine {
  constructor(chromeApi, clock = () => Date.now(), tokenFactory = () => crypto.randomUUID()) {
    this.chrome = chromeApi;
    this.clock = clock;
    this.tokenFactory = tokenFactory;
    this.previewUrlPrefix = chromeApi.runtime.getURL("preview/preview.html");
    this.stateQueue = Promise.resolve();
    this.scanQueue = Promise.resolve();
    this.metricsQueue = Promise.resolve();
    this.captureTasks = new Map();
    this.pendingPreviews = new Map();
    this.previewReady = new Map();
    this.requestFences = new Map();
    this.lastCaptureAt = new Map();
    this.ticker = null;
  }

  async start() {
    await this.ensureDefaults();
    await this.ensureAlarm();
    await this.reconcile();
    await this.injectTrackers();
    await this.refreshSignals();
    await this.scan();
    this.startTicker();
  }

  startTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.scan().catch((error) => console.error("[Tab Sleep] tick", error)), SCAN_TICK_MS);
    this.ticker?.unref?.();
  }

  stopTicker() {
    if (!this.ticker) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  async handleInstalled() { await this.start(); }
  async handleAlarm(alarm) { if (alarm.name === ALARM_NAME) await this.scan(); }
  async handleActivated(activeInfo) {
    await this.injectTrackers();
    await this.refreshSignals();
    const tab = Number.isInteger(activeInfo?.tabId) ? await this.chrome.tabs.get(activeInfo.tabId).catch(() => null) : null;
    if (tab) await this.capture(tab);
    await this.scan();
  }
  async handleCreated(tab) { if (isPreviewableUrl(tab?.url)) await this.injectTab(tab.id); await this.refreshSignals(); }

  async handleUpdated(tabId, changeInfo, tab) {
    // During navigation Chrome may expose the destination only through
    // changeInfo.url/pendingUrl while tab.url still names the old page. Prefer
    // the destination or the preview transition is mistaken for an ordinary
    // navigation and clearTab() deletes the snapshot before it can render.
    const nextUrl = changeInfo.url ?? tab.pendingUrl ?? tab.url;
    const token = this.previewToken(nextUrl);
    if (token) {
      await this.restorePreview({ ...tab, url: nextUrl }, token);
      return;
    }
    const state = await this.readState();
    const frozen = state.frozenTabs[String(tabId)];
    if (frozen) {
      const liveTab = await this.chrome.tabs.get(tabId).catch(() => null);
      const liveToken = this.previewToken(liveTab?.pendingUrl ?? liveTab?.url);
      // A delayed old-document update can arrive after PREVIEW_READY changed the
      // lifecycle to sleeping. If Chrome's current/pending tab is still our
      // preview, this event is stale and must never delete the durable visual.
      if (liveToken === frozen.token) return;
    }
    // freeze() owns the transition until PREVIEW_READY or rollback. Ignore
    // intermediate old-URL/loading events so onUpdated cannot delete the visual
    // between storage.set() and preview.js reading it.
    if (frozen?.status === "freezing") return;
    // wake() owns cleanup transactionally. onUpdated must not delete the only
    // recovery record while the original page is still navigating.
    if (frozen?.status === "waking" && nextUrl === frozen.originalUrl) return;
    if (changeInfo.url) await this.clearTab(tabId, `updated:${changeInfo.url}`);
    if (changeInfo.status === "complete" || tab.status === "complete") {
      await this.injectTab(tabId);
      await this.refreshSignals();
    }
  }

  async handleRemoved(tabId) { await this.clearTab(tabId, "removed"); }
  async handleReplaced(added, removed) { await this.clearTab(removed, `replaced-by:${added}`); await this.injectTab(added); await this.refreshSignals(); }
  async handleWindowFocusChanged() { await this.refreshSignals(); await this.scan(); }
  async handleWindowRemoved() { await this.refreshSignals(); }

  async handleStorageChanged(changes, area) {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    await this.refreshSignals();
    await this.scan();
  }

  async handleMessage(payload, sender) {
    switch (payload?.type) {
      case "PAGE_ACTIVITY_STATE": return this.handleSignal(payload, sender?.tab);
      case "PREVIEW_GET_RECORD": return this.getPreviewRecord(payload, sender?.tab);
      case "PREVIEW_READY": return this.handlePreviewReady(payload, sender?.tab);
      case "PREVIEW_FAILED": return this.handlePreviewFailed(payload, sender?.tab);
      case "WAKE_PREVIEW": return this.wake(payload.token, sender?.tab);
      case "GET_STATUS": return this.status();
      case "SCAN_NOW": await this.scan(); return this.status();
      case "SLEEP_OTHER_TABS": {
        const result = await this.queueScan(true);
        return { ...result, status: await this.status() };
      }
      case "SET_ENABLED": {
        const settings = await this.settings(); settings.enabled = Boolean(payload.enabled);
        await this.chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        await this.scan(); return this.status();
      }
      case "SET_CURRENT_TAB_PROTECTED": return this.setProtected(Boolean(payload.protected));
      default: throw new Error(`Unknown Tab Sleep message: ${payload?.type ?? "missing"}`);
    }
  }

  findPendingPreview(token) {
    for (const [key, record] of this.pendingPreviews) {
      if (!key.endsWith(`:${token}`)) continue;
      return { key, tabId: Number(key.slice(0, key.indexOf(":"))), record };
    }
    return null;
  }

  async resolvePreviewTab(token, senderTab = null) {
    const candidateIds = [];
    if (Number.isInteger(senderTab?.id)) candidateIds.push(senderTab.id);
    const pending = this.findPendingPreview(token);
    if (Number.isInteger(pending?.tabId)) candidateIds.push(pending.tabId);
    const state = await this.readState();
    for (const [key, frozen] of Object.entries(state.frozenTabs)) {
      if (frozen?.token === token) candidateIds.push(Number(key));
    }
    const local = await this.chrome.storage.local.get(PREVIEW_INDEX_KEY);
    const indexedTabId = local[PREVIEW_INDEX_KEY]?.[token]?.tabId;
    if (Number.isInteger(indexedTabId)) candidateIds.push(indexedTabId);
    for (const tabId of new Set(candidateIds.filter(Number.isInteger))) {
      const tab = await this.chrome.tabs.get(tabId).catch(() => null);
      if (tab && this.previewToken(tab.pendingUrl ?? tab.url) === token) return tab;
    }
    return null;
  }

  async getPreviewRecord(payload) {
    if (!payload?.token) return null;
    const pending = this.findPendingPreview(payload.token);
    if (pending) return clone(pending.record);
    // Navigation events and extension-page messages may expose stale/missing
    // sender.tab URLs. The random token is the authority; durable storage is
    // intentionally readable across service-worker restarts.
    const stored = await this.chrome.storage.local.get(previewStorageKey(payload.token));
    return stored[previewStorageKey(payload.token)] ?? null;
  }

  async handlePreviewReady(payload, tab) {
    if (!payload?.token) return { ready: false };
    const actualTab = await this.resolvePreviewTab(payload.token, tab);
    if (!actualTab) return { ready: false };
    const tabId = actualTab.id;
    const key = `${tabId}:${payload.token}`;
    this.previewReady.set(key, { at: this.clock(), kind: payload.kind ?? "unknown" });
    await this.mutate((state) => {
      const frozen = state.frozenTabs[String(tabId)];
      if (frozen?.token !== payload.token) return;
      frozen.status = "sleeping";
      frozen.verifiedSleeping = true;
    });
    return { ready: true };
  }

  async handlePreviewFailed(payload, tab) {
    if (!payload?.token) return { recovered: false };
    const actualTab = await this.resolvePreviewTab(payload.token, tab);
    if (!actualTab) return { recovered: false };
    const tabId = actualTab.id;
    const state = await this.readState();
    const frozen = state.frozenTabs[String(tabId)];
    const originalUrl = frozen?.token === payload.token ? frozen.originalUrl : null;
    if (!isPreviewableUrl(originalUrl)) return { recovered: false };
    await this.rollbackFailedFreeze({ id: tabId, url: originalUrl }, String(tabId), payload.token);
    return { recovered: true };
  }

  async handleSignal(payload, tab) {
    if (!Number.isInteger(tab?.id) || !isPreviewableUrl(tab.url)) return { tracked: false };
    const now = this.clock();
    const key = String(tab.id);
    await this.mutate((state) => {
      if (state.frozenTabs[key]) return;
      const prior = state.signals[key] ?? { lastActivityAt: now };
      const activity = Boolean(payload.activity);
      state.signals[key] = {
        at: now,
        visible: Boolean(payload.visible),
        busy: Boolean(payload.busy),
        bridgeReady: payload.bridgeReady !== false,
        lastActivityAt: activity ? now : prior.lastActivityAt
      };
      if (activity) delete state.captures[key];
      // Chrome window/tab topology protects genuinely visible tabs. A stale
      // document.hidden=false heartbeat from an unselected/off-Space tab must
      // not reset idle forever. Only real work or trusted user activity resets.
      if (payload.busy || activity) state.inactiveSince[key] = now;
      else if (!Number.isFinite(state.inactiveSince[key])) state.inactiveSince[key] = now;
    });
    if (payload.visible && tab.active) await this.capture(tab);
    return { tracked: true };
  }

  handleRequestStarted(details) {
    if (!Number.isInteger(details?.tabId) || details.tabId < 0 || !details.requestId) return;
    const key = String(details.tabId);
    // The in-memory fence is synchronous: freeze() can observe it even before
    // the queued session write completes.
    this.requestFences = this.requestFences ?? new Map();
    this.requestFences.set(details.requestId, details.tabId);
    void this.mutate((state) => {
      state.requestTabs[details.requestId] = details.tabId;
      state.requestStartedAt[details.requestId] = this.clock();
      if (state.signals[key]) state.signals[key].lastActivityAt = this.clock();
      delete state.captures[key];
    });
  }

  handleRequestFinished(details) {
    if (!details?.requestId) return;
    this.requestFences = this.requestFences ?? new Map();
    const fencedTabId = this.requestFences.get(details.requestId);
    this.requestFences.delete(details.requestId);
    void this.mutate((state) => {
      const tabId = state.requestTabs[details.requestId] ?? fencedTabId;
      if (!Number.isInteger(tabId)) return;
      const key = String(tabId);
      const startedAt = state.requestStartedAt[details.requestId];
      const elapsed = Number.isFinite(startedAt) ? this.clock() - startedAt : 0;
      delete state.requestTabs[details.requestId];
      delete state.requestStartedAt[details.requestId];
      // Quick polls are plumbing and do not change idle age. Substantial work
      // starts the full configured idle period when it completes.
      if (elapsed >= 3_000) state.inactiveSince[key] = this.clock();
      if (state.signals[key]) state.signals[key].lastActivityAt = this.clock();
    });
  }

  async ensureDefaults() {
    const [local, session] = await Promise.all([
      this.chrome.storage.local.get([SETTINGS_KEY, METRICS_KEY, PREVIEW_INDEX_KEY]),
      this.chrome.storage.session.get(RUNTIME_STATE_KEY)
    ]);
    await Promise.all([
      this.chrome.storage.local.set({
        [SETTINGS_KEY]: normalizeSettings(local[SETTINGS_KEY]),
        [METRICS_KEY]: normalizeMetrics(local[METRICS_KEY]),
        [PREVIEW_INDEX_KEY]: local[PREVIEW_INDEX_KEY] ?? {}
      }),
      this.chrome.storage.session.set({ [RUNTIME_STATE_KEY]: normalizeState(session[RUNTIME_STATE_KEY]) })
    ]);
  }

  async ensureAlarm() {
    const alarm = await this.chrome.alarms.get(ALARM_NAME);
    if (!alarm || alarm.periodInMinutes !== SCAN_PERIOD_MINUTES) {
      if (alarm) await this.chrome.alarms.clear(ALARM_NAME);
      await this.chrome.alarms.create(ALARM_NAME, { delayInMinutes: SCAN_PERIOD_MINUTES, periodInMinutes: SCAN_PERIOD_MINUTES });
    }
  }

  async reconcile() {
    const tabs = await this.chrome.tabs.query({});
    const valid = new Set(tabs.map((tab) => String(tab.id)));
    await this.mutate((state) => {
      for (const collection of [state.signals, state.protectedTabIds, state.captures, state.frozenTabs, state.inactiveSince]) {
        for (const key of Object.keys(collection)) if (!valid.has(key)) delete collection[key];
      }
      state.requestTabs = {};
      state.requestStartedAt = {};
    });
    for (const tab of tabs) {
      const token = this.previewToken(tab.url);
      if (token) await this.restorePreview(tab, token);
    }
  }

  async injectTrackers() {
    const tabs = await this.chrome.tabs.query({});
    await Promise.all(tabs.filter((tab) => isPreviewableUrl(tab.url)).map((tab) => this.injectTab(tab.id)));
  }

  async injectTab(tabId) {
    if (!this.chrome.scripting?.executeScript) return;
    try {
      await this.chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content/page-activity-bridge.js"] });
      await this.chrome.scripting.executeScript({ target: { tabId }, files: ["content/activity.js"] });
    } catch {}
  }

  async refreshSignals() {
    const tabs = await this.chrome.tabs.query({});
    const now = this.clock();
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id) || !isPreviewableUrl(tab.url)) continue;
      const key = String(tab.id);
      try {
        const [isolated, main] = await Promise.all([
          this.chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__TAB_SLEEP_SIGNAL__ ?? null }),
          this.chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => ({ busy: Boolean(globalThis.__TAB_SLEEP_REMOTE_BUSY__), ready: Boolean(globalThis.__TAB_SLEEP_PAGE_ACTIVITY_INSTALLED__) }) })
        ]);
        const signal = isolated?.[0]?.result;
        const remote = main?.[0]?.result;
        await this.mutate((state) => {
          if (!signal || !remote?.ready) return;
          // The tracker's own __TAB_SLEEP_SIGNAL__.bridgeReady is the source
          // of truth for whether the page-world bridge handshake completed.
          // Fabricating it here would mask pages where the bridge never ran.
          if (signal.bridgeReady !== true) return;
          const previous = state.signals[key] ?? {};
          state.signals[key] = {
            at: now,
            visible: Boolean(signal.visible),
            busy: Boolean(signal.busy || remote.busy),
            bridgeReady: true,
            lastActivityAt: Number.isFinite(previous.lastActivityAt) ? previous.lastActivityAt : now
          };
          if (state.signals[key].busy) state.inactiveSince[key] = now;
          else if (!Number.isFinite(state.inactiveSince[key])) state.inactiveSince[key] = now;
        });
        const currentState = await this.readState();
        const capture = currentState.captures[key];
        if (
          signal.visible &&
          tab.active &&
          (!capture || capture.url !== tab.url || !capture.hasImage)
        ) {
          await this.capture(tab);
        }
      } catch {}
    }
  }

  scan() { return this.queueScan(false); }
  queueScan(ignoreIdle) {
    const operation = this.scanQueue.then(() => this.performScan(ignoreIdle));
    this.scanQueue = operation.catch(() => {});
    return operation;
  }

  async authoritativeVisibleTabs(tabs = null) {
    const allTabs = tabs ?? await this.chrome.tabs.query({});
    let windowsById = null;
    try {
      const allWindows = await this.chrome.windows.getAll();
      if (Array.isArray(allWindows)) windowsById = new Map(allWindows.map((window) => [window.id, window]));
    } catch {}
    return new Set(
      allTabs
        .filter((tab) => {
          if (!tab.active || tab.windowId === this.chrome.windows.WINDOW_ID_NONE) return false;
          const window = windowsById?.get(tab.windowId);
          // Missing topology fails safe for a selected tab.
          return !window || window.state !== "minimized";
        })
        .map((tab) => String(tab.id))
    );
  }

  async performScan(ignoreIdle) {
    await this.refreshSignals();
    await this.stateQueue;
    const settings = await this.settings();
    const now = this.clock();
    if (!settings.enabled && !ignoreIdle) { await this.record([], [], now, {}); return { frozen: [], failures: [] }; }
    const tabs = await this.chrome.tabs.query({});
    const state = await this.readState();
    const forceVisible = await this.authoritativeVisibleTabs(tabs);
    const reasons = {};
    const candidates = [];
    for (const tab of tabs) {
      const reason = getAwakeTabBlockReason(tab, settings, state, now, { ignoreIdle, forceVisible });
      reasons[reason ?? "eligible"] = (reasons[reason ?? "eligible"] ?? 0) + 1;
      if (reason === null) candidates.push(tab);
    }
    const frozen = [], failures = [];
    for (const tab of candidates) {
      try { if (await this.freeze(tab, settings, ignoreIdle)) frozen.push(tab.id); }
      catch (error) { failures.push({ tabId: tab.id, error: message(error) }); }
    }
    await this.record(frozen, failures, now, reasons);
    await this.updateBadge();
    return { frozen, failures };
  }

  capture(tab) {
    if (this.captureTasks.has(tab.id)) return this.captureTasks.get(tab.id);
    const task = this.performCapture(tab).finally(() => this.captureTasks.delete(tab.id));
    this.captureTasks.set(tab.id, task);
    return task;
  }

  async performCapture(tab) {
    if (!tab.active || !isPreviewableUrl(tab.url) || tab.status !== "complete") return false;
    const key = String(tab.id);
    const now = this.clock();
    if (now - (this.lastCaptureAt.get(tab.id) ?? -Infinity) < 1000) return false;
    const before = await this.readState();
    if (!before.signals[key]?.visible || before.signals[key]?.busy) return false;
    try {
      this.lastCaptureAt.set(tab.id, now);
      const imageDataUrl = await this.chrome.tabs.captureVisibleTab(tab.windowId, { format: CAPTURE_FORMAT, quality: CAPTURE_QUALITY });
      const latest = await this.chrome.tabs.get(tab.id);
      if (latest.url !== tab.url || !latest.active) return false;
      const token = before.captures[key]?.token ?? this.tokenFactory();
      const capturedAt = this.clock();
      const record = { token, originalUrl: tab.url, title: tab.title ?? "Sleeping tab", imageDataUrl, capturedAt, frozenAt: null };
      await this.chrome.storage.local.set({ [previewStorageKey(token)]: record });
      await this.mutateIndex((index) => { index[token] = { tabId: tab.id, originalUrl: tab.url, updatedAt: capturedAt }; });
      await this.mutate((state) => {
        state.captures[key] = { token, url: tab.url, capturedAt, hasImage: typeof imageDataUrl === "string" && imageDataUrl.startsWith("data:image/") };
      });
      return true;
    } catch { return false; }
  }

  // Chrome can only screenshot the visible tab. For a tab whose window was never
  // on screen, the page itself serializes its exact rendered DOM instead — still
  // a true frozen visual (scripts stripped by the preview's sandbox), produced
  // without requiring the tab to be visible.
  async captureDomSnapshot(tab, token) {
    try {
      const results = await this.chrome.scripting.executeScript({
        target: { tabId: tab.id },
        // Sentinel travels via `args` — REAL Chrome rejects unknown detail
        // properties ("Unexpected property"), which silently killed every
        // freeze in 3.2.1 while the test fake accepted the marker.
        args: [DOM_SNAPSHOT_SENTINEL, tab.url],
        func: (sentinel, originalUrl) => {
          if (sentinel !== "__tab_sleep_dom_snapshot__") return null;
          // Work on a detached clone. The former implementation removed media,
          // frames, scripts and handlers from the LIVE page before navigation;
          // any failure left the user's page damaged.
          const clone = document.documentElement.cloneNode(true);
          for (const node of clone.querySelectorAll("script, noscript, iframe, object, embed, audio, video, meta[http-equiv='refresh' i]")) {
            node.remove();
          }
          for (const element of clone.querySelectorAll("*")) {
            for (const attribute of [...element.attributes]) {
              if (attribute.name.startsWith("on")) element.removeAttribute(attribute.name);
            }
          }
          const head = clone.querySelector("head");
          if (head && !head.querySelector("base")) {
            const base = document.createElement("base");
            base.href = originalUrl;
            head.prepend(base);
          }
          return {
            html: `<!doctype html>${clone.outerHTML}`,
            title: document.title,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            width: window.innerWidth,
            height: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio || 1
          };
        }
      });
      const snapshot = results?.[0]?.result;
      if (!snapshot || typeof snapshot.html !== "string" || snapshot.html.length < 20) return null;
      const capturedAt = this.clock();
      const record = {
        token,
        originalUrl: tab.url,
        title: snapshot.title || tab.title || "Sleeping tab",
        html: snapshot.html,
        scrollX: snapshot.scrollX ?? 0,
        scrollY: snapshot.scrollY ?? 0,
        width: snapshot.width ?? 0,
        height: snapshot.height ?? 0,
        devicePixelRatio: snapshot.devicePixelRatio ?? 1,
        capturedAt,
        frozenAt: null
      };
      await this.chrome.storage.local.set({ [previewStorageKey(token)]: record });
      await this.mutateIndex((index) => { index[token] = { tabId: tab.id, originalUrl: tab.url, updatedAt: capturedAt }; });
      return record;
    } catch { return null; }
  }

  async freeze(tab, settings, ignoreIdle) {
    await this.stateQueue;
    const current = await this.chrome.tabs.get(tab.id);
    const state = await this.readState();
    const commitVisible = await this.authoritativeVisibleTabs(await this.chrome.tabs.query({}));
    const openRequestIds = [...this.requestFences.entries()]
      .filter(([, tabId]) => tabId === current.id)
      .map(([requestId]) => requestId);
    if (openRequestIds.some((requestId) => {
      const startedAt = state.requestStartedAt[requestId];
      const elapsed = this.clock() - startedAt;
      return !Number.isFinite(startedAt) || elapsed <= 30_000;
    })) return false;
    if (getAwakeTabBlockReason(current, settings, state, this.clock(), { ignoreIdle, forceVisible: commitVisible }) !== null) return false;
    const key = String(tab.id);
    // Visual acquisition happens here, after every safety/idle gate passed.
    // A bitmap that is current for this URL is reused; otherwise the page
    // serializes its exact rendered DOM (works for never-visible windows).
    const existing = state.captures[key];
    let record = null;
    if (existing?.url === current.url && existing.hasImage) {
      const stored = await this.chrome.storage.local.get(previewStorageKey(existing.token));
      const candidate = stored[previewStorageKey(existing.token)];
      if (candidate?.imageDataUrl?.startsWith("data:image/") && candidate.originalUrl === current.url) {
        record = candidate;
      }
    }
    const token = record?.token ?? existing?.token ?? this.tokenFactory();
    if (!record) {
      record = await this.captureDomSnapshot(current, token);
    }
    if (!record || !(record.imageDataUrl?.startsWith("data:image/") || typeof record.html === "string")) return false;
    record.frozenAt = this.clock();
    await this.chrome.storage.local.set({ [previewStorageKey(token)]: record });
    await this.mutate((next) => {
      next.captures[key] = { token, url: current.url, capturedAt: record.capturedAt, hasImage: Boolean(record.imageDataUrl?.startsWith("data:image/")) || typeof record.html === "string" };
      next.frozenTabs[key] = { token, originalUrl: current.url, title: current.title ?? record.title, frozenAt: record.frozenAt, status: "freezing", verifiedSleeping: false };
      delete next.inactiveSince[key];
    });
    const storedCheck = await this.chrome.storage.local.get(previewStorageKey(token));
    if (!storedCheck[previewStorageKey(token)]) {
      await this.rollbackFailedFreeze(current, key, token);
      throw new Error(`Snapshot record was not readable before preview navigation for tab ${current.id}`);
    }
    const previewKey = `${current.id}:${token}`;
    this.pendingPreviews.set(previewKey, record);
    this.previewReady.delete(previewKey);
    await this.chrome.tabs.update(current.id, { url: `${this.previewUrlPrefix}?token=${encodeURIComponent(token)}` });
    // Navigating away from the original URL already destroys its renderer and
    // releases the live site. NEVER discard the lightweight preview: Chrome
    // shows a permanent loading spinner for discarded extension pages and
    // reloads them when selected, hiding the frozen visual behind a load.
    const settled = await this.waitForPreview(current.id, token, current.url);
    if (!settled) {
      await this.rollbackFailedFreeze(current, key, token);
      throw new Error(`Frozen preview URL did not finish loading for tab ${current.id}`);
    }
    await this.mutate((next) => {
      const frozen = next.frozenTabs[key]; if (!frozen) return;
      // A hidden Chromium tab may not execute/paint the preview until selected.
      // URL commit plus a durable visual is sufficient to sleep. PREVIEW_READY
      // later confirms rendering when the user selects the tab.
      frozen.verifiedSleeping = true;
      frozen.status = "sleeping";
    });
    return true;
  }

  async waitForPreview(tabId, token, originalUrl) {
    const expectedUrl = `${this.previewUrlPrefix}?token=${encodeURIComponent(token)}`;
    const attempts = Math.ceil(PREVIEW_LOAD_TIMEOUT_MS / 50);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const tab = await this.chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return false;
      const currentUrl = tab.pendingUrl ?? tab.url;
      if (currentUrl === expectedUrl && tab.status === "complete" && tab.discarded !== true) return tab;
      // tabs.update resolves before navigation commits; old URL is expected until
      // pendingUrl/URL flips. Only a third-party destination is an abort.
      if (tab.url !== originalUrl && currentUrl !== expectedUrl) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  async rollbackFailedFreeze(originalTab, key, token) {
    this.pendingPreviews.delete(`${originalTab.id}:${token}`);
    const current = await this.chrome.tabs.get(originalTab.id).catch(() => null);
    if (current && (this.previewToken(current.url) === token || this.previewToken(current.pendingUrl) === token)) {
      await this.chrome.tabs.update(originalTab.id, { url: originalTab.url }).catch(() => {});
    }
    await this.mutate((state) => {
      delete state.frozenTabs[key];
      delete state.captures[key];
      state.inactiveSince[key] = this.clock();
    });
    await this.chrome.storage.local.remove(previewStorageKey(token));
    await this.mutateIndex((index) => { delete index[token]; });
  }

  async wake(token, tab) {
    const actualTab = await this.resolvePreviewTab(token, tab);
    if (!actualTab) throw new Error("Wake request did not come from a preview tab");
    const tabId = actualTab.id;
    const key = String(tabId);
    const state = await this.readState(), frozen = state.frozenTabs[key];
    if (!frozen || frozen.token !== token || this.previewToken(actualTab.url) !== token) throw new Error("Wake request does not match this frozen tab");
    const stored = await this.chrome.storage.local.get(previewStorageKey(token));
    const record = stored[previewStorageKey(token)];
    if (!isPreviewableUrl(record?.originalUrl)) throw new Error("Original page URL is unavailable");
    await this.mutate((next) => {
      const target = next.frozenTabs[key];
      if (target?.token === token) target.status = "waking";
    });
    await this.chrome.tabs.update(tabId, { url: record.originalUrl });
    const loaded = await this.waitForUrlComplete(tabId, record.originalUrl);
    if (!loaded) {
      await this.chrome.tabs.update(tabId, { url: `${this.previewUrlPrefix}?token=${encodeURIComponent(token)}` }).catch(() => {});
      await this.mutate((next) => {
        const target = next.frozenTabs[key];
        if (target?.token === token) target.status = "sleeping";
      });
      throw new Error("Original page did not finish loading; frozen preview restored");
    }
    this.previewReady.delete(`${tabId}:${token}`);
    await this.clearTab(tabId, "wake-complete");
    await this.mutateMetrics((metrics) => { metrics.totalWoken++; metrics.lastWokenAt = this.clock(); });
    return { woken: true, url: record.originalUrl };
  }

  async waitForUrlComplete(tabId, expectedUrl) {
    const attempts = Math.ceil(PREVIEW_LOAD_TIMEOUT_MS / 50);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const tab = await this.chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return null;
      if (tab.status === "complete" && tab.url === expectedUrl) return tab;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  async restorePreview(tab, token) {
    const stored = await this.chrome.storage.local.get(previewStorageKey(token));
    const record = stored[previewStorageKey(token)];
    if (!record || !isPreviewableUrl(record.originalUrl) || !(record.imageDataUrl?.startsWith("data:image/") || typeof record.html === "string")) {
      // Never leave an orphan/broken extension page pretending to be asleep.
      const indexed = await this.chrome.storage.local.get(PREVIEW_INDEX_KEY);
      const originalUrl = indexed[PREVIEW_INDEX_KEY]?.[token]?.originalUrl;
      if (isPreviewableUrl(originalUrl)) await this.chrome.tabs.update(tab.id, { url: originalUrl }).catch(() => {});
      return;
    }
    const key = String(tab.id);
    await this.mutate((state) => {
      const existing = state.frozenTabs[key];
      // Preserve PREPARING/FREEZING until the preview itself reports that its
      // visual painted. Merely seeing the extension URL is not readiness.
      if (existing?.token === token && existing.status === "freezing") return;
      state.frozenTabs[key] = { token, originalUrl: record.originalUrl, title: record.title, frozenAt: record.frozenAt ?? record.capturedAt, status: "freezing", verifiedSleeping: false };
      state.captures[key] = { token, url: record.originalUrl, capturedAt: record.capturedAt, hasImage: Boolean(record.imageDataUrl) || typeof record.html === "string" };
      delete state.inactiveSince[key];
    });
  }

  async clearTab(tabId, reason = "unspecified") {
    const key = String(tabId), tokens = new Set();
    await this.mutate((state) => {
      if (state.captures[key]?.token) tokens.add(state.captures[key].token);
      if (state.frozenTabs[key]?.token) tokens.add(state.frozenTabs[key].token);
      for (const collection of [state.signals, state.protectedTabIds, state.captures, state.frozenTabs, state.inactiveSince]) delete collection[key];
    });
    for (const token of tokens) {
      await this.chrome.storage.local.remove(previewStorageKey(token));
      await this.mutateIndex((index) => { delete index[token]; });
    }
  }

  async setProtected(value) {
    const [tab] = await this.chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error("No active tab available");
    await this.mutate((state) => { if (value) state.protectedTabIds[String(tab.id)] = true; else delete state.protectedTabIds[String(tab.id)]; });
    return this.status();
  }

  async status() {
    const [tabs, settings, local] = await Promise.all([this.chrome.tabs.query({}), this.settings(), this.chrome.storage.local.get(METRICS_KEY)]);
    const state = await this.readState();
    const [current] = await this.chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const frozen = current ? state.frozenTabs[String(current.id)] : null;
    const forceVisible = await this.authoritativeVisibleTabs(tabs);
    return { settings, metrics: normalizeMetrics(local[METRICS_KEY]), summary: summarizeTabs(tabs, settings, state, this.clock(), this.previewUrlPrefix, forceVisible), currentTabProtected: current ? Boolean(state.protectedTabIds[String(current.id)]) : false, currentTabState: frozen?.status ?? "awake", currentTabVerifiedSleeping: Boolean(frozen?.verifiedSleeping), nextScanAt: (await this.chrome.alarms.get(ALARM_NAME))?.scheduledTime ?? null };
  }

  async settings() { const stored = await this.chrome.storage.local.get(SETTINGS_KEY); return normalizeSettings(stored[SETTINGS_KEY]); }

  async record(frozen, failures, now, reasons) {
    await this.mutateMetrics((metrics) => { metrics.totalFrozen += frozen.length; metrics.totalFailures += failures.length; metrics.lastScanAt = now; metrics.lastFrozenCount = frozen.length; metrics.lastScanReasons = reasons; metrics.lastError = failures.map((item) => `Tab ${item.tabId}: ${item.error}`).join("; ") || null; if (frozen.length) metrics.lastFrozenAt = now; });
  }

  async updateBadge() {
    const status = await this.status();
    await this.chrome.action.setBadgeBackgroundColor({ color: status.settings.enabled ? "#6d5dfc" : "#6b7280" });
    await this.chrome.action.setBadgeText({ text: status.settings.enabled ? (status.summary.frozen ? String(Math.min(status.summary.frozen, 99)) : "") : "OFF" });
  }

  previewToken(url) {
    if (typeof url !== "string" || !url.startsWith(this.previewUrlPrefix)) return null;
    try { return new URL(url).searchParams.get("token"); } catch { return null; }
  }

  async readState() { const stored = await this.chrome.storage.session.get(RUNTIME_STATE_KEY); return normalizeState(stored[RUNTIME_STATE_KEY]); }
  mutate(mutator) { const op = this.stateQueue.then(async () => { const state = await this.readState(); await mutator(state); await this.chrome.storage.session.set({ [RUNTIME_STATE_KEY]: state }); return clone(state); }); this.stateQueue = op.catch(() => {}); return op; }
  mutateMetrics(mutator) { const op = this.metricsQueue.then(async () => { const stored = await this.chrome.storage.local.get(METRICS_KEY); const metrics = normalizeMetrics(stored[METRICS_KEY]); await mutator(metrics); await this.chrome.storage.local.set({ [METRICS_KEY]: metrics }); return clone(metrics); }); this.metricsQueue = op.catch(() => {}); return op; }
  async mutateIndex(mutator) { const stored = await this.chrome.storage.local.get(PREVIEW_INDEX_KEY); const index = stored[PREVIEW_INDEX_KEY] ?? {}; await mutator(index); await this.chrome.storage.local.set({ [PREVIEW_INDEX_KEY]: index }); }
}
