import {
  DEFAULT_SETTINGS,
  RECOVERY_MANIFEST_KEY,
  SESSION_HISTORY_KEY,
  SESSION_HISTORY_LIMIT,
  SESSION_NAME_MAX_LENGTH,
  SESSION_SNAPSHOT_DEBOUNCE_MS,
  SESSION_SNAPSHOT_INTERVAL_MS,
  SESSIONS_IMPORT_MAX_BYTES,
  SESSIONS_KEY,
  SESSIONS_SCHEMA_VERSION,
  SESSIONS_SCHEMA_VERSION_KEY,
  SETTINGS_KEY as SETTINGS_FALLBACK_KEY,
  normalizeSettings
} from "./constants.js";
import { isPreviewableUrl } from "./policy.js";
import { PreviewStore } from "./preview-store.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
const message = (error) => String(error?.message ?? error);

function emptySessionsStorage() {
  return { sessions: {}, history: [], manifest: null };
}

// Session records are plain JSON metadata: window/group topology plus one URL
// per entry. Binary visuals stay with the preview storage owner; this module
// only references tokens.
export function normalizeSessionEntry(input = {}) {
  const url = typeof input.url === "string" && isPreviewableUrl(input.url) ? input.url : null;
  return {
    url,
    title: typeof input.title === "string" ? input.title : "",
    pinned: input.pinned === true,
    groupId: Number.isInteger(input.groupId) ? input.groupId : null,
    previewToken: typeof input.previewToken === "string" ? input.previewToken : null
  };
}

export function normalizeSession(input = {}) {
  const entries = Array.isArray(input.entries)
    ? input.entries.map(normalizeSessionEntry).filter((entry) => entry.url !== null)
    : [];
  const entryCount = entries.length;
  return {
    id: typeof input.id === "string" && input.id.length > 0 ? input.id : null,
    name: typeof input.name === "string" && input.name.trim().length > 0
      ? input.name.trim().slice(0, SESSION_NAME_MAX_LENGTH)
      : "Untitled session",
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : null,
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : null,
    source: input.source === "named" || input.source === "auto" || input.source === "imported" ? input.source : "named",
    windows: Array.isArray(input.windows)
      ? input.windows.map((window) => ({
          focused: window?.focused === true,
          state: typeof window.state === "string" ? window.state : "normal",
          entries: Array.isArray(window.entries)
            ? window.entries.map(normalizeSessionEntry).filter((entry) => entry.url !== null)
            : []
        }))
      : [],
    groups: Array.isArray(input.groups)
      ? input.groups.map((group) => ({
          id: Number.isInteger(group?.id) ? group.id : null,
          title: typeof group?.title === "string" ? group.title : "",
          color: typeof group?.color === "string" ? group.color : "grey",
          collapsed: group?.collapsed === true,
          windowIndex: Number.isInteger(group?.windowIndex) ? group.windowIndex : 0,
          // Group indexes must stay inside the surviving entry list; dropped
          // malformed entries would otherwise leave dangling restore targets.
          entryIndexes: Array.isArray(group.entryIndexes)
            ? group.entryIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < entryCount)
            : []
        }))
      : [],
    entries
  };
}

export function normalizeHistoryRecord(input = {}) {
  return {
    kind: input.kind === "session" || input.kind === "window" || input.kind === "group" || input.kind === "tab" ? input.kind : "tab",
    action: input.action === "sleep" || input.action === "wake" || input.action === "restore" || input.action === "snapshot" || input.action === "close"
      ? input.action
      : "snapshot",
    at: Number.isFinite(input.at) ? input.at : null,
    sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
    sessionName: typeof input.sessionName === "string" ? input.sessionName : null,
    url: typeof input.url === "string" ? input.url : null,
    title: typeof input.title === "string" ? input.title : "",
    previewToken: typeof input.previewToken === "string" ? input.previewToken : null
  };
}

export function searchHistory(history, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  const records = (Array.isArray(history) ? history : []).filter((record) => Number.isFinite(record?.at));
  if (!needle) return records;
  return records.filter((record) =>
    [record.title, record.url, record.sessionName].some((field) => typeof field === "string" && field.toLowerCase().includes(needle))
  );
}

export function buildExportPayload({ settings = null, sessions = {}, history = [], schemaVersion = SESSIONS_SCHEMA_VERSION } = {}) {
  return {
    tabSleepExport: true,
    schemaVersion,
    exportedAt: Date.now(),
    settings: settings ? normalizeSettings(settings) : null,
    sessions: Object.fromEntries(Object.entries(sessions).map(([id, session]) => [id, normalizeSession(session)])),
    history: (Array.isArray(history) ? history : []).map(normalizeHistoryRecord)
  };
}

