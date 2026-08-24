import assert from "node:assert/strict";
import test from "node:test";
import { PREVIEW_KEY_PREFIX } from "../lib/constants.js";
import { BLOB_STORE, METADATA_STORE, PreviewStore, SCHEMA_VERSION, dataUrlToBytes } from "../lib/preview-store.js";
import { FakeIndexedDbFactory } from "./fake-idb.js";

function makeStore(options = {}) {
  const indexedDb = new FakeIndexedDbFactory();
  return new PreviewStore({ indexedDb, ...options });
}

const PNG_A = "data:image/png;base64,AAAA";
const PNG_B = "data:image/png;base64,BBBB";

function viewportPreview(overrides = {}) {
  return {
    token: "token-a",
    tabId: 1,
    originalUrl: "https://example.com/a",
    title: "Page A",
    capturedAt: 1_000,
    format: "png",
    quality: 100,
    images: [{ bytes: dataUrlToBytes(PNG_A), mime: "image/png", kind: "viewport" }],
    ...overrides
  };
}

test("savePreview commits metadata and blob transactionally and reads back", async () => {
  const store = makeStore();
  const saved = await store.savePreview(viewportPreview());
  assert.equal(saved.schemaVersion, SCHEMA_VERSION);
  assert.equal(saved.originalUrl, "https://example.com/a");
  assert.equal(saved.width, 0);
  assert.equal(saved.height, 0);
  assert.equal(saved.images.length, 1);

  const full = await store.getPreview("token-a");
  assert.equal(full.metadata.title, "Page A");
  assert.equal(full.images.length, 1);
  assert.equal(full.images[0].kind, "viewport");
  const bytes = new Uint8Array(await full.images[0].blob.arrayBuffer());
  assert.deepEqual(bytes, dataUrlToBytes(PNG_A));
});

test("identical captures dedupe into one content-addressed blob", async () => {
  const store = makeStore();
  await store.savePreview(viewportPreview({ token: "one" }));
  await store.savePreview(viewportPreview({ token: "two", capturedAt: 2_000 }));
  const usage = await store.usage();
  assert.equal(usage.previews, 2);
  assert.equal(usage.uniqueBlobs, 1, "same bytes must share one blob row");
  assert.ok(usage.savedByDedup > 0);
});

test("deleting the last referencing preview removes its deduplicated blob; shared blobs survive", async () => {
  const store = makeStore();
  await store.savePreview(viewportPreview({ token: "one" }));
  await store.savePreview(viewportPreview({ token: "two", images: [{ bytes: dataUrlToBytes(PNG_A), mime: "image/png", kind: "viewport" }, { bytes: dataUrlToBytes(PNG_B), mime: "image/png", kind: "tile", tileIndex: 0, yOffset: 0, height: 800 }] }));
  await store.deletePreviews(["two"]);
  assert.equal(await store.hasPreview("two"), false);
  // PNG_A still referenced by "one"; PNG_B is now orphaned.
  const full = await store.getPreview("one");
  assert.equal(full.images[0].mime, "image/png");
  const db = store.indexedDb.databases.get("tab-sleep-previews");
  assert.equal(db.data.get(BLOB_STORE).size, 1);
  await store.deletePreviews(["missing-token"]);
  assert.equal((await store.listMetadata()).length, 1);
});

test("per-tab LRU budget evicts oldest captures for that tab before rejecting", async () => {
  // Each fixture PNG decodes to 3 bytes: old(3)+new(3)=6 > 5 → "old" must go.
  const store = makeStore({ perTabLimitBytes: 5 });
  await store.savePreview(viewportPreview({ token: "old", capturedAt: 500 }));
  await store.savePreview(viewportPreview({ token: "new", capturedAt: 900 }));
  const tokens = (await store.listMetadata()).map((record) => record.token).sort();
  assert.deepEqual(tokens, ["new"], "oldest same-tab capture evicted to fit budget");
});

test("profile-wide budget evicts globally-oldest previews across tabs", async () => {
  // 9 bytes total > 4-byte budget: t1 and t2 evict in capturedAt order.
  const store = makeStore({ profileBudgetBytes: 4, perTabLimitBytes: 100 });
  await store.savePreview(viewportPreview({ token: "t1", tabId: 1, capturedAt: 100 }));
  await store.savePreview(viewportPreview({ token: "t2", tabId: 2, capturedAt: 200 }));
  await store.savePreview(viewportPreview({ token: "t3", tabId: 3, capturedAt: 300 }));
  const tokens = (await store.listMetadata()).map((record) => record.token).sort();
  assert.deepEqual(tokens, ["t3"], "only the newest preview fits a tiny profile budget");
});

test("oversized single capture fails loudly instead of truncating", async () => {
  const store = makeStore({ perTabLimitBytes: 1 });
  await assert.rejects(() => store.savePreview(viewportPreview()), /exceeds per-tab limit/);
});

