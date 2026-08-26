export const ALARM_NAME = "tab-sleep-scan-v2";
export const SCAN_PERIOD_MINUTES = 0.5;
export const SCAN_TICK_MS = 5_000;
export const SIGNAL_FRESH_MS = 15_000;
export const SETTINGS_KEY = "settings";
export const RUNTIME_STATE_KEY = "runtimeState";
export const METRICS_KEY = "metrics";
export const PREVIEW_INDEX_KEY = "previewIndex";
export const PREVIEW_KEY_PREFIX = "preview:";
export const MIN_IDLE_MINUTES = 0.5;
export const MAX_IDLE_MINUTES = 1440;
export const PREVIEW_LOAD_TIMEOUT_MS = 8_000;
// Durable wake transactions (chrome.storage.local): recorded BEFORE the preview
// navigates itself to the original URL, consulted after any service-worker
// restart so an interrupted wake can never orphan or destroy a recoverable record.
export const WAKE_TX_KEY = "wakeTransactions";
// Full-page capture via chrome.debugger (CDP Page.captureScreenshot). Very
// tall pages are captured as vertical tiles to stay within Chrome's bitmap
// limits; each tile is a high-quality WebP data URL plus its y-offset.
export const FULL_PAGE_TILE_HEIGHT = 4_096;
export const FULL_PAGE_MAX_TILES = 64;
export const FULL_PAGE_WEBP_QUALITY = 92;
export const FULL_PAGE_ATTACH_TIMEOUT_MS = 3_000;
export const NESTED_SCROLL_MAX_REGIONS = 4;
export const NESTED_SCROLL_MAX_TILES = 256;
export const NESTED_SCROLL_SETTLE_MS = 80;
export const POWER_STATE_KEY = "powerState";
export const TEMPORARY_GRANTS_KEY = "temporaryGrants";
export const RULES_KEY = "rules";
export const BATTERY_REFRESH_ALARM_NAME = "tab-sleep-battery-refresh-v1";

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  idleMinutes: 2,
  skipPinned: true,
  skipAudible: true,
  respectAutoDiscardable: true,
  skipLoading: true,
  keepMutedPlayingAwake: false,
  pauseWhileCharging: false,
  pauseWhenOffline: false,
  minBatteryPercent: null
});

export const DEFAULT_METRICS = Object.freeze({
  totalFrozen: 0,
  totalWoken: 0,
  totalFailures: 0,
  lastScanAt: null,
  lastFrozenAt: null,
  lastFrozenCount: 0,
  lastWokenAt: null,
  lastCaptureAt: null,
  lastCaptureFailureAt: null,
  lastCaptureError: null,
  lastScanReasons: {},
  lastFailureAt: null,
  lastError: null
});

export function normalizeSettings(input = {}) {
  const numericIdleMinutes = Number(input.idleMinutes);
  const idleMinutes = Number.isFinite(numericIdleMinutes)
    ? Math.round(Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, numericIdleMinutes)) * 2) / 2
    : DEFAULT_SETTINGS.idleMinutes;

  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_SETTINGS.enabled,
    idleMinutes,
    skipPinned: typeof input.skipPinned === "boolean" ? input.skipPinned : DEFAULT_SETTINGS.skipPinned,
    skipAudible: typeof input.skipAudible === "boolean" ? input.skipAudible : DEFAULT_SETTINGS.skipAudible,
    respectAutoDiscardable: typeof input.respectAutoDiscardable === "boolean"
      ? input.respectAutoDiscardable
      : DEFAULT_SETTINGS.respectAutoDiscardable,
    skipLoading: typeof input.skipLoading === "boolean" ? input.skipLoading : DEFAULT_SETTINGS.skipLoading,
    keepMutedPlayingAwake: typeof input.keepMutedPlayingAwake === "boolean"
      ? input.keepMutedPlayingAwake
      : DEFAULT_SETTINGS.keepMutedPlayingAwake,
    pauseWhileCharging: typeof input.pauseWhileCharging === "boolean"
      ? input.pauseWhileCharging
      : DEFAULT_SETTINGS.pauseWhileCharging,
    pauseWhenOffline: typeof input.pauseWhenOffline === "boolean"
      ? input.pauseWhenOffline
      : DEFAULT_SETTINGS.pauseWhenOffline,
    minBatteryPercent: Number.isFinite(Number(input.minBatteryPercent))
      ? Math.min(100, Math.max(0, Math.round(Number(input.minBatteryPercent))))
      : DEFAULT_SETTINGS.minBatteryPercent
  };
}

export function normalizeMetrics(input = {}) {
  return {
    ...DEFAULT_METRICS,
    ...input,
    totalFrozen: Number.isFinite(input.totalFrozen) ? input.totalFrozen : 0,
    totalWoken: Number.isFinite(input.totalWoken) ? input.totalWoken : 0,
    totalFailures: Number.isFinite(input.totalFailures) ? input.totalFailures : 0
  };
}

export function previewStorageKey(token) {
  return `${PREVIEW_KEY_PREFIX}${token}`;
}

export const REASON_LABELS = Object.freeze({
  "missing-id": "Tab has no id",
  frozen: "Already frozen",
  "unsupported-url": "URL is not supported",
  "already-discarded": "Already discarded by Chrome",
  protected: "Manually kept awake",
  pinned: "Pinned tabs stay awake",
  audible: "Playing audio",
  muted: "Muted media is playing",
  "not-auto-discardable": "Marked non-discardable",
  loading: "Still loading",
  visible: "Selected in an open window",
  "stale-signal": "No fresh activity signal",
  busy: "Page is actively working",
  "stale-snapshot": "Waiting for a current preview",
  "allow-rule": "Allowed by rule",
  "deny-rule": "Denied by rule",
  "temp-keep-awake": "Temporary keep awake",
  offline: "Device is offline",
  charging: "Sleeping paused while charging",
  "battery-low": "Battery below threshold",
  untracked: "Not tracked yet",
  "not-due": "Idle time not reached"
});
