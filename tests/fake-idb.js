// Minimal in-memory IndexedDB implementation covering the surface
// lib/preview-store.js uses: open/onupgradeneeded, two object stores with
// inline keys, indexes (created but unused for lookups), get/getAll/put/delete,
// and readwrite transactions that commit asynchronously so the store's
// transaction-completion awaits behave like real Chrome.

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
  settle(operation) {
    try {
      this.result = operation();
      queueMicrotask(() => this.onsuccess?.());
    } catch (error) {
      this.error = error;
      queueMicrotask(() => this.onerror?.(error));
    }
  }
}

export class FakeObjectStore {
  constructor(db, name, keyPath) {
    this.db = db;
    this.name = name;
    this.keyPath = keyPath;
    this.indexes = new Map();
  }
  // Requests settle asynchronously like real IDB; microtasks run before the
  // macrotask timer that commits the transaction, so writes issued while a
  // transaction is active land before commit. The operation ALWAYS executes —
  // handlers are optional observers, not triggers.
  schedule(request, operation) {
    queueMicrotask(() => {
      try {
        request.result = operation();
        queueMicrotask(() => request.onsuccess?.());
      } catch (error) {
        request.error = error;
        queueMicrotask(() => request.onerror?.(error));
      }
    });
    return request;
  }
  get(key) {
    return this.schedule(new FakeRequest(), () => {
      const row = this.db.data.get(this.name).get(key);
      return row ? structuredClone(row) : undefined;
    });
  }
  getAll() {
    return this.schedule(new FakeRequest(), () => [...this.db.data.get(this.name).values()].map((row) => structuredClone(row)));
  }
  put(value) {
    return this.schedule(new FakeRequest(), () => {
      if (this.db.aborted) throw new Error("Transaction aborted");
      const key = value[this.keyPath];
      this.db.data.get(this.name).set(key, structuredClone(value));
      return key;
    });
  }
  delete(key) {
    return this.schedule(new FakeRequest(), () => {
      if (this.db.aborted) throw new Error("Transaction aborted");
      this.db.data.get(this.name).delete(key);
      return undefined;
    });
  }
  createIndex(name) {
    this.indexes.set(name, true);
  }
}

export class FakeTransaction {
  constructor(db, mode) {
    this.db = db;
    this.mode = mode;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.error = null;
    this.done = false;
  }
  objectStore(name) { return this.db.stores.get(name); }
  abort() {
    if (this.done) return;
    this.done = true;
    this.db.aborted = true;
    this.error = this.error ?? new Error("Aborted");
    queueMicrotask(() => this.onabort?.());
  }
  commit() {
    if (this.done || this.db.aborted) return;
    this.done = true;
    queueMicrotask(() => this.oncomplete?.());
  }
}

export class FakeDatabase {
  constructor() {
    this.data = new Map([["metadata", new Map()], ["blobs", new Map()]]);
    this.stores = new Map([
      ["metadata", new FakeObjectStore(this, "metadata", "token")],
      ["blobs", new FakeObjectStore(this, "blobs", "contentHash")]
    ]);
    this.aborted = false;
    this.closed = false;
    this.version = 0;
    this.upgradeNeeded = null;
    this.activeTransaction = null;
  }
  get objectStoreNames() {
    return { contains: (name) => this.stores.has(name) };
  }
  transaction(storeNames, mode = "readonly") {
    if (this.closed) throw new Error("Database is closed");
    // Real IDB auto-commits a transaction once its request queue drains and no
    // new requests are pending; emulate by committing on a macrotask boundary.
    const transaction = new FakeTransaction(this, mode);
    this.aborted = false;
    this.activeTransaction = transaction;
    setTimeout(() => transaction.commit(), 0);
    return transaction;
  }
  close() { this.closed = true; }
}

export class FakeIndexedDbFactory {
  constructor() {
    this.databases = new Map();
  }
  open(name, version) {
    let db = this.databases.get(name);
    const isNew = !db;
    if (!db) {
      db = new FakeDatabase();
      this.databases.set(name, db);
    }
    const request = new FakeRequest();
    // Real IDB populates request.result before firing onupgradeneeded.
    request.result = db;
    queueMicrotask(() => {
      if (isNew || version > db.version) {
        db.version = version;
        request.onupgradeneeded?.call(request, { target: { result: db } });
      }
      request.settle(() => db);
    });
    return request;
  }
}
