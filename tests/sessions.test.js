import assert from "node:assert/strict";
import test from "node:test";
import { RECOVERY_MANIFEST_KEY, RUNTIME_STATE_KEY, SESSION_HISTORY_KEY, SESSION_HISTORY_LIMIT, SESSIONS_KEY, SESSIONS_SCHEMA_VERSION } from "../lib/constants.js";
import {
  SessionsManager,
  buildExportPayload,
  normalizeSession,
  parseImportPayload,
  searchHistory
} from "../lib/sessions.js";
import { createFakeChrome, makeTab } from "./fake-chrome.js";
import { PreviewStore } from "../lib/preview-store.js";
import { FakeIndexedDbFactory } from "./fake-idb.js";

function clock(start = 1_000_000) { let now = start; return { now: () => now, advance: (ms) => { now += ms; } }; }
function sessionsManager(chrome, c) {
  let i = 0;
  const previewStore = new PreviewStore({ indexedDb: new FakeIndexedDbFactory() });
  const manager = new SessionsManager(chrome, c.now, () => `sess-${++i}`, { previewStore });
  manager.previewStore = previewStore;
  return manager;
}
// Seed a frozen record through the store the way the engine writes them.
async function seedPreviewToken(manager, token) {
  await manager.previewStore.savePreview({
    token,
    originalUrl: "https://example.com/tab-1",
    title: "Tab 1",
    capturedAt: 1_000_000,
    images: [{ bytes: new Uint8Array([65, 66, 67, 68]), mime: "image/png", kind: "viewport" }]
  });
}

test("normalizeSession drops malformed entries and clamps names", () => {
  const session = normalizeSession({
    name: "  ".repeat(60) + "Deep work",
    entries: [{ url: "https://a.example", title: "A" }, { url: "chrome://settings" }, {}],
    windows: [{ focused: true, state: "minimized", entries: [{ url: "https://b.example" }] }],
    groups: [{ id: 7, title: "Docs", color: "blue", windowIndex: 0, entryIndexes: [0, "x", 2] }]
  });
  assert.equal(session.entries.length, 1);
  assert.equal(session.windows[0].entries.length, 1);
  assert.deepEqual(session.groups[0].entryIndexes, [0]);
  assert.equal(session.name.length <= 80, true);
  assert.equal(session.source, "named");
});

test("searchHistory matches title/url/session name case-insensitively", () => {
  const history = [
    { kind: "tab", action: "restore", at: 30, title: "GitHub Pulls", url: "https://github.com/x" },
    { kind: "session", action: "snapshot", at: 20, sessionName: "Research burst" },
    { kind: "window", action: "restore", at: 10, sessionName: null, title: "Docs home", url: "https://docs.example" }
  ];
  assert.equal(searchHistory(history, "").length, 3);
  assert.deepEqual(searchHistory(history, "GITHUB").map((r) => r.at), [30]);
  assert.deepEqual(searchHistory(history, "research").map((r) => r.at), [20]);
  assert.equal(searchHistory(history, "nothing-matches").length, 0);
});

test("buildExportPayload emits a versioned envelope with normalized content", async () => {
  const payload = buildExportPayload({
    settings: { enabled: false, idleMinutes: 7 },
    sessions: { s1: { name: "Work", entries: [{ url: "https://a.example" }] } },
    history: [{ kind: "tab", action: "restore", at: 5 }]
  });
  assert.equal(payload.tabSleepExport, true);
  assert.equal(payload.schemaVersion, SESSIONS_SCHEMA_VERSION);
  assert.deepEqual(payload.settings, { enabled: false, idleMinutes: 7, skipPinned: true, skipAudible: true, respectAutoDiscardable: true, skipLoading: true, keepMutedPlayingAwake: false, pauseWhileCharging: false, pauseWhenOffline: false, minBatteryPercent: null });
  assert.equal(payload.sessions.s1.entries[0].url, "https://a.example");
});

