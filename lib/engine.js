import {
  ALARM_NAME,
  BATTERY_REFRESH_ALARM_NAME,
  CAPTURE_FORMAT,
  CAPTURE_QUALITY,
  METRICS_KEY,
  POWER_STATE_KEY,
  PREVIEW_INDEX_KEY,
  PREVIEW_LOAD_TIMEOUT_MS,
  RUNTIME_STATE_KEY,
  RULES_KEY,
  SCAN_PERIOD_MINUTES,
  SCAN_TICK_MS,
  SETTINGS_KEY,
  TEMPORARY_GRANTS_KEY,
  WAKE_TX_KEY,
  normalizeMetrics,
  normalizeSettings
} from "./constants.js";
import { getAwakeTabBlockReason, getAwakeBlockReasons, isPreviewableUrl, reasonLabel, summarizeTabs, domainOf } from "./policy.js";
import { FullPageCapturer } from "./full-page-capture.js";
import { KEEP_AWAKE_SCOPES, TEMPORARY_GRANT_MAX_MINUTES, evaluateRules, firstMatchingRule, grantKey, normalizeGrants, normalizeRules } from "./rules.js";
import { PreviewStore, dataUrlToBytes } from "./preview-store.js";

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
    inactiveSince: {},
    temporaryGrants: {}
  };
}

async function normalizeState(input = {}) {
  const result = emptyState();
  for (const key of Object.keys(result)) {
    result[key] = input[key] && typeof input[key] === "object" ? input[key] : {};
  }
  // Grants expire on their own; prune stale entries whenever state normalizes.
  if (input.now !== undefined) {
    result.temporaryGrants = normalizeGrants({ grants: result.temporaryGrants, now: input.now });
  }
  return result;
}

export class TabSleepEngine {
  constructor(chromeApi, clock = () => Date.now(), tokenFactory = () => crypto.randomUUID(), options = {}) {
    this.chrome = chromeApi;
    this.clock = clock;
    this.tokenFactory = tokenFactory;
    this.previewUrlPrefix = chromeApi.runtime.getURL("preview/preview.html");
    this.stateQueue = Promise.resolve();
    this.scanQueue = Promise.resolve();
    this.metricsQueue = Promise.resolve();
    this.wakeTxQueue = Promise.resolve();
    this.captureTasks = new Map();
    this.pendingPreviews = new Map();
    this.previewReady = new Map();
    this.requestFences = new Map();
    this.lastCaptureAt = new Map();
    this.fullPageCapturer = new FullPageCapturer(chromeApi);
    // Binary preview records live in IndexedDB (lib/preview-store.js), not
    // chrome.storage.local. Tests inject a store backed by the fake IDB.
    this.previewStore = options?.previewStore ?? new PreviewStore({ indexedDb: options?.indexedDb });
    // The preview navigates itself immediately after WAKE_BEGIN returns, so a
    // short commit grace is enough before treating a wake as failed; bulk
    // wakes keep the full timeout.
    this.failedWakeGraceMs = Number.isFinite(options?.failedWakeGraceMs) ? options.failedWakeGraceMs : PREVIEW_LOAD_TIMEOUT_MS;
    this.ticker = null;
  }

  async start() {
    await this.ensureDefaults();
    await this.migratePreviewRecords();
    await this.ensureAlarm();
    await this.reconcile();
    await this.injectTrackers();
    await this.refreshSignals();
    await this.scan();
    this.startTicker();
  }

