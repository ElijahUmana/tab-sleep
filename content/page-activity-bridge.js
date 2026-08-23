// MAIN-world transport bridge. It distinguishes short/background plumbing from
// active network work without looking at page text or UI labels.
//
// Wrappers are installed exactly once per document. Reinjection refreshes the
// controller methods, so fetch/stream/socket prototypes never accumulate layers.
const CONTROLLER_KEY = "__TAB_SLEEP_TRANSPORT_CONTROLLER__";
const FETCH_WRAPPED_KEY = "__TAB_SLEEP_FETCH_WRAPPED__";
const STREAM_WRAPPED_KEY = "__TAB_SLEEP_STREAM_WRAPPED__";
const RESPONSE_WRAPPED_KEY = "__TAB_SLEEP_RESPONSE_WRAPPED__";
const REALTIME_WRAPPED_KEY = "__TAB_SLEEP_REALTIME_WRAPPED__";
const REQUEST_MIN_BUSY_MS = 3_000;
const REQUEST_MAX_BUSY_MS = 30_000;
const STREAM_PROGRESS_GRACE_MS = 15_000;
const REQUEST_PRUNE_MS = 5 * 60_000;
const REALTIME_BURST_WINDOW_MS = 5_000;
const REALTIME_BURST_THRESHOLD = 3;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const controller = globalThis[CONTROLLER_KEY] ?? {
  nextId: 1,
  requests: new Map(),
  streamIds: new WeakMap(),
  readerIds: new WeakMap(),
  realtimeMessages: [],
  lastRealtimeProgressAt: 0
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
    responseAttachedAt: 0,
    streamingConsumer: false,
    pendingReads: 0,
    lastProgressAt: 0
  });
  publish("request:start");
  return id;
};

controller.attachResponse = (id, response) => {
  const request = controller.requests.get(id);
  if (!request) return;
  request.responseAttachedAt = Date.now();
  if (response?.body) controller.streamIds.set(response.body, id);
  else controller.finish(id, "request:no-body");
  publish("request:headers");
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

controller.noteRealtimeMessage = () => {
  const now = Date.now();
  controller.realtimeMessages = controller.realtimeMessages
    .filter((at) => now - at <= REALTIME_BURST_WINDOW_MS);
  controller.realtimeMessages.push(now);
  if (controller.realtimeMessages.length >= REALTIME_BURST_THRESHOLD) {
    controller.lastRealtimeProgressAt = now;
  }
  publish("realtime:message");
};

controller.busy = () => {
  const now = Date.now();
  for (const [id, request] of controller.requests) {
    const elapsed = now - request.startedAt;
    const safeMethod = SAFE_METHODS.has(request.method);
    if (elapsed >= REQUEST_MIN_BUSY_MS && elapsed <= REQUEST_MAX_BUSY_MS) return true;

    if (!safeMethod) {
      // A POST/PUT/PATCH/DELETE that has not returned headers is still real
      // work. Once headers arrive, it remains work while its body is actively
      // consumed; an ignored response expires rather than pinning forever.
      if (!request.responseAttachedAt) return true;
      if (request.pendingReads > 0) return true;
      if (request.streamingConsumer && now - request.lastProgressAt <= STREAM_PROGRESS_GRACE_MS) return true;
      if (now - request.responseAttachedAt <= REQUEST_MAX_BUSY_MS) return true;
    } else if (request.streamingConsumer && now - request.lastProgressAt <= STREAM_PROGRESS_GRACE_MS) {
      // GET long-polls become stale; an actually progressing GET stream remains
      // awake as chunks are consumed.
      return true;
    }

    const referenceAt = request.lastProgressAt || request.responseAttachedAt || request.startedAt;
    if (now - referenceAt > REQUEST_PRUNE_MS) controller.requests.delete(id);
  }

  return now - controller.lastRealtimeProgressAt <= STREAM_PROGRESS_GRACE_MS;
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
  if (readerPrototype?.cancel) {
    const originalCancel = readerPrototype.cancel;
    readerPrototype.cancel = async function(...args) {
      const activeController = globalThis[CONTROLLER_KEY];
      const id = activeController.readerIds.get(this);
      try {
        return await originalCancel.apply(this, args);
      } finally {
        if (id !== undefined) activeController.finish(id, "stream:cancel");
      }
    };
  }
}

if (!globalThis[RESPONSE_WRAPPED_KEY] && typeof Response !== "undefined") {
  globalThis[RESPONSE_WRAPPED_KEY] = true;
  for (const method of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
    const original = Response.prototype[method];
    if (typeof original !== "function") continue;
    Response.prototype[method] = async function(...args) {
      const activeController = globalThis[CONTROLLER_KEY];
      const id = this.body ? activeController.streamIds.get(this.body) : undefined;
      if (id === undefined) return original.apply(this, args);
      activeController.markStreamingConsumer(id);
      try {
        return await original.apply(this, args);
      } finally {
        activeController.finish(id, `response:${method}`);
      }
    };
  }
}

if (!globalThis[REALTIME_WRAPPED_KEY]) {
  globalThis[REALTIME_WRAPPED_KEY] = true;
  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket === "function") {
    globalThis.WebSocket = class extends OriginalWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", () => globalThis[CONTROLLER_KEY].noteRealtimeMessage());
      }
    };
  }
  const OriginalEventSource = globalThis.EventSource;
  if (typeof OriginalEventSource === "function") {
    globalThis.EventSource = class extends OriginalEventSource {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", () => globalThis[CONTROLLER_KEY].noteRealtimeMessage());
      }
    };
  }
}

window.addEventListener("__tab_sleep_bridge_ping__", () => publish("bridge:pong"));
publish("bridge:init");
