// IndexedDB-backed frozen-preview store. Replaces the 4.x Base64 records in
// chrome.storage.local ("preview:<token>" keys) with two object stores:
//
//   metadata — one JSON row per preview token (URL, title, scroll, viewport,
//              capture timestamp, quality, tile geometry, per-image references)
//   blobs    — binary image data keyed by SHA-256 content hash, deduplicated
//              across previews and reference-counted through metadata rows
//
// Writes are transactional: metadata and all blobs commit together or not at
// all. Budget enforcement (per-tab + profile-wide LRU) happens before commit.
// Legacy 4.x rows migrate on demand, one named token at a time; startup never
// enumerates or decodes the old chrome.storage.local image payloads.

import { PREVIEW_KEY_PREFIX } from "./constants.js";

export const PREVIEW_DB_NAME = "tab-sleep-previews";
export const PREVIEW_DB_VERSION = 1;
export const METADATA_STORE = "metadata";
export const BLOB_STORE = "blobs";
export const SCHEMA_VERSION = 2; // v1 = chrome.storage.local Base64 records

const DEFAULT_PER_TAB_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_PROFILE_BUDGET_BYTES = 512 * 1024 * 1024;

function message(error) {
  return String(error?.message ?? error);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function defaultIndexedDb() {
  if (typeof globalThis.indexedDB === "undefined") {
    throw new Error("indexedDB is unavailable in this context; inject one via PreviewStore options");
  }
  return globalThis.indexedDB;
}

function openDatabase(indexedDb) {
  const handle = indexedDb ?? defaultIndexedDb();
  return new Promise((resolve, reject) => {
    const request = handle.open(PREVIEW_DB_NAME, PREVIEW_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        const metadata = db.createObjectStore(METADATA_STORE, { keyPath: "token" });
        metadata.createIndex("capturedAt", "capturedAt");
        metadata.createIndex("tabId", "tabId");
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        const blobs = db.createObjectStore(BLOB_STORE, { keyPath: "contentHash" });
        blobs.createIndex("lastUsedAt", "lastUsedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`Failed to open ${PREVIEW_DB_NAME}: ${message(request.error)}`));
  });
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`IndexedDB request failed: ${message(request.error)}`));
  });
}

// Awaiting this promise is what keeps a write transaction alive until Chrome
// commits it; resolving early would silently weaken the all-or-nothing rule.
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error(`IndexedDB transaction failed: ${message(transaction.error)}`));
    transaction.onabort = () => reject(new Error(`IndexedDB transaction aborted: ${message(transaction.error)}`));
  });
}

/** Decode a `data:image/...;base64,...` URL into raw bytes (legacy records). */
export function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Frozen image data is malformed");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// Legacy 4.x record: either a bitmap capture with an inline Base64
// `imageDataUrl`, or a DOM snapshot with an inline `html` string.
function isLegacyRecord(record) {
  return Boolean(record && typeof record === "object" && typeof record.token === "string"
    && (typeof record.imageDataUrl === "string" || typeof record.html === "string"));
}

function base64ToBytes(dataUrl) {
  return dataUrlToBytes(dataUrl);
}

export class PreviewStore {
  constructor(options = {}) {
    this.indexedDb = options.indexedDb ?? globalThis.indexedDB;
    this.crypto = options.crypto ?? globalThis.crypto;
    this.legacyStorageArea = options.legacyStorageArea ?? null;
    this.legacyKeysPromise = null;
    this.perTabLimitBytes = options.perTabLimitBytes ?? DEFAULT_PER_TAB_LIMIT_BYTES;
    this.profileBudgetBytes = options.profileBudgetBytes ?? DEFAULT_PROFILE_BUDGET_BYTES;
    this.dbPromise = null;
    this.queue = Promise.resolve();
    this.legacyMigrationQueue = Promise.resolve();
  }

  // ---- connection --------------------------------------------------------

  db() {
    if (!this.dbPromise) this.dbPromise = openDatabase(this.indexedDb);
    return this.dbPromise;
  }

  // All mutating operations serialize through one queue so budget accounting
  // and dedup reference counting never race between concurrent captures.
  enqueue(operation) {
    const op = this.queue.then(operation);
    this.queue = op.catch(() => {});
    return op;
  }

  async close() {
    const db = this.dbPromise ? await this.dbPromise : null;
    this.dbPromise = null;
    db?.close();
  }

  // ---- write path ----------------------------------------------------------

  /**
   * Transactionally persist a preview: every image blob plus its metadata row
   * commit inside one IndexedDB transaction, or nothing does.
   */
  savePreview(preview) {
    return this.enqueue(() => this.performSavePreview(preview));
  }