  // One-shot conversion of 4.x Base64 chrome.storage.local records into the
  // IndexedDB store. Idempotent: interrupted migrations resume on next start.
  async migratePreviewRecords() {
    try {
      const outcome = await this.previewStore.migrateLegacyRecords(this.chrome.storage.local);
      if (outcome.failed.length > 0) {
        console.error(`[Tab Sleep] ${outcome.failed.length} legacy preview record(s) could not be migrated and were left in place`, outcome.failed);
      }
      return outcome;
    } catch (error) {
      // A broken IDB must not take the whole worker down; legacy records stay
      // readable and the next start retries.
      console.error("[Tab Sleep] preview record migration failed", error);
      return { migrated: 0, failed: [] };
    }
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
      case "WAKE_BEGIN": return this.beginWake(payload.token, sender?.tab);
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
      case "SET_RULES": return this.setRules(payload.rules);
      case "TEST_RULES": return this.testRules(payload.url);
      case "ADD_TEMPORARY_KEEP_AWAKE": return this.addTemporaryKeepAwake(payload.scope, payload.value, payload.minutes);
      case "CLEAR_TEMPORARY_KEEP_AWAKE": return this.clearTemporaryKeepAwake(payload.key ?? payload.scope, payload.value);
      case "FREEZE_TABS": return this.freezeTabs(payload.scope);
      case "WAKE_TABS": return this.wakeTabs(payload.scope);
      case "WHY_CURRENT_TAB": return this.whyCurrentTab();
      default: throw new Error(`Unknown Tab Sleep message: ${payload?.type ?? "missing"}`);
    }
  }

  async setRules(rules) {
    const normalized = normalizeRules(rules);
    await this.chrome.storage.local.set({ [RULES_KEY]: normalized });
    await this.scan();
    return { rules: normalized };
  }

  async testRules(url) {
    if (typeof url !== "string") throw new Error("testRules requires a URL string");
    const stored = await this.chrome.storage.local.get(RULES_KEY);
    const rules = normalizeRules(stored[RULES_KEY]);
    const allow = firstMatchingRule(url, rules.allow);
    const deny = firstMatchingRule(url, rules.deny);
    return {
      url,
      verdict: evaluateRules(url, rules),
      allowMatch: allow ? { type: allow.type, pattern: allow.pattern } : null,
      denyMatch: deny ? { type: deny.type, pattern: deny.pattern } : null
    };
  }

  async currentTab() {
    const [tab] = await this.chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab ?? null;
  }

  async addTemporaryKeepAwake(scope, value, minutes) {
    if (!Object.values(KEEP_AWAKE_SCOPES).includes(scope)) throw new Error(`Unknown keep-awake scope: ${scope ?? "missing"}`);
    let resolvedValue = value;
    // Tab/domain/window/group scopes default to the current tab's identity
    // when the caller does not supply an explicit value.
    if (scope !== KEEP_AWAKE_SCOPES.DURATION && value === undefined) {
      const tab = await this.currentTab();
      if (!tab) throw new Error("No active tab available");
      if (scope === KEEP_AWAKE_SCOPES.TAB) {
        resolvedValue = tab.id;
      } else if (scope === KEEP_AWAKE_SCOPES.DOMAIN) {
        resolvedValue = domainOf(tab.url);
        if (!resolvedValue) throw new Error("Current tab has no domain");
      } else if (scope === KEEP_AWAKE_SCOPES.WINDOW) {
        resolvedValue = tab.windowId;
      } else if (scope === KEEP_AWAKE_SCOPES.GROUP) {
        if (!Number.isInteger(tab.groupId) || tab.groupId === -1) throw new Error("Current tab is not in a tab group");
        resolvedValue = tab.groupId;
      }
    }
    const key = grantKey(scope, scope === KEEP_AWAKE_SCOPES.DURATION ? "" : resolvedValue);
    const now = this.clock();
    const durationMinutes = Number.isFinite(Number(minutes))
      ? Math.min(TEMPORARY_GRANT_MAX_MINUTES, Math.max(1, Math.round(Number(minutes))))
      : null;
    const expiresAt = durationMinutes ? now + durationMinutes * 60_000 : Infinity;
    await this.mutate((state) => {
      state.temporaryGrants[key] = { scope, createdAt: now, expiresAt };
    });
    await this.scan();
    return { key, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
  }

  async clearTemporaryKeepAwake(keyOrScope, value) {
    if (!keyOrScope) throw new Error("clearTemporaryKeepAwake requires a key or scope");
    const removed = [];
    await this.mutate((state) => {
      const prefix = `${keyOrScope}:`;
      for (const key of Object.keys(state.temporaryGrants)) {
        if (key !== keyOrScope && !key.startsWith(prefix)) continue;
        if (value !== undefined && key !== grantKey(keyOrScope, value)) continue;
        delete state.temporaryGrants[key];
        removed.push(key);
      }
    });
    await this.scan();
    return { removed };
  }

  async freezeTabs(scope) {
    const targets = await this.tabsForScope(scope);
    const settings = await this.settings();
    const frozen = [], failures = [];
    for (const tab of targets) {
      try { if (await this.freeze(tab, settings, true)) frozen.push(tab.id); }
      catch (error) { failures.push({ tabId: tab.id, error: message(error) }); }
    }
    return { frozen, failures, status: await this.status() };
  }

  async wakeTabs(scope) {
    if (!["current", "others", "window", "group", "all"].includes(scope)) throw new Error(`Unknown freeze/wake scope: ${scope ?? "missing"}`);
    const current = await this.currentTab();
    const tabs = await this.chrome.tabs.query({});
    const state = await this.readState();
    const woken = [], failures = [];
    for (const [key, frozen] of Object.entries(state.frozenTabs)) {
      const tabId = Number(key);
      if (!Number.isInteger(tabId)) continue;
      const tab = tabs.find((candidate) => candidate.id === tabId);
      // Frozen records without a live preview page cannot be woken; reconcile()
      // cleans those up instead.
      if (!tab || this.previewToken(tab.pendingUrl ?? tab.url) !== frozen.token) continue;
      if (!this.frozenTabInWakeScope(tab, scope, current)) continue;
      try { await this.wake(frozen.token); woken.push(tabId); }
      catch (error) { failures.push({ tabId, error: message(error) }); }
    }
    return { woken, failures, status: await this.status() };
  }

  frozenTabInWakeScope(tab, scope, current) {
    switch (scope) {
      case "all": return true;
      case "current": return Boolean(current) && tab.id === current.id;
      case "others": return Boolean(current) && tab.windowId === current.windowId && tab.id !== current.id;
      case "window": return Boolean(current) && tab.windowId === current.windowId;
      case "group": return Boolean(current) && Number.isInteger(current.groupId) && current.groupId !== -1 && tab.groupId === current.groupId;
      default: return false;
    }
  }

  async tabsForScope(scope) {
    if (!["current", "others", "window", "group", "all"].includes(scope)) throw new Error(`Unknown freeze/wake scope: ${scope ?? "missing"}`);
    const tabs = await this.chrome.tabs.query({});
    const current = await this.currentTab();
    switch (scope) {
      case "current": return current ? [current] : [];
      case "others": return current ? tabs.filter((tab) => tab.windowId === current.windowId && tab.id !== current.id) : [];
      case "window": return current ? tabs.filter((tab) => tab.windowId === current.windowId) : [];
      case "group":
        if (!Number.isInteger(current?.groupId) || current.groupId === -1) throw new Error("Current tab is not in a tab group");
        return tabs.filter((tab) => tab.groupId === current.groupId);
      case "all": return tabs;
      default: return [];
    }
  }

  async whyCurrentTab() {
    const current = await this.currentTab();
    if (!current) throw new Error("No active tab available");
    const settings = await this.settings();
    const state = await this.readState();
    const forceVisible = await this.authoritativeVisibleTabs();
    const power = await this.powerState(settings);
    const reasons = getAwakeBlockReasons(current, settings, state, this.clock(), { forceVisible, power });
    const frozen = state.frozenTabs[String(current.id)];
    return {
      tabId: current.id,
      url: current.url,
      title: current.title ?? null,
      state: frozen?.status ?? "awake",
      reasons: reasons.map((code) => ({ code, label: reasonLabel(code) }))
    };
  }

  // Battery/network snapshot. The service worker may not expose navigator
  // power APIs, so extension pages report into session storage; the engine
  // only reads that snapshot here.
  async powerState(settings) {
    let stored = {};
    try { stored = await this.chrome.storage.session.get(POWER_STATE_KEY); } catch { stored = {}; }
    const power = stored[POWER_STATE_KEY] ?? {};
    return {
      charging: Boolean(power.charging),
      level: Number.isFinite(power.level) ? power.level : undefined,
      offline: typeof navigator !== "undefined" && navigator.onLine === false,
      configured: settings.pauseWhileCharging || settings.pauseWhenOffline || Number.isFinite(settings.minBatteryPercent)
    };
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
    const stored = await this.previewStore.getPreview(payload.token);
    if (!stored) return null;
    const { metadata, images } = stored;
    return {
      ...metadata,
      images: undefined,
      totalImageBytes: undefined,
      tabId: metadata.tabId,
      tiles: images.some((image) => image.kind === "tile")
        ? images.map((image, index) => ({ index: image.tileIndex ?? index, y: image.yOffset ?? 0, height: image.height ?? 0, blob: image.blob, mime: image.mime }))
        : undefined,
      viewportImage: images.find((image) => image.kind === "viewport")?.blob ?? null
    };
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
      this.chrome.storage.local.get([SETTINGS_KEY, METRICS_KEY, PREVIEW_INDEX_KEY, RULES_KEY]),
      this.chrome.storage.session.get(RUNTIME_STATE_KEY)
    ]);
    await Promise.all([
      this.chrome.storage.local.set({
        [SETTINGS_KEY]: normalizeSettings(local[SETTINGS_KEY]),
        [METRICS_KEY]: normalizeMetrics(local[METRICS_KEY]),
        [PREVIEW_INDEX_KEY]: local[PREVIEW_INDEX_KEY] ?? {},
        [RULES_KEY]: normalizeRules(local[RULES_KEY])
      }),
      this.chrome.storage.session.set({ [RUNTIME_STATE_KEY]: await normalizeState(session[RUNTIME_STATE_KEY]) })
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
      // Tab-scoped grants die with their tab; other scopes survive removals.
      for (const key of Object.keys(state.temporaryGrants ?? {})) {
        if (key.startsWith(`${KEEP_AWAKE_SCOPES.TAB}:`)) {
          const tabId = Number(key.slice(KEEP_AWAKE_SCOPES.TAB.length + 1));
          if (!valid.has(String(tabId))) delete state.temporaryGrants[key];
        }
      }
      state.requestTabs = {};
      state.requestStartedAt = {};
    });
    for (const tab of tabs) {
      const token = this.previewToken(tab.url);
      if (token) await this.restorePreview(tab, token);
    }
    await this.reconcileWakeTransactions();
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
    const power = await this.powerState(settings);
    const reasons = {};
    const candidates = [];
    for (const tab of tabs) {
      const reason = getAwakeTabBlockReason(tab, settings, state, now, { ignoreIdle, forceVisible, power });
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
      const bytes = dataUrlToBytes(imageDataUrl);
      await this.previewStore.savePreview({
        token,
        tabId: tab.id,
        originalUrl: tab.url,
        title: tab.title ?? "Sleeping tab",
        capturedAt,
        format: CAPTURE_FORMAT,
        quality: CAPTURE_QUALITY,
        images: [{ bytes, mime: "image/png", kind: "viewport" }]
      });
      await this.mutateIndex((index) => { index[token] = { tabId: tab.id, originalUrl: tab.url, updatedAt: capturedAt }; });
      await this.mutate((state) => {
        state.captures[key] = { token, url: tab.url, capturedAt, hasImage: true };
      });
      return true;
    } catch { return false; }
  }

  // Full-page capture of the ENTIRE scrollable page via the Chrome DevTools
  // Protocol. Works for background tabs without scrolling, focusing, or
  // bringing them to front. Tall pages come back as vertical WebP tiles.
  // Failure is expected and normal (DevTools open, chrome:// target) — the
  // caller falls back to viewport PNG / DOM snapshot instead.
  async captureFullPage(tab, token) {
    const result = await this.fullPageCapturer.capture(tab);
    if (!result.ok) {
      console.info(`[Tab Sleep] Full-page debugger capture unavailable for tab ${tab.id}: ${result.reason}`);
      return null;
    }
    const capturedAt = this.clock();
    const capture = result.capture;
    const images = (capture.tiles ?? [{ imageDataUrl: capture.imageDataUrl, index: 0, y: 0, height: capture.height }]).map((tile) => ({
      bytes: dataUrlToBytes(tile.imageDataUrl),
      mime: tile.imageDataUrl.startsWith("data:image/webp") ? "image/webp" : "image/png",
      kind: capture.tiles ? "tile" : "viewport",
      tileIndex: capture.tiles ? tile.index : null,
      yOffset: tile.y,
      height: tile.height
    }));
    await this.previewStore.savePreview({
      token,
      tabId: tab.id,
      originalUrl: tab.url,
      title: tab.title ?? "Sleeping tab",
      capturedAt,
      format: capture.tiles ? "webp" : "png",
      viewportWidth: capture.viewportWidth,
      viewportHeight: capture.viewportHeight,
      images
    });
    await this.mutateIndex((index) => { index[token] = { tabId: tab.id, originalUrl: tab.url, updatedAt: capturedAt }; });
    // Shape consumed by freeze()/restorePreview(): keeps the tiles/width/height
    // metadata inline so the existing record-validity checks keep working.
    // `preparedImages` rides along so freeze()'s frozenAt re-save can persist
    // the image references without losing them.
    return {
      token,
      originalUrl: tab.url,
      title: tab.title ?? "Sleeping tab",
      kind: capture.kind ?? (capture.tiles ? "tiles" : "imageDataUrl"),
      hasTiles: Boolean(capture.tiles),
      width: capture.width,
      height: capture.height,
      viewportWidth: capture.viewportWidth,
      viewportHeight: capture.viewportHeight,
      imageCount: images.length,
      preparedImages: images,
      capturedAt,
      frozenAt: null
    };
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
      await this.previewStore.savePreview({
        token,
        tabId: tab.id,
        originalUrl: tab.url,
        title: snapshot.title || tab.title || "Sleeping tab",
        html: snapshot.html,
        scrollX: snapshot.scrollX ?? 0,
        scrollY: snapshot.scrollY ?? 0,
        viewportWidth: snapshot.width ?? 0,
        viewportHeight: snapshot.height ?? 0,
        devicePixelRatio: snapshot.devicePixelRatio ?? 1,
        capturedAt
      });
      await this.mutateIndex((index) => { index[token] = { tabId: tab.id, originalUrl: tab.url, updatedAt: capturedAt }; });
      return {
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
    // A bitmap that is current for this URL is reused; otherwise the ENTIRE
    // scrollable page is captured through the debugger (works for background
    // tabs, never scrolls/focuses the page); only if that pathway fails does
    // the page serialize its exact rendered DOM.
    const existing = state.captures[key];
    let record = null;
    if (existing?.url === current.url && existing.hasImage) {
      const candidate = await this.previewStore.getMetadata(existing.token);
      if (candidate && candidate.images.length > 0 && candidate.originalUrl === current.url) {
        record = { ...candidate, imageDataUrl: `stored:${candidate.images[0].contentHash}` };
      }
    }
    const token = record?.token ?? existing?.token ?? this.tokenFactory();
    if (!record) {
      // Fallback chain: full-page debugger capture → exact DOM snapshot.
      record = await this.captureFullPage(current, token);
    }
    if (!record) {
      record = await this.captureDomSnapshot(current, token);
    }
    if (!record || !(record.hasTiles || record.imageCount > 0 || typeof record.html === "string" || record.images?.length > 0)) return false;
    record.frozenAt = this.clock();
    // frozenAt is part of the metadata row; persist the timestamp update. The
    // prepared image references captured by captureFullPage ride along —
    // omitting them would wipe the stored tiles from the metadata row.
    await this.previewStore.savePreview({
      token,
      tabId: current.id,
      originalUrl: current.url,
      title: record.title,
      html: record.html ?? undefined,
      scrollX: record.scrollX,
      scrollY: record.scrollY,
      viewportWidth: record.viewportWidth ?? record.width,
      viewportHeight: record.viewportHeight ?? record.height,
      devicePixelRatio: record.devicePixelRatio,
      format: record.format,
      quality: record.quality,
      capturedAt: record.capturedAt,
      frozenAt: record.frozenAt,
      images: record.preparedImages ?? []
    });
    await this.mutate((next) => {
      next.captures[key] = { token, url: current.url, capturedAt: record.capturedAt, hasImage: Boolean(record.hasTiles || record.imageCount > 0 || record.images?.length > 0 || typeof record.html === "string") };
      next.frozenTabs[key] = { token, originalUrl: current.url, title: current.title ?? record.title, frozenAt: record.frozenAt, status: "freezing", verifiedSleeping: false };
      delete next.inactiveSince[key];
    });
    if (!(await this.previewStore.hasPreview(token))) {
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
    await this.previewStore.deletePreviews([token]);
    await this.mutateIndex((index) => { delete index[token]; });
  }

  // Wake is split across the gesture boundary: the preview records a DURABLE
  // waking transaction FIRST (survives service-worker restarts and browser
  // restarts), then navigates ITSELF to the original URL with location.replace()
  // from the trusted gesture handler. The frozen visual keeps painting until
  // Chrome commits the new document — no clearing, overlays, or loading UI.
  async beginWake(token, senderTab) {
    return this.startWake(token, senderTab, { navigate: false });
  }

  async startWake(token, senderTab, { navigate = false } = {}) {
    const actualTab = await this.resolvePreviewTab(token, senderTab);
    if (!actualTab) throw new Error("Wake request did not come from a preview tab");
    const tabId = actualTab.id;
    const key = String(tabId);
    const state = await this.readState(), frozen = state.frozenTabs[key];
    if (!frozen || frozen.token !== token || this.previewToken(actualTab.url) !== token) throw new Error("Wake request does not match this frozen tab");
    const stored = await this.chrome.storage.local.get(WAKE_TX_KEY);
    const metadata = await this.previewStore.getMetadata(token);
    if (!isPreviewableUrl(metadata?.originalUrl)) throw new Error("Original page URL is unavailable");
    const pendingTx = stored[WAKE_TX_KEY]?.[key];
    // Exactly-once: a second trusted gesture (or a bulk wake racing the
    // preview's own navigation) resolves to the same in-flight transaction.
    if (pendingTx?.token === token) {
      if (navigate && (actualTab.pendingUrl ?? actualTab.url) !== pendingTx.originalUrl) {
        await this.chrome.tabs.update(tabId, { url: pendingTx.originalUrl });
      }
      return { url: pendingTx.originalUrl, tabId };
    }
    const tx = { token, tabId, originalUrl: metadata.originalUrl, title: metadata.title ?? null, startedAt: this.clock() };
    await this.mutate((next) => {
      const target = next.frozenTabs[key];
      if (target?.token === token) target.status = "waking";
    });
    // Durable BEFORE anything navigates away: if this worker dies mid-wake,
    // reconcileWakeTransactions() — not memory — unwinds tab and record.
    await this.mutateWakeTxs((transactions) => { transactions[key] = tx; });
    void this.monitorWakeTransaction(key, tx).catch((error) => console.error(`[Tab Sleep] wake monitor failed for tab ${tabId}`, error));
    if (navigate) await this.chrome.tabs.update(tabId, { url: tx.originalUrl });
    return { url: tx.originalUrl, tabId };
  }

  async wake(token, tab) {
    const { url, tabId } = await this.startWake(token, tab, { navigate: true });
    // Bulk/popup wakes have no gesture handler on the preview page; report the
    // real outcome here while monitorWakeTransaction owns cleanup.
    const loaded = await this.waitForUrlComplete(tabId, url);
    if (!loaded) throw new Error("Original page did not finish loading; frozen preview restored");
    return { woken: true, url };
  }

  // Called ONLY after Chrome confirmed the live document committed. This is
  // the single point where the frozen record becomes unrecoverable.
  async completeWake(key, tx) {
    this.previewReady.delete(`${tx.tabId}:${tx.token}`);
    // The transaction is the authority on what to delete: a worker restart can
    // lose session frozen state before reconciliation, so deriving the record
    // to remove from state.captures alone would leak it.
    await this.previewStore.deletePreviews([tx.token]);
    await this.mutateIndex((index) => { delete index[tx.token]; });
    await this.clearTab(tx.tabId, "wake-complete");
    await this.forgetWakeTransaction(key);
    await this.mutateMetrics((metrics) => { metrics.totalWoken++; metrics.lastWokenAt = this.clock(); });
  }

  async monitorWakeTransaction(key, tx) {
    const committed = await this.waitForUrlComplete(tx.tabId, tx.originalUrl, { graceMs: this.failedWakeGraceMs });
    if (committed) {
      await this.completeWake(key, tx);
      return;
    }
    await this.restoreFrozenAfterFailedWake(key, tx);
  }

  // DNS/network failure or commit timeout: navigate back to the frozen visual
  // with a Retry affordance. The record is intentionally preserved — it stays
  // the only recoverable copy of URL + screenshot.
  async restoreFrozenAfterFailedWake(key, tx) {
    const current = await this.chrome.tabs.get(tx.tabId).catch(() => null);
    if (!current) {
      await this.forgetWakeTransaction(key);
      return;
    }
    const retryUrl = `${this.previewUrlPrefix}?token=${encodeURIComponent(tx.token)}&retry=1`;
    if ((current.pendingUrl ?? current.url) === retryUrl && current.status === "complete") {
      await this.finishRestore(key, tx);
      return;
    }
    // Always land on retry=1 so the reloaded preview shows the Retry
    // affordance, even when the tab never left the visual.
    await this.chrome.tabs.update(tx.tabId, { url: retryUrl }).catch((error) => console.error(`[Tab Sleep] could not restore frozen preview for tab ${tx.tabId}`, error));
    const restored = await this.waitForUrlComplete(tx.tabId, retryUrl);
    if (!restored) {
      // Leave the durable transaction in place; the next worker start retries.
      console.error(`[Tab Sleep] frozen preview restore did not commit for tab ${tx.tabId}; transaction left for reconciliation`);
      return;
    }
    await this.finishRestore(key, tx);
  }

  async finishRestore(key, tx) {
    await this.mutate((state) => {
      const target = state.frozenTabs[key];
      // URL commit plus a durable visual is sufficient to sleep again; the
      // reloaded preview reports PREVIEW_READY separately. A worker restart
      // can lose the session entry entirely — rebuild it from the durable
      // record so the tab never wakes up untracked.
      if (target?.token === tx.token) {
        target.status = "sleeping";
        target.verifiedSleeping = true;
        return;
      }
      state.frozenTabs[key] = { token: tx.token, originalUrl: tx.originalUrl, title: tx.title ?? null, frozenAt: tx.startedAt, status: "sleeping", verifiedSleeping: false };
    });
    await this.forgetWakeTransaction(key);
  }

  async forgetWakeTransaction(key) {
    await this.mutateWakeTxs((transactions) => { delete transactions[key]; });
  }

  // A wake interrupted by a service-worker or browser restart resumes or
  // unwinds here. The durable transaction decides whether the preview record
  // may be deleted — never in-memory state alone.
  async reconcileWakeTransactions() {
    const stored = await this.chrome.storage.local.get(WAKE_TX_KEY);
    for (const [key, tx] of Object.entries(stored[WAKE_TX_KEY] ?? {})) {
      if (!Number.isInteger(tx?.tabId) || !isPreviewableUrl(tx.originalUrl)) {
        await this.forgetWakeTransaction(key);
        continue;
      }
      const tab = await this.chrome.tabs.get(tx.tabId).catch(() => null);
      if (!tab) {
        await this.forgetWakeTransaction(key);
        continue;
      }
      if (tab.status === "complete" && tab.url === tx.originalUrl) {
        await this.completeWake(key, tx);
        continue;
      }
      void this.restoreFrozenAfterFailedWake(key, tx).catch((error) => console.error(`[Tab Sleep] wake reconciliation failed for tab ${tx.tabId}`, error));
    }
  }

  mutateWakeTxs(mutator) {
    const op = this.wakeTxQueue.then(async () => {
      const stored = await this.chrome.storage.local.get(WAKE_TX_KEY);
      const transactions = stored[WAKE_TX_KEY] ?? {};
      await mutator(transactions);
      await this.chrome.storage.local.set({ [WAKE_TX_KEY]: transactions });
    });
    this.wakeTxQueue = op.catch(() => {});
    return op;
  }

  async waitForUrlComplete(tabId, expectedUrl, { graceMs = PREVIEW_LOAD_TIMEOUT_MS } = {}) {
    const attempts = Math.ceil(graceMs / 50);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const tab = await this.chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return null;
      if (tab.status === "complete" && tab.url === expectedUrl) return tab;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  async restorePreview(tab, token) {
    const metadata = await this.previewStore.getMetadata(token);
    const hasVisual = Boolean(metadata && (metadata.images?.length > 0 || typeof metadata.html === "string"));
    if (!metadata || !isPreviewableUrl(metadata.originalUrl) || !hasVisual) {
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
      state.frozenTabs[key] = { token, originalUrl: metadata.originalUrl, title: metadata.title, frozenAt: metadata.frozenAt ?? metadata.capturedAt, status: "freezing", verifiedSleeping: false };
      state.captures[key] = { token, url: metadata.originalUrl, capturedAt: metadata.capturedAt, hasImage: hasVisual };
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
      await this.previewStore.deletePreviews([token]);
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
    const power = await this.powerState(settings);
    return { settings, metrics: normalizeMetrics(local[METRICS_KEY]), summary: summarizeTabs(tabs, settings, state, this.clock(), this.previewUrlPrefix, forceVisible, power), currentTabProtected: current ? Boolean(state.protectedTabIds[String(current.id)]) : false, currentTabState: frozen?.status ?? "awake", currentTabVerifiedSleeping: Boolean(frozen?.verifiedSleeping), nextScanAt: (await this.chrome.alarms.get(ALARM_NAME))?.scheduledTime ?? null };
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

  async readState() {
    const stored = await this.chrome.storage.session.get(RUNTIME_STATE_KEY);
    return normalizeState({ ...stored[RUNTIME_STATE_KEY], now: this.clock() });
  }
  mutate(mutator) { const op = this.stateQueue.then(async () => { const state = await this.readState(); await mutator(state); await this.chrome.storage.session.set({ [RUNTIME_STATE_KEY]: state }); return clone(state); }); this.stateQueue = op.catch(() => {}); return op; }
  mutateMetrics(mutator) { const op = this.metricsQueue.then(async () => { const stored = await this.chrome.storage.local.get(METRICS_KEY); const metrics = normalizeMetrics(stored[METRICS_KEY]); await mutator(metrics); await this.chrome.storage.local.set({ [METRICS_KEY]: metrics }); return clone(metrics); }); this.metricsQueue = op.catch(() => {}); return op; }
  async mutateIndex(mutator) { const stored = await this.chrome.storage.local.get(PREVIEW_INDEX_KEY); const index = stored[PREVIEW_INDEX_KEY] ?? {}; await mutator(index); await this.chrome.storage.local.set({ [PREVIEW_INDEX_KEY]: index }); }
}
