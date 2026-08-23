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
export const CAPTURE_FORMAT = "png";
export const CAPTURE_QUALITY = 100;
export const PREVIEW_LOAD_TIMEOUT_MS = 8_000;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  idleMinutes: 2,
  skipPinned: true,
  skipAudible: true,
  respectAutoDiscardable: true,
  skipLoading: true
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
    skipLoading: typeof input.skipLoading === "boolean" ? input.skipLoading : DEFAULT_SETTINGS.skipLoading
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
