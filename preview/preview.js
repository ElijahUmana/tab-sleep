import { previewStorageKey } from "../lib/constants.js";

const token = new URLSearchParams(location.search).get("token");
const preview = document.querySelector("#preview");
const snapshot = document.querySelector("#snapshot");
const domSnapshot = document.querySelector("#domSnapshot");
const meta = document.querySelector("#meta");
const waking = document.querySelector("#waking");

let record = null;
let wakingNow = false;

function formatCapturedAt(timestamp) {
  if (!Number.isFinite(timestamp)) return "Click the frozen page to wake";
  return `Snapshot ${new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · Click to wake`;
}

async function reportReady(kind) {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await chrome.runtime.sendMessage({ type: "PREVIEW_READY", token, kind });
}

async function loadPreview() {
  if (!token) throw new Error("Missing preview token");
  const response = await chrome.runtime.sendMessage({ type: "PREVIEW_GET_RECORD", token });
  if (response?.__tabSleepError) throw new Error(response.__tabSleepError);
  record = response;
  if (!record) {
    const stored = await chrome.storage.local.get(previewStorageKey(token));
    record = stored[previewStorageKey(token)] ?? null;
  }
  if (!record) {
    throw new Error("Frozen record missing");
  }

  document.title = `💤 ${record.title || "Sleeping tab"}`;

  if (typeof record.imageDataUrl === "string" && record.imageDataUrl.startsWith("data:image/")) {
    const comma = record.imageDataUrl.indexOf(",");
    if (comma < 0) throw new Error("Frozen image data is malformed");
    const binary = atob(record.imageDataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    snapshot.width = bitmap.width;
    snapshot.height = bitmap.height;
    const context = snapshot.getContext("2d", { alpha: false });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    snapshot.hidden = false;
    domSnapshot.hidden = true;
    meta.textContent = formatCapturedAt(record.capturedAt);
    await reportReady("bitmap");
    return;
  }

  if (typeof record.html === "string" && record.html.length >= 20) {
    await new Promise((resolve) => {
      domSnapshot.addEventListener("load", resolve, { once: true });
      domSnapshot.srcdoc = record.html;
    });
    domSnapshot.hidden = false;
    snapshot.hidden = true;
    meta.textContent = formatCapturedAt(record.capturedAt);
    await reportReady("dom");
    return;
  }

  throw new Error("Frozen visual is unavailable");
}

async function wake() {
  if (wakingNow) return;
  wakingNow = true;
  waking.hidden = false;
  try {
    const response = await chrome.runtime.sendMessage({ type: "WAKE_PREVIEW", token });
    if (response?.__tabSleepError) throw new Error(response.__tabSleepError);
  } catch (error) {
    waking.hidden = true;
    wakingNow = false;
    meta.textContent = `Could not wake: ${error.message}`;
  }
}

preview.addEventListener("click", (event) => {
  if (!event.isTrusted) return;
  void wake();
});
preview.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    void wake();
  }
});

void loadPreview().catch(async (error) => {
  meta.textContent = error.message;
  try {
    await chrome.runtime.sendMessage({ type: "PREVIEW_FAILED", token, error: error.message });
  } catch {}
});
