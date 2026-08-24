import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../lib/constants.js";
import { getAwakeTabBlockReason, isPreviewableUrl } from "../lib/policy.js";
const now = 1_000_000;
const base = { signals: {}, requestStartedAt: {}, requestTabs: {}, protectedTabIds: {}, captures: {}, frozenTabs: {}, inactiveSince: {} };
const tab = (overrides = {}) => ({ id: 1, windowId: 1, active: true, discarded: false, pinned: false, audible: false, autoDiscardable: true, status: "complete", url: "https://example.com", ...overrides });
function ready(overrides = {}) {
  return { ...base, signals: { "1": { at: now, visible: false, busy: false, bridgeReady: true, lastActivityAt: now - 200_000 } }, captures: { "1": { url: "https://example.com", capturedAt: now - 100_000, hasImage: true, token: "t" } }, inactiveSince: { "1": now - 120_000 }, ...overrides };
}
test("supports only HTTP(S)", () => { assert.equal(isPreviewableUrl("https://x.test"), true); assert.equal(isPreviewableUrl("chrome://settings"), false); });
test("Chrome topology, not stale content visibility, protects visible tabs", () => {
  const staleVisible = ready({ signals: { "1": { at: now, visible: true, busy: false, lastActivityAt: now - 200_000, bridgeReady: true } } });
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, staleVisible, now), null);
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, staleVisible, now, { forceVisible: new Set(["1"]) }), "visible");
});
test("busy tabs and substantial in-flight work never sleep", () => {
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ signals: { "1": { at: now, visible: false, busy: true, lastActivityAt: now, bridgeReady: true } } }), now), "busy");
  // Transfer open for 10s = real work.
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ requestTabs: { "r": 1 }, requestStartedAt: { "r": now - 10_000 } }), now), "busy");
  // Any open request blocks initially; stale long-polls expire after 30s.
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ requestTabs: { "r": 1 }, requestStartedAt: { "r": now - 500 } }), now), "busy");
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ requestTabs: { "r": 1 }, requestStartedAt: { "r": now - 31_000 } }), now), null);
});
test("missing or stale signal fails safe", () => {
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ signals: {} }), now), "stale-signal");
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ signals: { "1": { at: now - 20_000, visible: false, busy: false, lastActivityAt: now - 200_000, bridgeReady: true } } }), now), "stale-signal");
});
test("stale bitmap snapshot fails safe; missing bitmap no longer blocks (DOM fallback)", () => {
  // A bitmap older than the page's last activity must never be reused.
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ signals: { "1": { at: now, visible: false, busy: false, lastActivityAt: now - 10_000, bridgeReady: true } }, captures: { "1": { url: "https://example.com", capturedAt: now - 20_000, hasImage: true } } }), now), "stale-snapshot");
  // No bitmap at all is NOT a blocker anymore — freeze() serializes the exact
  // DOM at that moment. This is what lets never-selected background tabs sleep.
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ captures: {} }), now), null);
});
test("manual freeze bypasses age only", () => {
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ inactiveSince: { "1": now } }), now, { ignoreIdle: true }), null);
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready(), now, { ignoreIdle: true, forceVisible: new Set(["1"]) }), "visible");
});
test("hidden quiet tab with current snapshot sleeps only after full threshold", () => {
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ inactiveSince: { "1": now - 119_999 } }), now), "not-due");
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready(), now), null);
});
test("allow and deny rules gate freezing before idle evaluation", () => {
  const state = ready({ rules: { allowlistEnabled: true, denylistEnabled: true, allow: [{ type: "domain", pattern: "example.com" }], deny: [] } });
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, state, now), "allow-rule");
  const denyState = ready({ rules: { allowlistEnabled: false, denylistEnabled: true, allow: [], deny: [{ type: "url-prefix", pattern: "https://example.com" }] } });
  // A denied tab is never blocked by its rule — it becomes eligible normally.
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, denyState, now), null);
});
test("temporary keep-awake grants block by scope", () => {
  const grants = { "tab:1": { scope: "tab", expiresAt: Infinity }, "window:2": { scope: "window", expiresAt: now + 1000 } };
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ temporaryGrants: grants }), now), "temp-keep-awake");
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ temporaryGrants: {} }), now), null);
  // An expired grant no longer protects.
  const expired = { "tab:1": { scope: "tab", expiresAt: now - 1 } };
  assert.equal(getAwakeTabBlockReason(tab(), DEFAULT_SETTINGS, ready({ temporaryGrants: expired }), now), null);
});
test("battery and network gates pause sleeping from the power snapshot", () => {
  const charging = { ...DEFAULT_SETTINGS, pauseWhileCharging: true, enabled: true, idleMinutes: 2 };
  assert.equal(getAwakeTabBlockReason(tab(), charging, ready(), now, { power: { charging: true, level: 0.5, offline: false } }), "charging");
  const offlineSettings = { ...DEFAULT_SETTINGS, pauseWhenOffline: true, enabled: true, idleMinutes: 2 };
  assert.equal(getAwakeTabBlockReason(tab(), offlineSettings, ready(), now, { power: { charging: false, level: 0.5, offline: true } }), "offline");
  const lowBattery = { ...DEFAULT_SETTINGS, minBatteryPercent: 20, enabled: true, idleMinutes: 2 };
  assert.equal(getAwakeTabBlockReason(tab(), lowBattery, ready(), now, { power: { charging: false, level: 0.15, offline: false } }), "battery-low");
  // Above threshold: no battery block.
  assert.equal(getAwakeTabBlockReason(tab(), lowBattery, ready(), now, { power: { charging: false, level: 0.8, offline: false } }), null);
});
