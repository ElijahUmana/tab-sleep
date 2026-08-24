import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, MAX_IDLE_MINUTES, MIN_IDLE_MINUTES, normalizeSettings } from "../lib/constants.js";

test("normalizeSettings defaults malformed input", () => {
  assert.deepEqual(normalizeSettings({}), { ...DEFAULT_SETTINGS });
  assert.equal(normalizeSettings({ idleMinutes: "wat" }).idleMinutes, DEFAULT_SETTINGS.idleMinutes);
});

test("normalizeSettings clamps and rounds to half-minute increments", () => {
  assert.equal(normalizeSettings({ idleMinutes: 0 }).idleMinutes, MIN_IDLE_MINUTES);
  assert.equal(normalizeSettings({ idleMinutes: 99999 }).idleMinutes, MAX_IDLE_MINUTES);
  assert.equal(normalizeSettings({ idleMinutes: 0.74 }).idleMinutes, 0.5);
  assert.equal(normalizeSettings({ idleMinutes: 0.76 }).idleMinutes, 1);
});

test("normalizeSettings preserves explicit boolean choices", () => {
  const settings = normalizeSettings({ enabled: false, idleMinutes: 10, skipPinned: false, skipAudible: false, respectAutoDiscardable: false, skipLoading: false });
  assert.deepEqual(settings, {
    enabled: false,
    idleMinutes: 10,
    skipPinned: false,
    skipAudible: false,
    respectAutoDiscardable: false,
    skipLoading: false,
    ...Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([key]) => !["enabled", "idleMinutes", "skipPinned", "skipAudible", "respectAutoDiscardable", "skipLoading"].includes(key)))
  });
});

test("normalizeSettings clamps battery threshold and preserves power toggles", () => {
  assert.equal(normalizeSettings({ minBatteryPercent: -5 }).minBatteryPercent, 0);
  assert.equal(normalizeSettings({ minBatteryPercent: "80" }).minBatteryPercent, 80);
  assert.equal(normalizeSettings({ minBatteryPercent: 150 }).minBatteryPercent, 100);
  const settings = normalizeSettings({ keepMutedPlayingAwake: true, pauseWhileCharging: true, minBatteryPercent: 20 });
  assert.equal(settings.keepMutedPlayingAwake, true);
  assert.equal(settings.pauseWhileCharging, true);
  assert.equal(settings.minBatteryPercent, 20);
});
