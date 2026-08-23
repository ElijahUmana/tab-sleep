// Each injection supersedes the previous tracker. Older callbacks self-retire
// instead of accumulating work after an extension reload.
globalThis.__TAB_SLEEP_GENERATION__ = (globalThis.__TAB_SLEEP_GENERATION__ ?? 0) + 1;
const GENERATION = globalThis.__TAB_SLEEP_GENERATION__;
const HEARTBEAT_INTERVAL_MS = 2_000;

let remoteBusy = false;
let bridgeReady = false;
let lastVisible = !document.hidden;
let lastBusy = false;
let sendTimer = null;

const retired = () => GENERATION !== globalThis.__TAB_SLEEP_GENERATION__;

function mediaBusy() {
  return [...document.querySelectorAll("audio, video")]
    .some((media) => !media.paused && !media.ended);
}

function busyNow() {
  return remoteBusy || mediaBusy();
}

function visibleNow() {
  return !document.hidden;
}

function send({ activity = false, source = "heartbeat" } = {}) {
  if (retired()) return;
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    if (retired()) return;
    const visible = visibleNow();
    const busy = busyNow();
    lastVisible = visible;
    lastBusy = busy;
    globalThis.__TAB_SLEEP_SIGNAL__ = { visible, busy, bridgeReady };
    void chrome.runtime.sendMessage({
      type: "PAGE_ACTIVITY_STATE",
      visible,
      busy,
      bridgeReady,
      activity,
      source
    }).catch(() => {});
  }, 50);
}

function stateChanged(source) {
  const visible = visibleNow();
  const busy = busyNow();
  if (visible !== lastVisible || busy !== lastBusy) {
    send({ activity: false, source });
  }
}

window.addEventListener("__tab_sleep_page_activity__", (event) => {
  if (retired()) return;
  bridgeReady = true;
  remoteBusy = Boolean(event.detail?.busy);
  send({ activity: false, source: event.detail?.source || "bridge" });
});

// Only direct user input resets idle age. DOM/title/layout/network churn never
// does. Scroll counts only while the page is visible and the event is trusted.
for (const eventName of ["pointerdown", "keydown", "input", "change", "scroll"]) {
  document.addEventListener(eventName, (event) => {
    if (retired() || !event.isTrusted || document.hidden) return;
    send({ activity: true, source: eventName });
  }, { capture: true, passive: eventName !== "keydown" });
}

for (const eventName of ["play", "pause", "ended", "volumechange"]) {
  document.addEventListener(eventName, () => stateChanged(`media:${eventName}`), { capture: true, passive: true });
}

document.addEventListener("visibilitychange", () => stateChanged("visibility"));

globalThis.__TAB_SLEEP_SIGNAL__ = {
  visible: visibleNow(),
  busy: busyNow(),
  bridgeReady
};
window.dispatchEvent(new CustomEvent("__tab_sleep_bridge_ping__"));
send({ activity: false, source: "init" });

function heartbeat() {
  if (retired()) return;
  window.dispatchEvent(new CustomEvent("__tab_sleep_bridge_ping__"));
  send({ activity: false, source: "heartbeat" });
  setTimeout(heartbeat, HEARTBEAT_INTERVAL_MS);
}
heartbeat();
