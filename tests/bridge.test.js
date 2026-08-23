import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bridgeSource = readFileSync(resolve(root, "content/page-activity-bridge.js"), "utf8");

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function bridgeHarness() {
  const c = clock();
  const fetchDeferreds = [];
  class FakeReadableStream {
    getReader() { return new FakeReader(); }
  }
  class FakeReader {
    constructor() { this.reads = []; }
    read() { const d = deferred(); this.reads.push(d); return d.promise; }
  }
  class FakeResponse {
    constructor(body = null) { this.body = body; }
  }
  class FakeRequest { constructor(url, { method = "GET" } = {}) { this.url = url; this.method = method; } }
  const context = {
    console,
    Promise,
    Map,
    WeakMap,
    Set,
    Request: FakeRequest,
    Response: FakeResponse,
    ReadableStream: FakeReadableStream,
    ReadableStreamDefaultReader: FakeReader,
    Date: { now: c.now },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    window: { listeners: new Map(), addEventListener(type, fn) { this.listeners.set(type, fn); }, dispatchEvent(event) { this.listeners.get(event.type)?.(event); } },
    fetch(...args) { const d = deferred(); fetchDeferreds.push({ args, ...d }); return d.promise; }
  };
  context.globalThis = context;
  vm.runInNewContext(bridgeSource, context, { filename: "page-activity-bridge.js" });
  return { c, context, fetchDeferreds, controller: context.__TAB_SLEEP_TRANSPORT_CONTROLLER__ };
}

test("short fetch plumbing never reports busy", async () => {
  const h = bridgeHarness();
  const request = h.context.fetch("https://example.com/poll");
  h.c.advance(2_999);
  assert.equal(h.controller.busy(), false);
  h.fetchDeferreds[0].resolve(new h.context.Response());
  await request;
});

test("substantial request reports busy only in the bounded transfer window", () => {
  const h = bridgeHarness();
  void h.context.fetch("https://example.com/long-poll");
  h.c.advance(3_000);
  assert.equal(h.controller.busy(), true);
  h.c.advance(27_001);
  assert.equal(h.controller.busy(), false);
});

test("actively consumed POST stream stays busy past 30 seconds", async () => {
  const h = bridgeHarness();
  const responsePromise = h.context.fetch("https://chat.example/respond", { method: "POST" });
  const body = new h.context.ReadableStream();
  h.fetchDeferreds[0].resolve({ body });
  const response = await responsePromise;
  const reader = response.body.getReader();
  h.c.advance(31_000);
  const read = reader.read();
  assert.equal(h.controller.busy(), true);
  reader.reads[0].resolve({ done: false, value: new Uint8Array([1]) });
  await read;
  assert.equal(h.controller.busy(), true);
  h.c.advance(15_001);
  assert.equal(h.controller.busy(), false);
});

test("completed stream stops reporting busy", async () => {
  const h = bridgeHarness();
  const responsePromise = h.context.fetch("https://chat.example/respond", { method: "POST" });
  const body = new h.context.ReadableStream();
  h.fetchDeferreds[0].resolve({ body });
  const response = await responsePromise;
  const reader = response.body.getReader();
  const read = reader.read();
  reader.reads[0].resolve({ done: true, value: undefined });
  await read;
  assert.equal(h.controller.busy(), false);
});
