import { PreviewStore } from "../lib/preview-store.js";

const params = new URLSearchParams(location.search);
const token = params.get("token");
const preview = document.querySelector("#preview");
const snapshot = document.querySelector("#snapshot");
const documentSurface = document.querySelector("#documentSurface");
const documentTiles = document.querySelector("#documentTiles");
const nestedRegions = document.querySelector("#nestedRegions");
const missing = document.querySelector("#missing");
const missingSite = document.querySelector("#missingSite");
const domSnapshot = document.querySelector("#domSnapshot");
const meta = document.querySelector("#meta");
const waking = document.querySelector("#waking");

let record = null;
let wakingNow = false;

// After a failed wake the service worker restores this preview with retry=1;
// the frozen visual and original URL are intact, so one click retries.
function describeSnapshot(timestamp) {
  if (params.get("retry") === "1") return "The site did not load · Click to try again";
  if (!Number.isFinite(timestamp)) return "Click the frozen page to wake";
  return `Snapshot ${new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · Click to wake`;
}

async function reportReady(kind) {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await chrome.runtime.sendMessage({ type: "PREVIEW_READY", token, kind });
}

async function paintBlobToCanvas(blob, width = null, height = null) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = width ?? bitmap.width;
  canvas.height = height ?? bitmap.height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

async function renderDocumentTiles(record) {
  const tileRecords = [...record.tiles].sort((a, b) => a.index - b.index);
  documentTiles.replaceChildren();
  for (const tile of tileRecords) {
    documentTiles.append(await paintBlobToCanvas(tile.blob, tile.width || record.width, tile.height));
  }
  documentTiles.hidden = false;
  snapshot.hidden = true;
}

async function renderNestedRegions(record) {
  nestedRegions.replaceChildren();
  const scale = documentSurface.clientWidth / Math.max(1, record.width);
  for (const region of record.nestedRegions ?? []) {
    const tiles = (record.nestedTiles ?? []).filter((tile) => tile.regionIndex === region.index).sort((a, b) => a.index - b.index);
    if (tiles.length === 0) continue;
    const surface = document.createElement("div");
    surface.className = "frozen-scroll-region";
    surface.style.left = `${region.x * scale}px`;
    surface.style.top = `${region.y * scale}px`;
    surface.style.width = `${region.viewportWidth * scale}px`;
    surface.style.height = `${region.viewportHeight * scale}px`;
    const content = document.createElement("div");
    content.style.position = "relative";
    content.style.height = `${region.scrollHeight * scale}px`;
    for (const tile of tiles) {
      const canvas = await paintBlobToCanvas(tile.blob, tile.width || region.viewportWidth, tile.height);
      canvas.style.position = "absolute";
      canvas.style.left = "0";
      canvas.style.top = `${tile.y * scale}px`;
      content.append(canvas);
    }
    surface.append(content);
    surface.scrollTop = region.originalScrollTop * scale;
    nestedRegions.append(surface);
  }
}

async function renderTiledPreview(record) {
  await renderDocumentTiles(record);
  await renderNestedRegions(record);
}