test("parseImportPayload rejects non-Tab-Sleep and newer-schema files", async () => {
  await assert.rejects(() => parseImportPayload("not json"), /not valid JSON/);
  await assert.rejects(() => parseImportPayload("{}"), /not a Tab Sleep export/);
  await assert.rejects(() => parseImportPayload(JSON.stringify({ tabSleepExport: true, schemaVersion: 999 })), /newer than/);
  await assert.rejects(() => parseImportPayload(JSON.stringify({ tabSleepExport: true, schemaVersion: 1, history: "oops" })), /array/);
  const ok = await parseImportPayload(JSON.stringify({ tabSleepExport: true, schemaVersion: 1, sessions: {}, history: [] }));
  assert.equal(ok.schemaVersion, 1);
});

test("auto snapshots capture windows, dedupe groups, prune old autos, and record history", async () => {
  const c = clock();
  const chrome = createFakeChrome([
    makeTab(1, { active: true, windowId: 1, groupId: 5 }),
    makeTab(2, { windowId: 1, groupId: 5 }),
    makeTab(3, { windowId: 2 })
  ], {});
  chrome.storage.session.data[RUNTIME_STATE_KEY] = { frozenTabs: { "3": { token: "tok-3", originalUrl: "https://example.com/tab-3", title: "Tab 3", status: "sleeping" } } };
  const manager = sessionsManager(chrome, c);

  manager.markDirty();
  c.advance(61_000);
  const saved = await manager.takeAutoSnapshot();
  assert.ok(saved, "debounced snapshot should be taken");
  assert.equal(saved.source, "auto");
  assert.equal(saved.entries.length, 3);
  assert.equal(saved.groups.length, 1, "one group across two tabs");
  assert.ok(saved.groups[0].entryIndexes.includes(0) && saved.groups[0].entryIndexes.includes(1));
  assert.equal(saved.entries[2].previewToken, "tok-3");
  assert.equal(saved.entries[2].url, "https://example.com/tab-3");

  const stored = chrome.storage.local.data;
  assert.equal(Object.keys(stored[SESSIONS_KEY]).length, 1);
  assert.equal(stored[SESSION_HISTORY_KEY][0].action, "snapshot");
});

test("auto snapshot cadence never exceeds the interval; empty desktop records nothing", async () => {
  const c = clock();
  const chrome = createFakeChrome([makeTab(1)], {});
  const manager = sessionsManager(chrome, c);

  // Empty desktop -> no session recorded.
  const emptyChrome = createFakeChrome([], {});
  const emptyManager = sessionsManager(emptyChrome, c);
  emptyManager.markDirty();
  c.advance(61_000);
  assert.equal(await emptyManager.takeAutoSnapshot(), null);
  assert.equal(Object.keys(emptyChrome.storage.local.data[SESSIONS_KEY] ?? {}).length, 0);

  manager.markDirty();
  c.advance(61_000);
  const first = await manager.takeAutoSnapshot();
  assert.ok(first);

  // Second dirty mark inside the 10-minute cadence window is suppressed.
  manager.markDirty();
  c.advance(61_000);
  assert.equal(await manager.takeAutoSnapshot(), null);
  c.advance(9 * 60_000 + 1_000);
  const second = await manager.takeAutoSnapshot();
  assert.ok(second, "after the interval a new auto snapshot lands");
  assert.notEqual(second.id ?? second.name, first.id ?? first.name);
});

test("named sessions save, list before autos, restore still-sleeping via preview token, and update in place", async () => {
  const c = clock();
  const chrome = createFakeChrome([makeTab(1, { active: true }), makeTab(2)]);
  chrome.storage.session.data[RUNTIME_STATE_KEY] = { frozenTabs: { "2": { token: "sleepy-token", originalUrl: "https://example.com/tab-2", title: "Tab 2", status: "sleeping" } } };
  const manager = sessionsManager(chrome, c);

  const saved = await manager.saveNamedSession("Work set");
  assert.match(saved.id, /^sess-/);
  assert.equal(saved.source, "named");
  assert.equal(saved.entries.length, 2);

  await seedPreviewToken(manager, "sleepy-token");

  const listed = await manager.listSessions();
  assert.equal(listed[0].name, "Work set");

  const restored = await manager.restoreSession(saved.id);
  assert.equal(restored.restored, 2);
  assert.equal(restored.stillSleeping, 1, "token-backed entry reopens as frozen preview");
  const createdCalls = chrome.calls.created;
  const sleepingEntry = createdCalls.find((call) => call.url?.includes("token=sleepy-token"));
  assert.ok(sleepingEntry, "still-sleeping entry restores to the preview page");
  const liveEntry = createdCalls.find((call) => call.url === "https://example.com/tab-1");
  assert.ok(liveEntry, "live entry restores to its URL");

  const updated = await manager.saveNamedSession("work SET");
  assert.equal(updated.id, saved.id, "same name (case-insensitive) updates in place");
  assert.equal(Object.keys(chrome.storage.local.data[SESSIONS_KEY]).length, 1);
});

