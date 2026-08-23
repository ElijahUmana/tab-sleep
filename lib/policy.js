import {
  SIGNAL_FRESH_MS
} from "./constants.js";

export function isPreviewableUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// Gate order — the whole point of v3.1:
//   safety → visibility → real work → FULL idle elapsed.
// The frozen visual is NOT a gate anymore. It is produced at freeze time:
// a bitmap if one exists, otherwise the page serializes its own exact DOM
// (no visible window required). Requiring a screenshot up front permanently
// locked out every tab that was never selected in an on-screen window —
// that was the bug behind "open for hours and never sleeps".
export function getAwakeTabBlockReason(tab, settings, state, now, { ignoreIdle = false, forceVisible } = {}) {
  if (!Number.isInteger(tab?.id)) return "missing-id";
  const key = String(tab.id);
  if (state.frozenTabs[key]) return "frozen";
  if (!isPreviewableUrl(tab.url)) return "unsupported-url";
  if (tab.discarded) return "already-discarded";
  if (state.protectedTabIds[key]) return "protected";
  if (settings.skipPinned && tab.pinned) return "pinned";
  if (settings.skipAudible && tab.audible) return "audible";
  if (settings.respectAutoDiscardable && tab.autoDiscardable === false) return "not-auto-discardable";
  if (settings.skipLoading && tab.status === "loading") return "loading";

  // The selected tab of any open (non-minimized) window is what the user sees
  // in that window — including tiled windows that are momentarily occluded or
  // render-throttled. Chrome's own window state is the source of truth here,
  // NOT paint heuristics, which go dark exactly when a window is covered.
  if (forceVisible?.has(key)) return "visible";

  const signal = state.signals[key];
  if (!signal || !Number.isFinite(signal.at) || now - signal.at > SIGNAL_FRESH_MS) return "stale-signal";
  if (signal.bridgeReady !== true) return "stale-signal";
  // Chrome topology (forceVisible above) is authoritative. document.hidden and
  // paint state are unreliable for background/off-Space Chromium windows and
  // may remain visible=true on an unselected tab. Content visibility can never
  // override the selected-tab topology.
  const activeRequestOpen = Object.entries(state.requestTabs ?? {}).some(([requestId, requestTabId]) => {
    if (requestTabId !== tab.id) return false;
    const startedAt = state.requestStartedAt?.[requestId];
    if (!Number.isFinite(startedAt)) return true;
    return now - startedAt <= 30_000;
  });
  if (signal.busy || activeRequestOpen) return "busy";

  // A bitmap captured before the last activity is stale: the page changed
  // since it was taken. The DOM fallback re-serializes at freeze time, so a
  // missing bitmap is fine but a stale one must not be reused as-is.
  const capture = state.captures[key];
  if (capture?.capturedAt < signal.lastActivityAt) return "stale-snapshot";

  if (ignoreIdle) return null;
  if (!Number.isFinite(state.inactiveSince[key])) return "untracked";
  if (now - state.inactiveSince[key] < settings.idleMinutes * 60_000) return "not-due";
  return null;
}

export function summarizeTabs(tabs, settings, state, now, previewUrlPrefix) {
  const summary = { total: tabs.length, awake: 0, frozen: 0, sleeping: 0, previewing: 0, protected: 0, due: 0, eligibleNow: 0, waitingForPreview: 0 };
  for (const tab of tabs) {
    const key = String(tab.id);
    if (state.frozenTabs[key] || String(tab.url ?? "").startsWith(previewUrlPrefix)) {
      summary.frozen++;
      summary.sleeping++;
      if (tab.active) summary.previewing++;
      continue;
    }
    summary.awake++;
    if (state.protectedTabIds[key]) summary.protected++;
    const reason = getAwakeTabBlockReason(tab, settings, state, now);
    if (reason === null) summary.due++;
    if (reason === "stale-snapshot") summary.waitingForPreview++;
    if (getAwakeTabBlockReason(tab, settings, state, now, { ignoreIdle: true }) === null) summary.eligibleNow++;
  }
  return summary;
}
