// MAIN-world transport bridge. It distinguishes short/background plumbing from
// an actively consumed streaming response without looking at page text or UI.
//
// Wrappers are installed exactly once per document. Reinjection only refreshes
// the controller methods, so fetch/stream prototypes never accumulate layers.
const CONTROLLER_KEY = "__TAB_SLEEP_TRANSPORT_CONTROLLER__";
const FETCH_WRAPPED_KEY = "__TAB_SLEEP_FETCH_WRAPPED__";
const STREAM_WRAPPED_KEY = "__TAB_SLEEP_STREAM_WRAPPED__";
const REQUEST_MIN_BUSY_MS = 3_000;
const REQUEST_MAX_BUSY_MS = 30_000;
const STREAM_PROGRESS_GRACE_MS = 15_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const controller = globalThis[CONTROLLER_KEY] ?? {
  nextId: 1,
  requests: new Map(),
  streamIds: new WeakMap(),
  readerIds: new WeakMap()
};
globalThis[CONTROLLER_KEY] = controller;

globalThis.__TAB_SLEEP_PAGE_ACTIVITY_INSTALLED__ = true;

function publish(source) {
  const busy = controller.busy();
  globalThis.__TAB_SLEEP_REMOTE_BUSY__ = busy;
  window.dispatchEvent(new CustomEvent("__tab_sleep_page_activity__", {
    detail: { busy, activity: false, source }
  }));
}

controller.start = (method) => {
  const id = controller.nextId++;
  controller.requests.set(id, {
    method: String(method || "GET").toUpperCase(),
    startedAt: Date.now(),
    streamingConsumer: false,
    pendingReads: 0,
    lastProgressAt: 0
  });
  publish("request:start");
  return id;
};

controller.attachResponse = (id, response) => {
  if (response?.body && controller.requests.has(id)) {
    controller.streamIds.set(response.body, id);
  }
};

controller.markStreamingConsumer = (id) => {
  const request = controller.requests.get(id);
  if (!request) return;
  request.streamingConsumer = true;
  request.lastProgressAt = Date.now();
  publish("stream:consumer");
};

controller.readStarted = (id) => {
  const request = controller.requests.get(id);
  if (!request) return;
  request.streamingConsumer = true;
  request.pendingReads++;
  publish("stream:read-start");
};

controller.readFinished = (id, done) => {
  const request = controller.requests.get(id);
  if (!request) return;
  request.pendingReads = Math.max(0, request.pendingReads - 1);
  request.lastProgressAt = Date.now();
  if (done) controller.requests.delete(id);
  publish(done ? "stream:end" : "stream:progress");
};

controller.finish = (id, source = "request:end") => {
  if (!controller.requests.delete(id)) return;
  publish(source);
};

controller.busy = () => {
  const now = Date.now();
  for (const request of controller.requests.values()) {
    const elapsed = now - request.startedAt;
    if (elapsed >= REQUEST_MIN_BUSY_MS && elapsed <= REQUEST_MAX_BUSY_MS) return true;
    const activeStream = request.streamingConsumer && !SAFE_METHODS.has(request.method);
    if (activeStream && request.pendingReads > 0) return true;
    if (activeStream && now - request.lastProgressAt <= STREAM_PROGRESS_GRACE_MS) return true;
  }
  return false;
};

if (!globalThis[FETCH_WRAPPED_KEY] && typeof globalThis.fetch === "function") {
  globalThis[FETCH_WRAPPED_KEY] = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function(...args) {
    const input = args[0];
    const init = args[1];
    const method = init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
    const activeController = globalThis[CONTROLLER_KEY];
    const id = activeController.start(method);
    try {
      const response = await originalFetch.apply(this, args);
      activeController.attachResponse(id, response);
      if (!response?.body) activeController.finish(id);
      return response;
    } catch (error) {
      activeController.finish(id, "request:error");
      throw error;
    }
  };
}

if (!globalThis[STREAM_WRAPPED_KEY] && typeof ReadableStream !== "undefined") {
  globalThis[STREAM_WRAPPED_KEY] = true;
  const originalGetReader = ReadableStream.prototype.getReader;
  ReadableStream.prototype.getReader = function(...args) {
    const reader = originalGetReader.apply(this, args);
    const activeController = globalThis[CONTROLLER_KEY];
    const id = activeController.streamIds.get(this);
    if (id !== undefined) {
      activeController.readerIds.set(reader, id);
      activeController.markStreamingConsumer(id);
    }
    return reader;
  };

  const readerPrototype = globalThis.ReadableStreamDefaultReader?.prototype;
  if (readerPrototype?.read) {
    const originalRead = readerPrototype.read;
    readerPrototype.read = async function(...args) {
      const activeController = globalThis[CONTROLLER_KEY];
      const id = activeController.readerIds.get(this);
      if (id === undefined) return originalRead.apply(this, args);
      activeController.readStarted(id);
      try {
        const result = await originalRead.apply(this, args);
        activeController.readFinished(id, Boolean(result?.done));
        return result;
      } catch (error) {
        activeController.finish(id, "stream:error");
        throw error;
      }
    };
  }
}

window.addEventListener("__tab_sleep_bridge_ping__", () => publish("bridge:pong"));
publish("bridge:init");