  async performSavePreview(preview) {
    if (!preview || typeof preview.token !== "string" || !preview.token) {
      throw new Error("savePreview requires a non-empty token");
    }
    const images = Array.isArray(preview.images) ? preview.images : [];
    const preparedImages = [];
    const referenceImages = [];
    for (const image of images) {
      if (!image) throw new Error(`Image for token ${preview.token} is missing`);
      if (!image.bytes && typeof image.contentHash === "string") {
        // Reference-only row (no bytes): re-point this preview at the already
        // stored blob. Used when re-committing metadata without recapturing.
        if (image.mime !== "image/webp" && image.mime !== "image/png") {
          throw new Error(`Unsupported image mime for token ${preview.token}: ${String(image.mime)}`);
        }
        referenceImages.push({
          contentHash: image.contentHash,
          mime: image.mime,
          kind: image.kind === "tile" ? "tile" : "viewport",
          tileIndex: Number.isInteger(image.tileIndex) ? image.tileIndex : null,
          yOffset: Number.isFinite(image.yOffset) ? image.yOffset : null,
          height: Number.isFinite(image.height) ? image.height : null
        });
        continue;
      }
      if (!(image.bytes instanceof Uint8Array) && !(image.bytes instanceof ArrayBuffer)) {
        throw new Error(`Image for token ${preview.token} is missing binary bytes`);
      }
      const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image.bytes);
      if (bytes.byteLength === 0) throw new Error(`Image for token ${preview.token} is empty`);
      if (image.mime !== "image/webp" && image.mime !== "image/png") {
        throw new Error(`Unsupported image mime for token ${preview.token}: ${String(image.mime)}`);
      }
      preparedImages.push({
        contentHash: await sha256Hex(bytes),
        bytes,
        blob: new Blob([bytes], { type: image.mime }),
        mime: image.mime,
        kind: image.kind === "tile" ? "tile" : "viewport",
        tileIndex: Number.isInteger(image.tileIndex) ? image.tileIndex : null,
        yOffset: Number.isFinite(image.yOffset) ? image.yOffset : null,
        height: Number.isFinite(image.height) ? image.height : null
      });
    }

    const now = Date.now();
    const metadata = {
      schemaVersion: SCHEMA_VERSION,
      token: preview.token,
      tabId: Number.isInteger(preview.tabId) ? preview.tabId : null,
      originalUrl: typeof preview.originalUrl === "string" ? preview.originalUrl : null,
      title: typeof preview.title === "string" ? preview.title : "",
      faviconUrl: typeof preview.faviconUrl === "string" ? preview.faviconUrl : null,
      scrollX: Number.isFinite(preview.scrollX) ? preview.scrollX : 0,
      scrollY: Number.isFinite(preview.scrollY) ? preview.scrollY : 0,
      viewportWidth: Number.isFinite(preview.viewportWidth) ? preview.viewportWidth : 0,
      viewportHeight: Number.isFinite(preview.viewportHeight) ? preview.viewportHeight : 0,
      width: Number.isFinite(preview.width) ? preview.width : 0,
      height: Number.isFinite(preview.height) ? preview.height : 0,
      devicePixelRatio: Number.isFinite(preview.devicePixelRatio) ? preview.devicePixelRatio : 1,
      capturedAt: Number.isFinite(preview.capturedAt) ? preview.capturedAt : now,
      frozenAt: Number.isFinite(preview.frozenAt) ? preview.frozenAt : null,
      quality: Number.isFinite(preview.quality) ? preview.quality : null,
      format: typeof preview.format === "string" ? preview.format : null,
      html: typeof preview.html === "string" ? preview.html : null,
      images: [...preparedImages, ...referenceImages].map(({ contentHash, mime, kind, tileIndex, yOffset, height }) =>
        ({ contentHash, mime, kind, tileIndex, yOffset, height })),
      totalImageBytes: preparedImages.reduce((total, image) => total + image.bytes.byteLength, 0)
    };

    await this.enforceBudgets(metadata);