// Import validation is strict: anything malformed fails the whole import so a
// truncated or hand-edited file can never silently half-apply.
export async function parseImportPayload(rawText) {
  if (typeof rawText !== "string") throw new Error("Import payload must be JSON text");
  const bytes = new TextEncoder().encode(rawText).length;
  if (bytes > SESSIONS_IMPORT_MAX_BYTES) throw new Error(`Import file exceeds ${SESSIONS_IMPORT_MAX_BYTES} byte limit`);
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Import file is not valid JSON: ${message(error)}`);
  }
  if (parsed?.tabSleepExport !== true) throw new Error("Import file is not a Tab Sleep export");
  if (!Number.isFinite(parsed.schemaVersion)) throw new Error("Import file is missing its schema version");
  if (parsed.schemaVersion > SESSIONS_SCHEMA_VERSION) {
    throw new Error(`Import file schema v${parsed.schemaVersion} is newer than this extension's v${SESSIONS_SCHEMA_VERSION}`);
  }
  if (parsed.sessions !== undefined && parsed.sessions !== null && (typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions))) {
    throw new Error("Import sessions must be an object");
  }
  if (parsed.history !== undefined && !Array.isArray(parsed.history)) throw new Error("Import history must be an array");
  return parsed;
}

export class SessionsManager {
  constructor(chromeApi, clock = () => Date.now(), tokenFactory = () => crypto.randomUUID(), options = {}) {
    this.chrome = chromeApi;
    this.clock = clock;
    this.tokenFactory = tokenFactory;
    // Frozen visuals live in the shared IndexedDB store; sessions only need
    // existence checks so a restored entry can reopen as a sleeping preview.
    this.previewStore = options?.previewStore ?? new PreviewStore({ indexedDb: options?.indexedDb });
    this.snapshotTimer = null;
    this.lastSnapshotAt = 0;
    this.dirtyAt = null;
  }

  // ---- storage plumbing -------------------------------------------------

  async readStorage() {
    const stored = await this.chrome.storage.local.get([SESSIONS_KEY, SESSION_HISTORY_KEY, RECOVERY_MANIFEST_KEY]);
    const normalized = emptySessionsStorage();
    if (stored[SESSIONS_KEY] && typeof stored[SESSIONS_KEY] === "object") {
      for (const [id, session] of Object.entries(stored[SESSIONS_KEY])) {
        const candidate = normalizeSession(session);
        if (candidate.entries.length > 0) {
          candidate.id = id;
          normalized.sessions[id] = candidate;
        }
      }
    }
    for (const record of Array.isArray(stored[SESSION_HISTORY_KEY]) ? stored[SESSION_HISTORY_KEY] : []) {
      const candidate = normalizeHistoryRecord(record);
      if (candidate.at !== null) normalized.history.push(candidate);
    }
    normalized.history.sort((a, b) => b.at - a.at);
    if (normalized.history.length > SESSION_HISTORY_LIMIT) normalized.history.length = SESSION_HISTORY_LIMIT;
    normalized.manifest = stored[RECOVERY_MANIFEST_KEY] && typeof stored[RECOVERY_MANIFEST_KEY] === "object"
      ? stored[RECOVERY_MANIFEST_KEY]
      : null;
    return normalized;
  }

  async writeStorage(storage) {
    await this.chrome.storage.local.set({
      [SESSIONS_KEY]: storage.sessions,
      [SESSION_HISTORY_KEY]: storage.history,
      [RECOVERY_MANIFEST_KEY]: storage.manifest
    });
  }

  mutate(mutator) {
    const op = (this.queue = (this.queue ?? Promise.resolve()).then(async () => {
      const storage = await this.readStorage();
      const result = await mutator(storage);
      await this.writeStorage(storage);
      return result ?? clone(storage);
    }));
    this.queue = op.catch(() => {});
    return op;
  }

  async appendHistory(storage, records) {
    const now = this.clock();
    for (const partial of Array.isArray(records) ? records : [records]) {
      const record = normalizeHistoryRecord(partial);
      if (record.at === null) record.at = now;
      storage.history.unshift(record);
    }
    storage.history.sort((a, b) => b.at - a.at);
    if (storage.history.length > SESSION_HISTORY_LIMIT) storage.history.length = SESSION_HISTORY_LIMIT;
  }