test("legacy preview migrates only when its exact token is opened", async () => {
  const backing = new Map([[`${PREVIEW_KEY_PREFIX}legacy-on-demand`, {
    token: "legacy-on-demand",
    originalUrl: "https://example.com/on-demand",
    title: "On demand",
    imageDataUrl: PNG_A,
    capturedAt: 10,
    frozenAt: 11
  }]]);
  let getKeysCalls = 0;
  const payloadReads = [];
  const storageArea = {
    async get(key) {
      payloadReads.push(key);
      return backing.has(key) ? { [key]: structuredClone(backing.get(key)) } : {};
    },
    async getKeys() { getKeysCalls++; return [...backing.keys()]; },
    async remove(key) { backing.delete(key); }
  };
  const store = makeStore({ legacyStorageArea: storageArea });

  assert.equal(await store.hasPreview("legacy-on-demand", { includeLegacy: false }), false);
  assert.equal(getKeysCalls, 0, "startup-safe existence checks must not enumerate the legacy store");
  assert.deepEqual(payloadReads, [], "startup-safe existence checks must not decode any legacy payload");

  const migrated = await store.getPreview("legacy-on-demand");
  assert.equal(migrated.metadata.originalUrl, "https://example.com/on-demand");
  assert.deepEqual(payloadReads, [`${PREVIEW_KEY_PREFIX}legacy-on-demand`]);
  assert.equal(backing.size, 0, "verified on-demand migration removes only its source record");
  assert.equal(getKeysCalls, 0, "named on-demand migration never scans unrelated legacy keys");
});

test("migration converts legacy Base64 + DOM records, verifies counts, removes old keys, idempotent", async ({ }) => {
  const backing = new Map();
  let readAllCalls = 0;
  const storageArea = {
    async get(keys) {
      if (keys === null) {
        readAllCalls++;
        throw new Error("migration must never materialize the complete storage area");
      }
      if (typeof keys === "string") return backing.has(keys) ? { [keys]: structuredClone(backing.get(keys)) } : {};
      return Object.fromEntries([...backing].filter(([key]) => keys.includes(key)));
    },
    async getKeys() { return [...backing.keys()]; },
    async set(values) { for (const [key, value] of Object.entries(values)) backing.set(key, structuredClone(value)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) backing.delete(key); }
  };
  const legacyBitmap = { token: "legacy-bitmap", originalUrl: "https://example.com/bitmap", title: "Bitmap", imageDataUrl: PNG_A, capturedAt: 5, frozenAt: 6 };
  const legacyDom = { token: "legacy-dom", originalUrl: "https://example.com/dom", title: "Dom", html: "<html><body>legacy</body></html>", scrollX: 3, scrollY: 4, width: 1280, height: 800, devicePixelRatio: 2, capturedAt: 7, frozenAt: null };
  backing.set(`${PREVIEW_KEY_PREFIX}legacy-bitmap`, legacyBitmap);
  backing.set(`${PREVIEW_KEY_PREFIX}legacy-dom`, legacyDom);
  backing.set(`${PREVIEW_KEY_PREFIX}junk`, { nonsense: true });

  const store = makeStore();
  const outcome = await store.migrateLegacyRecords(storageArea);
  assert.equal(readAllCalls, 0, "migration must enumerate keys without reading the multi-gigabyte store into memory");
  assert.equal(outcome.migrated, 2);
  assert.deepEqual(outcome.failed, [`${PREVIEW_KEY_PREFIX}junk`], "unconvertible junk stays in storage.local");
  assert.equal(backing.size, 1, "successfully migrated keys are removed");

  const bitmap = await store.getPreview("legacy-bitmap");
  assert.equal(bitmap.metadata.originalUrl, "https://example.com/bitmap");
  assert.deepEqual(new Uint8Array(await bitmap.images[0].blob.arrayBuffer()), dataUrlToBytes(PNG_A));
  const dom = await store.getMetadata("legacy-dom");
  assert.equal(dom.html, "<html><body>legacy</body></html>");
  assert.equal(dom.viewportWidth, 1280);
  assert.equal(dom.devicePixelRatio, 2);

  // Restart-safe: rerunning migrates only what remains.
  const second = await store.migrateLegacyRecords(storageArea);
  assert.equal(second.migrated, 0);
  assert.deepEqual(second.failed, [`${PREVIEW_KEY_PREFIX}junk`]);
  assert.equal(await store.hasPreview("legacy-bitmap"), true);
});

test("reconciliation drops rows with missing blobs and unreachable tokens, prunes orphan blobs", async () => {
  const store = makeStore();
  await store.savePreview(viewportPreview({ token: "live", tabId: 1 }));
  await store.savePreview(viewportPreview({ token: "dead", tabId: 2 }));

  const result = await store.reconcile(new Set(["live"]));
  assert.equal(result.kept, 1);
  assert.equal(result.droppedOrphans, 1);
  assert.equal(await store.hasPreview("dead"), false);
  assert.equal(await store.hasPreview("live"), true);

  // Simulate crash between stores: metadata references a pruned blob.
  const db = store.indexedDb.databases.get("tab-sleep-previews");
  const live = await store.getMetadata("live");
  db.data.get(BLOB_STORE).delete(live.images[0].contentHash);
  const repaired = await store.reconcile(new Set(["live"]));
  assert.equal(repaired.droppedOrphans, 1, "row with missing blob is dropped rather than served broken");
});

test("getPreview returns null for missing tokens and broken records instead of partial data", async () => {
  const store = makeStore();
  assert.equal(await store.getPreview("nope"), null);
  assert.equal(await store.hasPreview("nope"), false);
  await store.savePreview(viewportPreview());
  const db = store.indexedDb.databases.get("tab-sleep-previews");
  const metadata = [...db.data.get(METADATA_STORE).values()][0];
  db.data.get(BLOB_STORE).delete(metadata.images[0].contentHash);
  assert.equal(await store.getPreview("token-a"), null);
});