test("restore falls back to live URLs when the preview record is gone", async () => {
  const c = clock();
  const chrome = createFakeChrome([makeTab(1)]);
  chrome.storage.session.data[RUNTIME_STATE_KEY] = { frozenTabs: { "1": { token: "dead-token", originalUrl: "https://example.com/tab-1", title: "Tab 1" } } };
  const manager = sessionsManager(chrome, c);
  const session = await manager.saveNamedSession("Solo");
  const restored = await manager.restoreSession(session.id);
  assert.equal(restored.restored, 1);
  assert.equal(restored.stillSleeping, 0);
  assert.equal(chrome.calls.created[0].url, "https://example.com/tab-1");
});

test("restore one tab and one group individually", async () => {
  const c = clock();
  const chrome = createFakeChrome([makeTab(1, { groupId: 4 }), makeTab(2, { groupId: 4 }), makeTab(3)]);
  const manager = sessionsManager(chrome, c);
  const session = await manager.saveNamedSession("Grouped");
  assert.equal(session.groups.length, 1);

  const one = await manager.restoreTab(session.id, 2);
  assert.equal(one.created, true);
  assert.equal(chrome.calls.created.at(-1).url, "https://example.com/tab-3");

  const group = await manager.restoreGroup(session.id, 0);
  assert.equal(group.restored, 2);
  await assert.rejects(() => manager.restoreGroup(session.id, 5), /Unknown group/);
  await assert.rejects(() => manager.restoreTab(session.id, 99), /Unknown entry/);
});

test("delete removes only the targeted session", async () => {
  const c = clock();
  const chrome = createFakeChrome([makeTab(1), makeTab(2, { active: true })]);
  const manager = sessionsManager(chrome, c);
  const first = await manager.saveNamedSession("One");
  const second = await manager.saveNamedSession("Two");
  await manager.deleteSession(first.id);
  const remaining = await manager.listSessions().then((list) => list.map((session) => session.name));
  assert.deepEqual(remaining.sort(), ["Two"]);
  await assert.rejects(() => manager.deleteSession(first.id), /Unknown session/);
  assert.ok(second);
});

test("export/import round-trips sessions, merges history, applies settings", async () => {
  const c = clock();
  const source = createFakeChrome([makeTab(1), makeTab(2, { active: true })]);
  const sourceManager = sessionsManager(source, c);
  await sourceManager.saveNamedSession("Round trip");
  const exported = await sourceManager.exportAll();

  const target = createFakeChrome([], {});
  const targetManager = sessionsManager(target, c);
  const result = await targetManager.importAll(JSON.stringify(exported));
  assert.equal(result.sessionsImported, 1);
  assert.equal(result.settingsApplied, true);

  const importedList = await targetManager.listSessions();
  assert.equal(importedList.length, 1);
  assert.equal(importedList[0].name, "Round trip");
  assert.equal(importedList[0].source, "named");
  assert.deepEqual(importedList[0].entries.map((entry) => entry.url).sort(), ["https://example.com/tab-1", "https://example.com/tab-2"]);

  const settings = await target.storage.local.get("settings");
  assert.equal(settings.settings.enabled, true);

  // Re-import merges without duplicating history.
  await targetManager.importAll(JSON.stringify(exported));
  const storageAfter = target.storage.local.data;
  const saveRows = storageAfter[SESSION_HISTORY_KEY].filter((record) => record.sessionName === "Round trip" && record.action === "snapshot");
  assert.equal(saveRows.length, 1);
});

test("import rejects malformed payloads without touching storage", async () => {
  const c = clock();
  const chrome = createFakeChrome([makeTab(1, { active: true })]);
  const manager = sessionsManager(chrome, c);
  await manager.saveNamedSession("Keep me");
  const before = cloneStorage(chrome);
  await assert.rejects(() => manager.importAll("{broken"));
  await assert.rejects(() => manager.importAll(JSON.stringify({ hello: true })));
  assert.deepEqual(cloneStorage(chrome), before);
});