  // ---- capture ----------------------------------------------------------

  async snapshotCurrentWindows() {
    const tabs = await this.chrome.tabs.query({});
    const windows = await this.chrome.windows.getAll({ populate: false });
    const state = await this.chrome.storage.session.get("runtimeState");
    const frozenTabs = state.runtimeState?.frozenTabs ?? {};
    const capturedAt = this.clock();

    const session = {
      name: `Auto snapshot ${new Date(capturedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
      createdAt: capturedAt,
      updatedAt: capturedAt,
      source: "auto",
      windows: [],
      groups: [],
      entries: []
    };
    const orderedWindows = [...windows].sort((a, b) => (b.focused === true) - (a.focused === true));
    for (const window of orderedWindows) {
      const windowTabs = tabs.filter((tab) => tab.windowId === window.id).sort((a, b) => a.index - b.index);
      const windowRecord = { focused: window.focused === true, state: window.state ?? "normal", entries: [] };
      for (const tab of windowTabs) {
        if (!isPreviewableUrl(tab.pendingUrl ?? tab.url)) continue;
        const frozen = frozenTabs[String(tab.id)];
        const entry = normalizeSessionEntry({
          url: frozen?.originalUrl ?? tab.pendingUrl ?? tab.url,
          title: frozen?.title ?? tab.title ?? "",
          pinned: tab.pinned === true,
          groupId: Number.isInteger(tab.groupId) && tab.groupId !== -1 ? tab.groupId : null,
          previewToken: frozen?.token ?? null
        });
        windowRecord.entries.push(entry);
        session.groups.push(...collectGroupRecords(session.windows.length, windowRecord.entries.length - 1, entry.groupId, windowTabs, tab));
      }
      if (windowRecord.entries.length > 0) session.windows.push(windowRecord);
    }
    session.entries = session.windows.flatMap((window) => window.entries);

    const dedupedGroups = [];
    const seenGroups = new Set();
    for (const group of session.groups) {
      const key = `${group.windowIndex}:${group.id}`;
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      dedupedGroups.push(group);
    }
    session.groups = dedupedGroups;

    if (session.entries.length === 0) return null;
    return session;
  }

  // Debounced auto snapshots: tab churn marks dirty; at most one snapshot per
  // debounce interval and never more often than SESSION_SNAPSHOT_INTERVAL_MS.
  markDirty() {
    this.dirtyAt = this.clock();
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.takeAutoSnapshot().catch((error) => console.error("[Tab Sleep] session snapshot failed", error));
    }, SESSION_SNAPSHOT_DEBOUNCE_MS);
    this.snapshotTimer?.unref?.();
  }

  dispose() {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  async takeAutoSnapshot() {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.dirtyAt === null) return null;
    // Cadence check precedes consuming the dirty flag so a too-early request
    // leaves the change pending for the next eligible snapshot.
    if (this.clock() - this.lastSnapshotAt < SESSION_SNAPSHOT_INTERVAL_MS) return null;
    this.dirtyAt = null;
    const session = await this.snapshotCurrentWindows();
    if (!session) return null;
    const id = this.tokenFactory();
    const saved = await this.mutate(async (storage) => {
      storage.sessions[id] = { ...session, id };
      this.lastSnapshotAt = this.clock();
      await this.pruneAutoSessions(storage);
      await this.appendHistory(storage, { kind: "session", action: "snapshot", sessionId: id, sessionName: session.name });
      return clone(storage.sessions[id]);
    });
    return saved;
  }

  async pruneAutoSessions(storage) {
    const autos = Object.values(storage.sessions)
      .filter((session) => session.source === "auto")
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    for (const stale of autos.slice(20)) delete storage.sessions[stale.id];
  }

  // ---- named sessions ----------------------------------------------------

  async saveNamedSession(name) {
    const trimmedName = String(name ?? "").trim().slice(0, SESSION_NAME_MAX_LENGTH);
    if (!trimmedName) throw new Error("Session name is required");
    const existing = Object.values(await this.listSessions()).find(
      (session) => session.source !== "auto" && session.name.toLowerCase() === trimmedName.toLowerCase()
    );
    const session = await this.snapshotCurrentWindows();
    if (!session) throw new Error("No sleepable tabs are open right now");
    session.name = trimmedName;
    session.source = existing ? existing.source : "named";
    if (existing) {
      session.id = existing.id;
      session.createdAt = existing.createdAt;
    } else {
      session.id = this.tokenFactory();
      session.createdAt = this.clock();
    }
    session.updatedAt = this.clock();
    await this.mutate(async (storage) => {
      storage.sessions[session.id] = clone(session);
      await this.appendHistory(storage, {
        kind: "session",
        action: existing ? "snapshot" : "save",
        sessionId: session.id,
        sessionName: session.name
      });
    });
    return clone(session);
  }

  async listSessions() {
    const storage = await this.readStorage();
    return Object.values(storage.sessions).sort((a, b) => {
      if (a.source !== b.source) return a.source === "auto" ? 1 : -1;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
  }

  async deleteSession(sessionId) {
    return this.mutate(async (storage) => {
      const session = storage.sessions[sessionId];
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      delete storage.sessions[sessionId];
      await this.appendHistory(storage, { kind: "session", action: "close", sessionId, sessionName: session.name });
      return { deleted: sessionId };
    });
  }

  // ---- restore ------------------------------------------------------------

  // Still-sleeping preferred: when an entry has a live preview token whose
  // record still exists, reopen the extension preview page instead of the
  // original URL so the memory objective holds. Live URLs are the fallback.
  async createEntry(entry) {
    if (!isPreviewableUrl(entry.url)) return { created: false, reason: "unsupported-url" };
    let tokenUsable = false;
    if (entry.previewToken) {
      tokenUsable = await this.previewStore.hasPreview(entry.previewToken);
    }
    const url = tokenUsable
      ? `${this.chrome.runtime.getURL("preview/preview.html")}?token=${encodeURIComponent(entry.previewToken)}`
      : entry.url;
    const created = await this.chrome.tabs.create({ url, pinned: entry.pinned === true, active: false });
    return { created: true, tabId: created.id, stillSleeping: tokenUsable, url };
  }

  async restoreTab(sessionId, entryIndex) {
    const storage = await this.readStorage();
    const session = storage.sessions[sessionId];
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const entry = session.entries[entryIndex];
    if (!entry) throw new Error(`Unknown entry ${entryIndex} in session ${sessionId}`);
    const result = await this.createEntry(entry);
    await this.appendHistoryToDisk([{ kind: "tab", action: "restore", sessionId, sessionName: session.name, url: entry.url, title: entry.title, previewToken: entry.previewToken }]);
    return result;
  }

  async restoreGroup(sessionId, groupIndex) {
    const storage = await this.readStorage();
    const session = storage.sessions[sessionId];
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const group = session.groups[groupIndex];
    if (!group) throw new Error(`Unknown group ${groupIndex} in session ${sessionId}`);
    const results = [];
    for (const index of group.entryIndexes) {
      const entry = session.entries[index];
      if (!entry) continue;
      results.push(await this.createEntry(entry));
    }
    await this.appendHistoryToDisk([{ kind: "group", action: "restore", sessionId, sessionName: session.name, title: group.title || `Group of ${results.length}` }]);
    return { restored: results.filter((result) => result.created).length, results };
  }

  async restoreWindow(sessionId, windowIndex) {
    const storage = await this.readStorage();
    const session = storage.sessions[sessionId];
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const window = session.windows[windowIndex];
    if (!window) throw new Error(`Unknown window ${windowIndex} in session ${sessionId}`);
    return this.restoreEntries(session, window.entries, { kind: "window", windowIndex });
  }

  async restoreSession(sessionId) {
    const storage = await this.readStorage();
    const session = storage.sessions[sessionId];
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return this.restoreEntries(session, session.entries, { kind: "session" });
  }

  async restoreEntries(session, entries, historyKind) {
    const results = [];
    for (const entry of entries) {
      if (!entry) continue;
      try {
        results.push(await this.createEntry(entry));
      } catch (error) {
        results.push({ created: false, reason: message(error) });
      }
    }
    await this.appendHistoryToDisk([{
      ...historyKind,
      action: "restore",
      sessionId: session.id,
      sessionName: session.name
    }]);
    return {
      restored: results.filter((result) => result.created).length,
      stillSleeping: results.filter((result) => result.created && result.stillSleeping).length,
      results
    };
  }

  async appendHistoryToDisk(records) {
    await this.mutate(async (storage) => {
      await this.appendHistory(storage, records);
    });
  }

  // ---- import / export -----------------------------------------------------

  async exportAll() {
    const [stored, storage] = await Promise.all([
      this.chrome.storage.local.get(SETTINGS_FALLBACK_KEY),
      this.readStorage()
    ]);
    // A fresh profile may never have written settings yet; export the defaults
    // so the file is always a complete, restorable snapshot.
    return buildExportPayload({
      settings: stored[SETTINGS_FALLBACK_KEY] ?? DEFAULT_SETTINGS,
      sessions: storage.sessions,
      history: storage.history
    });
  }

  async importAll(rawText) {
    const parsed = await parseImportPayload(rawText);
    const importedSessions = {};
    for (const [id, session] of Object.entries(parsed.sessions ?? {})) {
      const normalized = normalizeSession(session);
      if (normalized.entries.length === 0) continue;
      normalized.id = id;
      normalized.createdAt = normalized.createdAt ?? this.clock();
      normalized.updatedAt = this.clock();
      // Auto snapshots never travel as user-facing sessions; anything imported
      // becomes a user-owned "imported" session.
      normalized.source = normalized.source === "auto" ? "imported" : normalized.source;
      importedSessions[id] = normalized;
    }
    const importedHistory = (parsed.history ?? []).map(normalizeHistoryRecord).filter((record) => record.at !== null);
    await this.mutate(async (storage) => {
      for (const [id, session] of Object.entries(importedSessions)) {
        const existing = storage.sessions[id];
        if (existing) {
          session.createdAt = existing.createdAt;
        } else {
          session.createdAt = session.createdAt ?? this.clock();
        }
        storage.sessions[id] = session;
      }
      if (parsed.history !== undefined) {
        const merged = [...importedHistory, ...storage.history];
        merged.sort((a, b) => b.at - a.at);
        const seen = new Set();
        storage.history = merged.filter((record) => {
          const key = `${record.at}:${record.url ?? ""}:${record.sessionId ?? ""}:${record.action}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, SESSION_HISTORY_LIMIT);
      }
      await this.appendHistory(storage, {
        kind: "session",
        action: "restore",
        sessionName: `Import (${Object.keys(importedSessions).length} sessions)`
      });
    });
    if (parsed.settings) {
      await this.chrome.storage.local.set({ [SETTINGS_FALLBACK_KEY]: normalizeSettings(parsed.settings) });
    }
    return { sessionsImported: Object.keys(importedSessions).length, historyImported: importedHistory.length, settingsApplied: Boolean(parsed.settings) };
  }

  // ---- recovery manifest ------------------------------------------------------

  // Written after every freeze/wake transition via notePreviewTokenChange().
  // Survives service-worker restarts and lets users recover original URLs even
  // when runtime state (chrome.storage.session) was lost by a crash/update.
  async rebuildRecoveryManifest(frozenTabs, previewIndex) {
    const entries = {};
    for (const [tabKey, frozen] of Object.entries(frozenTabs ?? {})) {
      if (!frozen?.token || !isPreviewableUrl(frozen.originalUrl)) continue;
      entries[frozen.token] = {
        originalUrl: frozen.originalUrl,
        title: frozen.title ?? "",
        frozenAt: frozen.frozenAt ?? null,
        lastSeenAsTabId: Number(tabKey)
      };
    }
    for (const [token, indexed] of Object.entries(previewIndex ?? {})) {
      if (!isPreviewableUrl(indexed?.originalUrl)) continue;
      if (entries[token]) continue;
      entries[token] = {
        originalUrl: indexed.originalUrl,
        title: indexed.title ?? "",
        frozenAt: indexed.updatedAt ?? null,
        lastSeenAsTabId: Number.isInteger(indexed.tabId) ? indexed.tabId : null
      };
    }
    const manifest = { updatedAt: this.clock(), entries };
    await this.chrome.storage.local.set({ [RECOVERY_MANIFEST_KEY]: manifest });
    return manifest;
  }

  async getRecoveryManifest() {
    const stored = await this.chrome.storage.local.get(RECOVERY_MANIFEST_KEY);
    const manifest = stored[RECOVERY_MANIFEST_KEY];
    if (!manifest || typeof manifest !== "object") return { updatedAt: null, entries: {} };
    return manifest;
  }

  async recoverFromManifest(token) {
    const manifest = await this.getRecoveryManifest();
    const entry = manifest.entries?.[token];
    if (!entry || !isPreviewableUrl(entry.originalUrl)) throw new Error(`No recovery entry for token ${token}`);
    const created = await this.chrome.tabs.create({ url: entry.originalUrl, active: false });
    await this.appendHistoryToDisk([{ kind: "tab", action: "restore", url: entry.originalUrl, title: entry.title, previewToken: token }]);
    return { tabId: created.id, url: entry.originalUrl };
  }

  // ---- crash reconciliation + migrations ---------------------------------------

  // Runs on every service-worker start before engine.reconcile(): re-anchors
  // preview tokens that survived a crash into fresh runtime state, prunes
  // orphaned manifest rows, and stamps the schema version.
  async reconcileAfterRestart(liveTokensProvider = null) {
    const manifest = await this.getRecoveryManifest();
    const orphaned = [];
    if (manifest.entries && typeof manifest.entries === "object") {
      for (const [token, entry] of Object.entries(manifest.entries)) {
        // The recovery manifest is the last URL-level safety net. Missing image
        // blobs must never erase a recoverable original URL; the parked page can
        // still wake explicitly without its screenshot.
        if (!isPreviewableUrl(entry.originalUrl)) orphaned.push(token);
      }
      if (orphaned.length > 0) {
        const nextManifest = { updatedAt: this.clock(), entries: {} };
        for (const [token, entry] of Object.entries(manifest.entries)) {
          if (!orphaned.includes(token)) nextManifest.entries[token] = entry;
        }
        await this.chrome.storage.local.set({ [RECOVERY_MANIFEST_KEY]: nextManifest });
      }
    }
    const stored = await this.chrome.storage.local.get(SESSIONS_SCHEMA_VERSION_KEY);
    if (stored[SESSIONS_SCHEMA_VERSION_KEY] !== SESSIONS_SCHEMA_VERSION) {
      await migrateSessionsStorage(this.chrome, stored[SESSIONS_SCHEMA_VERSION_KEY] ?? 0, SESSIONS_SCHEMA_VERSION);
      await this.chrome.storage.local.set({ [SESSIONS_SCHEMA_VERSION_KEY]: SESSIONS_SCHEMA_VERSION });
    }
    if (typeof liveTokensProvider === "function") {
      const live = await liveTokensProvider();
      await this.rebuildRecoveryManifest(live.frozenTabs ?? {}, live.previewIndex ?? {});
    }
    return { orphanedPruned: orphaned.length };
  }
}

