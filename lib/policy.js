import {
  SIGNAL_FRESH_MS,
  REASON_LABELS
} from "./constants.js";
import { evaluateRules, matchingGrantKeys, grantKey, KEEP_AWAKE_SCOPES } from "./rules.js";

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
//
// Every gate returns a stable reason code; REASON_LABELS maps codes to the
// human-readable text surfaced in the popup's "why awake?" trace.
export function getAwakeTabBlockReason(tab, settings, state, now, { ignoreIdle = false, forceVisible, power } = {}) {
  for (const reason of getAwakeBlockReasons(tab, settings, state, now, { ignoreIdle, forceVisible, power })) {
    return reason;
  }
  return null;
}

function tabContext(tab) {
  return {
    tabId: Number.isInteger(tab?.id) ? tab.id : null,
    domain: domainOf(tab?.url),
    windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null,
    groupId: Number.isInteger(tab?.groupId) && tab.groupId !== -1 ? tab.groupId : null
  };
}

export function domainOf(url) {
  if (typeof url !== "string") return null;
  try { return new URL(url).hostname.toLowerCase() || null; } catch { return null; }
}

// Full ordered walk. Returns [] when the tab is eligible to freeze.
export function getAwakeBlockReasons(tab, settings, state, now, { ignoreIdle = false, forceVisible, power } = {}) {
  const reasons = [];
  if (!Number.isInteger(tab?.id)) return ["missing-id"];
  const key = String(tab.id);
  if (state.frozenTabs[key]) return ["frozen"];
  if (!isPreviewableUrl(tab.url)) return ["unsupported-url"];
  if (tab.discarded) return ["already-discarded"];
  if (state.protectedTabIds[key]) return ["protected"];
  if (settings.skipPinned && tab.pinned) return ["pinned"];
  if (settings.skipAudible && tab.audible) return ["audible"];
  // Muted-but-playing media is only protected when explicitly configured;
  // Chrome reports mutedPlayingState on Chromium 150+.
  if (tab.muted === false && settings.keepMutedPlayingAwake && tab.mutedPlayingState === "muted-playing" && !settings.skipAudible) return ["muted"];
  if (settings.respectAutoDiscardable && tab.autoDiscardable === false) return ["not-auto-discardable"];
  if (settings.skipLoading && tab.status === "loading") return ["loading"];

  // An allow rule keeps the tab awake. A deny rule never blocks by itself —
  // it only cancels allow-rule protection, so a denied tab falls through to
  // the ordinary gates and becomes eligible like any other tab.
  if (evaluateRules(tab.url, state.rules) === "allow-rule") return ["allow-rule"];

  const context = tabContext(tab);
  const grants = state.temporaryGrants ?? {};
  if (
    matchingGrantKeys(context, grants, now).length ||
    (context.domain && grants[grantKey(KEEP_AWAKE_SCOPES.DOMAIN, context.domain)]?.expiresAt > now)
  ) return ["temp-keep-awake"];

  // Battery/network gates pause sleeping globally from the shared power snapshot.
  if (power?.offline && settings.pauseWhenOffline) return ["offline"];
  if (power?.charging && settings.pauseWhileCharging) return ["charging"];
  if (Number.isFinite(settings.minBatteryPercent) && Number.isFinite(power?.level) && power.level * 100 < settings.minBatteryPercent) return ["battery-low"];

  // The selected tab of any open (non-minimized) window is what the user sees
  // in that window — including tiled windows that are momentarily occluded or
  // render-throttled. Chrome's own window state is the source of truth here,
  // NOT paint heuristics, which go dark exactly when a window is covered.
  if (forceVisible?.has(key)) return ["visible"];

  const signal = state.signals[key];
  if (!signal || !Number.isFinite(signal.at) || now - signal.at > SIGNAL_FRESH_MS) reasons.push("stale-signal");
  if (signal && signal.bridgeReady !== true && reasons.length === 0) reasons.push("stale-signal");

  let busyBlocked = false;
  if (!reasons.includes("stale-signal")) {
    const activeRequestOpen = Object.entries(state.requestTabs ?? {}).some(([requestId, requestTabId]) => {
      if (requestTabId !== tab.id) return false;
      const startedAt = state.requestStartedAt?.[requestId];
      if (!Number.isFinite(startedAt)) return true;
      return now - startedAt <= 30_000;
    });
    if (signal.busy || activeRequestOpen) {
      reasons.push("busy");
      busyBlocked = true;
    }
  }

  // A bitmap captured before the last activity is stale: the page changed
  // since it was taken. The DOM fallback re-serializes at freeze time, so a
  // missing bitmap is fine but a stale one must not be reused as-is.
  const capture = state.captures[key];
  if (!busyBlocked) {
    if (capture?.capturedAt < signal?.lastActivityAt) reasons.push("stale-snapshot");
  }

  if (ignoreIdle) return reasons;
  if (!busyBlocked && !reasons.length) {
    if (!Number.isFinite(state.inactiveSince[key])) reasons.push("untracked");
    else if (now - state.inactiveSince[key] < settings.idleMinutes * 60_000) reasons.push("not-due");
  }
  return reasons;
}

export function reasonLabel(code) {
  return REASON_LABELS[code] ?? code;
}

export function summarizeTabs(tabs, settings, state, now, previewUrlPrefix, forceVisible = new Set(), power = undefined) {
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
    const reason = getAwakeTabBlockReason(tab, settings, state, now, { forceVisible, power });
    if (reason === null) summary.due++;
    if (reason === "stale-snapshot") summary.waitingForPreview++;
    if (getAwakeTabBlockReason(tab, settings, state, now, { ignoreIdle: true, forceVisible, power }) === null) summary.eligibleNow++;
  }
  return summary;
}