function cloneStorage(chrome) {
  return JSON.parse(JSON.stringify(chrome.storage.local.data));
}

test("history is capped at the configured limit with newest-first order", async () => {
  const c = clock();
  const chrome = createFakeChrome([makeTab(1, { active: true })], {});
  const manager = sessionsManager(chrome, c);
  await manager.saveNamedSession("Capped");
  const flood = Array.from({ length: SESSION_HISTORY_LIMIT + 50 }, (_, index) => ({ kind: "tab", action: "restore", at: index + 2, url: `https://example.com/${index}` }));
  await manager.importAll(JSON.stringify({ tabSleepExport: true, schemaVersion: 1, sessions: {}, history: flood }));
  const history = chrome.storage.local.data[SESSION_HISTORY_KEY];
  assert.equal(history.length, SESSION_HISTORY_LIMIT);
  for (let i = 1; i < history.length; i++) assert.ok(history[i - 1].at >= history[i].at);
});

test("recovery manifest rebuild tracks frozen tokens and survives restart reconciliation", async () => {
  const c = clock();
  const chrome = createFakeChrome([makeTab(1)]);
  const manager = sessionsManager(chrome, c);

  await manager.rebuildRecoveryManifest(
    { "1": { token: "live-token", originalUrl: "https://example.com/tab-1", title: "Tab 1", frozenAt: 123 } },
    { "orphan-indexed": { originalUrl: "https://indexed.example", updatedAt: 55, tabId: 9 } }
  );
  let manifest = await manager.getRecoveryManifest();
  assert.equal(manifest.entries["live-token"].originalUrl, "https://example.com/tab-1");
  assert.equal(manifest.entries["orphan-indexed"].lastSeenAsTabId, 9);

  // Restart without image blobs: original URLs remain recoverable. Only an
  // invalid URL is pruned; missing screenshots must never destroy recovery.
  manifest.entries["invalid-token"] = { originalUrl: "javascript:alert(1)" };
  await chrome.storage.local.set({ [RECOVERY_MANIFEST_KEY]: manifest });
  await seedPreviewToken(manager, "live-token");
  const result = await manager.reconcileAfterRestart(async () => ({
    frozenTabs: { "1": { token: "live-token", originalUrl: "https://example.com/tab-1", title: "Tab 1" } },
    previewIndex: { "orphan-indexed": { originalUrl: "https://indexed.example", updatedAt: 55, tabId: 9 } }
  }));
  assert.equal(result.orphanedPruned, 1);
  manifest = await manager.getRecoveryManifest();
  assert.ok(manifest.entries["live-token"]);
  assert.ok(manifest.entries["orphan-indexed"], "URL recovery survives even when its preview blob is missing");
  assert.equal(manifest.entries["invalid-token"], undefined);

  const recovered = await manager.recoverFromManifest("live-token");
  assert.equal(recovered.url, "https://example.com/tab-1");
  await assert.rejects(() => manager.recoverFromManifest("missing-token"), /No recovery entry/);
});

test("schema migration normalizes legacy sessions and caps legacy histories", async () => {
  const { migrateSessionsStorage } = await import("../lib/sessions.js");
  const chrome = createFakeChrome([], {});
  await chrome.storage.local.set({
    [SESSIONS_KEY]: {
      good: { name: "Legacy", createdAt: 1, updatedAt: 1, entries: [{ url: "https://ok.example" }] },
      broken: { name: "", entries: [{ url: "javascript:alert(1)" }] }
    },
    [SESSION_HISTORY_KEY]: [{ at: 1 }, { nope: true }, ...Array.from({ length: SESSION_HISTORY_LIMIT }, (_, i) => ({ at: i + 2 }))]
  });
  const outcome = await migrateSessionsStorage(chrome, 0, SESSIONS_SCHEMA_VERSION);
  assert.equal(outcome.migrated, true);
  const stored = chrome.storage.local.data;
  assert.equal(stored[SESSIONS_KEY].good.entries[0].url, "https://ok.example");
  assert.equal(stored[SESSIONS_KEY].broken, undefined);
  assert.equal(stored[SESSION_HISTORY_KEY].length, SESSION_HISTORY_LIMIT);
});