    const db = await this.db();
    const transaction = db.transaction([METADATA_STORE, BLOB_STORE], "readwrite");
    try {
      // Reference counting for dedup: count how many OTHER metadata rows point
      // at each hash so blobs shared with surviving previews are kept.
      for (const image of preparedImages) {
        const existing = await requestAsPromise(transaction.objectStore(BLOB_STORE).get(image.contentHash));
        if (!existing) {
          transaction.objectStore(BLOB_STORE).put({ contentHash: image.contentHash, blob: image.blob, mime: image.mime, size: image.bytes.byteLength, lastUsedAt: now });
        } else if ((existing.mime ?? image.mime) !== image.mime) {
          throw new Error(`Content-hash collision for ${image.contentHash}`);
        } else {
          transaction.objectStore(BLOB_STORE).put({ ...existing, lastUsedAt: now });
        }
      }
      // Reference-only images must already exist; touching lastUsedAt keeps
      // LRU accounting honest when a preview is re-committed.
      for (const image of referenceImages) {
        const existing = await requestAsPromise(transaction.objectStore(BLOB_STORE).get(image.contentHash));
        if (!existing) throw new Error(`Referenced blob ${image.contentHash} for token ${preview.token} is missing from the blob store`);
        transaction.objectStore(BLOB_STORE).put({ ...existing, lastUsedAt: now });
      }
      transaction.objectStore(METADATA_STORE).put(metadata);
      await transactionDone(transaction);
      return metadata;
    } catch (error) {
      try { transaction.abort(); } catch {}
      throw error;
    }
  }

  // ---- read path -----------------------------------------------------------

  async getMetadata(token) {
    if (typeof token !== "string" || !token) return null;
    let record = await this.getIndexedMetadata(token);
    if (record || !this.legacyStorageArea) return record;
    await this.migrateLegacyToken(this.legacyStorageArea, token);
    record = await this.getIndexedMetadata(token);
    return record;
  }

  async getIndexedMetadata(token) {
    const db = await this.db();
    const record = await requestAsPromise(db.transaction(METADATA_STORE).objectStore(METADATA_STORE).get(token));
    return record ?? null;
  }

  async hasPreview(token, options = {}) {
    if ((await this.getIndexedMetadata(token)) !== null) return true;
    if (options.includeLegacy === false || !this.legacyStorageArea) return false;
    return this.hasLegacyToken(token);
  }

  async hasLegacyToken(token) {
    if (typeof this.legacyStorageArea?.getKeys !== "function") return false;
    if (!this.legacyKeysPromise) {
      this.legacyKeysPromise = this.legacyStorageArea.getKeys()
        .then((keys) => new Set(keys.filter((key) => key.startsWith(PREVIEW_KEY_PREFIX))))
        .catch((error) => {
          this.legacyKeysPromise = null;
          throw error;
        });
    }
    return (await this.legacyKeysPromise).has(`${PREVIEW_KEY_PREFIX}${token}`);
  }

  /** Full record: metadata plus decoded image entries ordered by tile index. */
  async getPreview(token) {
    const metadata = await this.getMetadata(token);
    if (!metadata) return null;
    const db = await this.db();
    const store = db.transaction(BLOB_STORE).objectStore(BLOB_STORE);
    const images = [];
    for (const reference of [...(metadata.images ?? [])].sort((a, b) => (a.tileIndex ?? 0) - (b.tileIndex ?? 0))) {
      const row = await requestAsPromise(store.get(reference.contentHash));
      if (!row?.blob) return null; // missing blob => treat as broken record
      images.push({
        blob: row.blob,
        mime: row.mime ?? reference.mime,
        kind: reference.kind,
        tileIndex: reference.tileIndex,
        yOffset: reference.yOffset,
        height: reference.height
      });
    }
    return { metadata, images };
  }

  async listMetadata() {
    const db = await this.db();
    return requestAsPromise(db.transaction(METADATA_STORE).objectStore(METADATA_STORE).getAll());
  }

  // ---- deletion --------------------------------------------------------------

  /** Delete previews and any blobs whose last referencing preview disappears. */
  deletePreviews(tokens) {
    const list = (Array.isArray(tokens) ? tokens : [tokens]).filter((token) => typeof token === "string" && token);
    if (list.length === 0) return Promise.resolve();
    return this.enqueue(async () => {
      const db = await this.db();
      const transaction = db.transaction([METADATA_STORE, BLOB_STORE], "readwrite");
      try {
        const metadataStore = transaction.objectStore(METADATA_STORE);
        const removedHashCounts = new Map();
        for (const token of list) {
          const record = await requestAsPromise(metadataStore.get(token));
          if (!record) continue;
          for (const image of record.images ?? []) removedHashCounts.set(image.contentHash, (removedHashCounts.get(image.contentHash) ?? 0) + 1);
          metadataStore.delete(token);
        }
        const survivors = await requestAsPromise(metadataStore.getAll());
        const neededHashes = new Set();
        for (const survivor of survivors) for (const image of survivor.images ?? []) neededHashes.add(image.contentHash);
        const blobStore = transaction.objectStore(BLOB_STORE);
        for (const [contentHash] of removedHashCounts) {
          if (!neededHashes.has(contentHash)) blobStore.delete(contentHash);
        }
        await transactionDone(transaction);
      } catch (error) {
        try { transaction.abort(); } catch {}
        throw error;
      }
    });
  }

  // ---- budgets -----------------------------------------------------------------

  async enforceBudgets(incomingMetadata) {
    const all = (await this.listMetadata()).filter((record) => record.token !== incomingMetadata.token);
    const incomingBytes = Math.max(incomingMetadata.totalImageBytes, incomingMetadata.html?.length ?? 0);

    const sameTab = all.filter((record) => record.tabId !== null && record.tabId === incomingMetadata.tabId);
    let perTabBytes = sameTab.reduce((total, record) => total + (record.totalImageBytes ?? 0), 0) + incomingBytes;
    if (perTabBytes > this.perTabLimitBytes) {
      sameTab.sort((a, b) => (a.capturedAt ?? 0) - (b.capturedAt ?? 0));
      for (const stale of sameTab) {
        if (perTabBytes <= this.perTabLimitBytes) break;
        await this.deletePreviewsInternal([stale.token]);
        perTabBytes -= stale.totalImageBytes ?? 0;
      }
      if (perTabBytes > this.perTabLimitBytes) {
        throw new Error(`Preview for tab ${incomingMetadata.tabId} exceeds per-tab limit (${this.perTabLimitBytes} bytes) even after LRU cleanup`);
      }
    }

    const profileBytes = all.reduce((total, record) => total + (record.totalImageBytes ?? 0), 0) + incomingBytes;
    if (profileBytes > this.profileBudgetBytes) {
      const lru = all.sort((a, b) => (a.capturedAt ?? 0) - (b.capturedAt ?? 0));
      let remaining = profileBytes;
      for (const stale of lru) {
        if (remaining <= this.profileBudgetBytes) break;
        await this.deletePreviewsInternal([stale.token]);
        remaining -= stale.totalImageBytes ?? 0;
      }
      if (remaining > this.profileBudgetBytes) {
        throw new Error(`Profile preview budget of ${this.profileBudgetBytes} bytes exceeded even after LRU cleanup`);
      }
    }
  }

  // Deletion that reuses the caller's serialized queue (budget passes run
  // inside enqueue already; deletePreviews would deadlock otherwise).
  async deletePreviewsInternal(tokens) {
    const db = await this.db();
    const transaction = db.transaction([METADATA_STORE, BLOB_STORE], "readwrite");
    try {
      const metadataStore = transaction.objectStore(METADATA_STORE);
      const removedHashes = [];
      for (const token of tokens) {
        const record = await requestAsPromise(metadataStore.get(token));
        if (!record) continue;
        for (const image of record.images ?? []) removedHashes.push(image.contentHash);
        metadataStore.delete(token);
      }
      const survivors = await requestAsPromise(metadataStore.getAll());
      const neededHashes = new Set();
      for (const survivor of survivors) for (const image of survivor.images ?? []) neededHashes.add(image.contentHash);
      const blobStore = transaction.objectStore(BLOB_STORE);
      for (const contentHash of removedHashes) if (!neededHashes.has(contentHash)) blobStore.delete(contentHash);
      await transactionDone(transaction);
    } catch (error) {
      try { transaction.abort(); } catch {}
      throw error;
    }
  }

  // ---- legacy migration + reconciliation -----------------------------------------

  /**
   * Convert exactly one legacy 4.x record on demand. Legacy conversions are
   * serialized so several restored windows cannot decode multiple Base64 images
   * concurrently. Startup never reads legacy image payloads: an open visible
   * preview or explicit session restore names the token first.
   */
  async migrateLegacyToken(storageArea, token) {
    const operation = this.legacyMigrationQueue.then(() => this.performMigrateLegacyToken(storageArea, token));
    this.legacyMigrationQueue = operation.catch(() => {});
    return operation;
  }

  async performMigrateLegacyToken(storageArea, token) {
    if (!storageArea || typeof token !== "string" || !token) return false;
    if ((await this.getIndexedMetadata(token)) !== null) return true;
    const key = `${PREVIEW_KEY_PREFIX}${token}`;
    const stored = await storageArea.get(key);
    const record = stored[key];
    if (!isLegacyRecord(record)) return false;
    if (typeof record.imageDataUrl === "string") {
      await this.savePreview({
        token: record.token,
        originalUrl: record.originalUrl,
        title: record.title,
        capturedAt: record.capturedAt,
        frozenAt: record.frozenAt,
        format: record.imageDataUrl.startsWith("data:image/webp") ? "webp" : "png",
        quality: 100,
        images: [{ bytes: base64ToBytes(record.imageDataUrl), mime: record.imageDataUrl.startsWith("data:image/webp") ? "image/webp" : "image/png", kind: "viewport" }]
      });
    } else {
      await this.savePreview({
        token: record.token,
        originalUrl: record.originalUrl,
        title: record.title,
        capturedAt: record.capturedAt,
        frozenAt: record.frozenAt,
        html: record.html,
        scrollX: record.scrollX,
        scrollY: record.scrollY,
        viewportWidth: record.width,
        viewportHeight: record.height,
        devicePixelRatio: record.devicePixelRatio
      });
    }
    if ((await this.getIndexedMetadata(token)) === null) {
      throw new Error(`Verification read after migration failed for ${token}`);
    }
    await storageArea.remove(key);
    if (this.legacyKeysPromise) (await this.legacyKeysPromise).delete(key);
    return true;
  }

  /**
   * Explicit maintenance migration. It is intentionally never called during
   * extension startup; processing an old multi-gigabyte store continuously can
   * outrun Chrome's memory reclamation even when records are read one at a time.
   */
  async migrateLegacyRecords(storageArea, options = {}) {
    if (typeof storageArea?.getKeys !== "function") {
      throw new Error("chrome.storage.StorageArea.getKeys() is required for memory-bounded preview migration");
    }
    const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : Infinity;
    const legacyKeys = (await storageArea.getKeys()).filter((key) => key.startsWith(PREVIEW_KEY_PREFIX)).slice(0, limit);
    const failed = [];
    let migrated = 0;
    for (const key of legacyKeys) {
      const token = key.slice(PREVIEW_KEY_PREFIX.length);
      try {
        if (await this.migrateLegacyToken(storageArea, token)) migrated++;
        else failed.push(key);
      } catch {
        failed.push(key);
      }
    }
    return { migrated, failed };
  }

  /**
   * Restart reconciliation: repair rows whose blobs went missing, drop
   * metadata rows for tokens no longer referenced anywhere, and prune orphan
   * blobs nothing points at (e.g. after a crash between the two stores).
   */
  async reconcile(reachableTokens) {
    const reachable = reachableTokens instanceof Set ? reachableTokens : new Set(reachableTokens ?? []);
    const repaired = [], dropped = [];
    const all = await this.listMetadata();
    for (const record of all) {
      const brokenReferences = [];
      for (const image of record.images ?? []) {
        const db = await this.db();
        const row = await requestAsPromise(db.transaction(BLOB_STORE).objectStore(BLOB_STORE).get(image.contentHash));
        if (!row?.blob) brokenReferences.push(image);
      }
      if (brokenReferences.length > 0) {
        await this.deletePreviews([record.token]);
        dropped.push(record.token);
        continue;
      }
      if (!reachable.has(record.token)) {
        await this.deletePreviews([record.token]);
        dropped.push(record.token);
      } else {
        repaired.push(record.token);
      }
    }
    // Orphan blobs with zero referencing metadata rows.
    const db = await this.db();
    const blobRows = await requestAsPromise(db.transaction(BLOB_STORE).objectStore(BLOB_STORE).getAll());
    const referenced = new Set(all.flatMap((record) => (record.images ?? []).map((image) => image.contentHash)));
    const orphans = blobRows.filter((row) => !referenced.has(row.contentHash)).map((row) => row.contentHash);
    if (orphans.length > 0) {
      const transaction = db.transaction(BLOB_STORE, "readwrite");
      const blobStore = transaction.objectStore(BLOB_STORE);
      for (const contentHash of orphans) blobStore.delete(contentHash);
      await transactionDone(transaction);
    }
    return { kept: repaired.length, droppedOrphans: dropped.length, prunedBlobs: orphans.length };
  }

  /** Aggregate disk usage for settings UI / diagnostics. */
  async usage() {
    const all = await this.listMetadata();
    const db = await this.db();
    const blobRows = await requestAsPromise(db.transaction(BLOB_STORE).objectStore(BLOB_STORE).getAll());
    return {
      previews: all.length,
      uniqueBlobs: blobRows.length,
      logicalBytes: all.reduce((total, record) => total + (record.totalImageBytes ?? 0), 0),
      physicalBytes: blobRows.reduce((total, row) => total + (row.size ?? 0), 0),
      savedByDedup: Math.max(0, all.reduce((total, record) => total + (record.totalImageBytes ?? 0), 0) - blobRows.reduce((total, row) => total + (row.size ?? 0), 0))
    };
  }
}