function collectGroupRecords(windowIndex, entryIndex, groupId, windowTabs, tab) {
  if (groupId === null) return [];
  const members = windowTabs
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => Number.isInteger(candidate.groupId) && candidate.groupId === groupId);
  if (members.length < 2) return [];
  return [{
    id: groupId,
    title: typeof tab.groupTitle === "string" ? tab.groupTitle : "",
    color: typeof tab.groupColor === "string" ? tab.groupColor : "grey",
    collapsed: false,
    windowIndex,
    entryIndexes: members.map(({ index }) => index).sort((a, b) => a - b)
  }];
}

// Extension-update migrations. v0/v1 -> current: drop malformed sessions,
// clamp names, and cap unbounded histories left by pre-limit builds.
export async function migrateSessionsStorage(chromeApi, fromVersion, toVersion, storageInput = null) {
  const storage = storageInput ?? await readStorageForMigration(chromeApi);
  if (!Number.isFinite(fromVersion) || fromVersion >= toVersion) return { migrated: false, fromVersion, toVersion };
  if (fromVersion < 1) {
    for (const [id, session] of Object.entries(storage.sessions)) {
      const normalized = normalizeSession(session);
      normalized.id = id;
      if (normalized.entries.length === 0) delete storage.sessions[id];
      else storage.sessions[id] = normalized;
    }
    storage.history = (Array.isArray(storage.history) ? storage.history : [])
      .map(normalizeHistoryRecord)
      .filter((record) => record.at !== null)
      .slice(0, SESSION_HISTORY_LIMIT);
  }
  await chromeApi.storage.local.set({
    [SESSIONS_KEY]: storage.sessions,
    [SESSION_HISTORY_KEY]: storage.history,
    [RECOVERY_MANIFEST_KEY]: storage.manifest ?? null
  });
  return { migrated: true, fromVersion, toVersion };
}

async function readStorageForMigration(chromeApi) {
  const stored = await chromeApi.storage.local.get([SESSIONS_KEY, SESSION_HISTORY_KEY, RECOVERY_MANIFEST_KEY]);
  return {
    sessions: stored[SESSIONS_KEY] && typeof stored[SESSIONS_KEY] === "object" ? stored[SESSIONS_KEY] : {},
    history: Array.isArray(stored[SESSION_HISTORY_KEY]) ? stored[SESSION_HISTORY_KEY] : [],
    manifest: stored[RECOVERY_MANIFEST_KEY] ?? null
  };
}
