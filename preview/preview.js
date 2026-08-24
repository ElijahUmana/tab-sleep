const params = new URLSearchParams(location.search);
const token = params.get("token");
const preview = document.querySelector("#preview");
const snapshot = document.querySelector("#snapshot");
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

// Full-page tiled capture: one canvas spanning the entire scrollable page,
// backed by WebP tile Blobs delivered by PREVIEW_GET_RECORD. Tiles covering
// the initially visible region decode before readiness; the remainder decode
// in the background so a huge page still shows its top instantly.
async function renderTiledPreview(record) {
  const tileRecords = [...record.tiles].sort((a, b) => a.index - b.index);
  snapshot.width = record.width;
  snapshot.height = record.height;
  const context = snapshot.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, snapshot.width, snapshot.height);
  const painted = new Set();
  const paintTile = async (tile) => {
    if (painted.has(tile.index)) return;
    painted.add(tile.index);
    const bitmap = await createImageBitmap(tile.blob);
    context.drawImage(bitmap, 0, tile.y);
    bitmap.close();
  };
  const firstTileHeight = tileRecords[0]?.height ?? FULL_TILE_FALLBACK_HEIGHT;
  const eagerCount = Math.max(1, Math.ceil((record.viewportHeight ?? window.innerHeight) / firstTileHeight));
  for (const tile of tileRecords.slice(0, Math.min(eagerCount, tileRecords.length))) {
    await paintTile(tile);
  }
  void Promise.all(tileRecords.slice(eagerCount).map((tile) => paintTile(tile))).catch((error) => {
    meta.textContent = `Frozen page is partially rendered: ${error.message}`;
  });
}

const FULL_TILE_FALLBACK_HEIGHT = 4_096;

async function loadPreview() {
  if (!token) throw new Error("Missing preview token");
  const response = await chrome.runtime.sendMessage({ type: "PREVIEW_GET_RECORD", token });
  if (response?.__tabSleepError) throw new Error(response.__tabSleepError);
  record = response;
  if (!record) {
    throw new Error("Frozen record missing");
  }

  document.title = `💤 ${record.title || "Sleeping tab"}`;

  // Migrated/legacy records still carry a Base64 data URL in storage.local;
  // store-backed records deliver a decoded viewport PNG Blob instead.
  let viewportBitmapSource = null;
  if (typeof record.imageDataUrl === "string" && record.imageDataUrl.startsWith("data:image/")) {
    const comma = record.imageDataUrl.indexOf(",");
    if (comma < 0) throw new Error("Frozen image data is malformed");
    const binary = atob(record.imageDataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    viewportBitmapSource = new Blob([bytes], { type: "image/png" });
  } else if (record.viewportImage instanceof Blob) {
    viewportBitmapSource = record.viewportImage;
  }
  if (viewportBitmapSource) {
    const bitmap = await createImageBitmap(viewportBitmapSource);
    snapshot.width = bitmap.width;
    snapshot.height = bitmap.height;
    const context = snapshot.getContext("2d", { alpha: false });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    snapshot.hidden = false;
    domSnapshot.hidden = true;
    meta.textContent = describeSnapshot(record.capturedAt);
    await reportReady("bitmap");
    return;
  }

  if (Array.isArray(record.tiles) && record.tiles.length > 0) {
    await renderTiledPreview(record);
    snapshot.hidden = false;
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
    } catch {}
    domSnapshot.hidden = false;
    snapshot.hidden = true;
    meta.textContent = describeSnapshot(record.capturedAt);
    await reportReady("dom");
    return;
  }

  throw new Error("Frozen visual is unavailable");
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

void loadWhenVisible().catch(async (error) => {
  meta.textContent = error.message;
  try {
    await chrome.runtime.sendMessage({ type: "PREVIEW_FAILED", token, error: error.message });
  } catch {}
});