async function loadPreview() {
  if (!token) throw new Error("Missing preview token");
  const store = new PreviewStore();
  const stored = await store.getPreview(token);
  let metadata = stored?.metadata ?? null;
  let images = stored?.images ?? [];
  if (!metadata) {
    // The worker is the only legacy-storage owner. Asking for metadata may
    // migrate one named 4.x token into IndexedDB; image Blobs are then read
    // locally below instead of crossing runtime messaging, which JSON-strips
    // them in real Chrome.
    const response = await chrome.runtime.sendMessage({ type: "PREVIEW_GET_RECORD", token });
    if (response?.__tabSleepError) throw new Error(response.__tabSleepError);
    const migrated = await store.getPreview(token);
    metadata = migrated?.metadata ?? response ?? null;
    images = migrated?.images ?? [];
  }
  if (!metadata) throw new Error("Frozen record missing");
  record = {
    ...metadata,
    tiles: images.some((image) => image.kind === "tile")
      ? images.filter((image) => image.kind === "tile").map((image, index) => ({ index: image.tileIndex ?? index, y: image.yOffset ?? 0, width: image.width ?? metadata.width, height: image.height ?? 0, blob: image.blob, mime: image.mime }))
      : undefined,
    nestedTiles: images.filter((image) => image.kind === "nested").map((image, index) => ({ regionIndex: image.regionIndex, index: image.tileIndex ?? index, y: image.yOffset ?? 0, width: image.width ?? 0, height: image.height ?? 0, blob: image.blob, mime: image.mime })),
    viewportImage: images.find((image) => image.kind === "viewport")?.blob ?? null
  };

  document.title = `💤 ${record.title || "Sleeping tab"}`;

  let viewportBitmapSource = record.viewportImage instanceof Blob ? record.viewportImage : null;
  if (viewportBitmapSource) {
    const bitmap = await createImageBitmap(viewportBitmapSource);
    snapshot.width = bitmap.width;
    snapshot.height = bitmap.height;
    const context = snapshot.getContext("2d", { alpha: false });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    snapshot.hidden = false;
    documentTiles.hidden = true;
    domSnapshot.hidden = true;
    await renderNestedRegions(record);
    meta.textContent = describeSnapshot(record.capturedAt);
    await reportReady("bitmap");
    return;
  }

  if (Array.isArray(record.tiles) && record.tiles.length > 0) {
    await renderTiledPreview(record);
    domSnapshot.hidden = true;
    meta.textContent = describeSnapshot(record.capturedAt);
    await reportReady("tiles");
    return;
  }

  if (typeof record.html === "string" && record.html.length >= 20) {
    await new Promise((resolve) => {
      domSnapshot.addEventListener("load", resolve, { once: true });
      domSnapshot.srcdoc = record.html;
    });
    try {
      domSnapshot.contentWindow?.scrollTo(record.scrollX ?? 0, record.scrollY ?? 0);
      const documentHeight = Math.max(
        record.height ?? 0,
        domSnapshot.contentDocument?.documentElement?.scrollHeight ?? 0,
        domSnapshot.contentDocument?.body?.scrollHeight ?? 0,
        window.innerHeight
      );
      domSnapshot.style.height = `${documentHeight}px`;
    } catch {}
    domSnapshot.hidden = false;
    documentSurface.hidden = true;
    snapshot.hidden = true;
    meta.textContent = describeSnapshot(record.capturedAt);
    await reportReady("dom");
    return;
  }

  throw new Error("Frozen visual is unavailable");
}

function showMissingPreview(error) {
  documentSurface.hidden = true;
  domSnapshot.hidden = true;
  missing.hidden = false;
  document.body.classList.add("preview-missing");
  const savedTitle = record?.title && record.title !== "Sleeping tab" ? record.title : null;
  missingSite.textContent = savedTitle
    ? `The saved image for ${savedTitle} is no longer available.`
    : "The saved image for this page is no longer available.";
  meta.textContent = `Click anywhere to wake · ${error.message}`;
}

async function wake() {
  if (wakingNow) return;
  wakingNow = true;
  waking.hidden = false;
  let destination = null;
  try {
    // Record the durable WAKING transaction first so a service-worker restart
    // mid-wake can never orphan this tab or destroy the frozen record.
    const response = await chrome.runtime.sendMessage({ type: "WAKE_BEGIN", token });
    if (response?.__tabSleepError) throw new Error(response.__tabSleepError);
    if (!response?.url) throw new Error("Wake did not return the original URL");
    destination = response.url;
  } catch (error) {
    waking.hidden = true;
    wakingNow = false;
    meta.textContent = `Could not wake · ${error.message} · Click to retry`;
    return;
  }
  meta.textContent = "Waking…";
  // Same-tab replacement from the trusted gesture handler. The frozen visual
  // keeps painting until Chrome commits the new document — the preview DOM is
  // never cleared, dimmed, or overlaid here.
  location.replace(destination);
}

preview.addEventListener("click", (event) => {
  if (!event.isTrusted) return;
  void wake();
});
preview.addEventListener("keydown", (event) => {
  if (!event.isTrusted) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    void wake();
  }
});

async function loadWhenVisible() {
  if (document.hidden) {
    await new Promise((resolve) => {
      const onVisibility = () => {
        if (document.hidden) return;
        document.removeEventListener("visibilitychange", onVisibility);
        resolve();
      };
      document.addEventListener("visibilitychange", onVisibility);
    });
  }
  return loadPreview();
}

void loadWhenVisible().catch((error) => {
  record = record ?? { title: "Sleeping tab", capturedAt: null };
  document.title = `💤 ${record.title || "Sleeping tab"}`;
  showMissingPreview(error);
  void chrome.runtime.sendMessage({ type: "PREVIEW_FAILED", token, error: error.message }).catch(() => {});
});
