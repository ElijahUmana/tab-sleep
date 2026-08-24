import {
  FULL_PAGE_ATTACH_TIMEOUT_MS,
  FULL_PAGE_MAX_TILES,
  FULL_PAGE_TILE_HEIGHT,
  FULL_PAGE_WEBP_QUALITY
} from "./constants.js";

// Full-page frozen visuals via the Chrome DevTools Protocol. chrome.debugger
// can screenshot a BACKGROUND tab without ever scrolling it, focusing it, or
// bringing it to front — unlike chrome.tabs.captureVisibleTab, which needs the
// tab selected and on screen. Pages taller than one tile are captured as
// vertical WebP tiles so no single bitmap exceeds Chrome's size limits.
const DEBUG_PROTOCOL_VERSION = "1.3";
const message = (error) => String(error?.message ?? error);

function withTimeout(operation, ms, label) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

export class FullPageCapturer {
  constructor(chromeApi) {
    this.chrome = chromeApi;
  }

  send(target, method, params) {
    return this.chrome.debugger.sendCommand(target, method, params);
  }

  // Returns { ok: true, capture } on success or { ok: false, reason } when the
  // debugger pathway is unavailable (DevTools already attached, chrome://
  // target, timeout, protocol error). Failure is a normal outcome that the
  // caller turns into its next fallback — never scrolled, focused, or
  // brought to front, and the target is always detached in `finally`.
  async capture(tab) {
    const target = { tabId: tab.id };
    let attached = false;
    try {
      await withTimeout(this.chrome.debugger.attach(target, DEBUG_PROTOCOL_VERSION), FULL_PAGE_ATTACH_TIMEOUT_MS, "debugger attach");
      attached = true;
      const metrics = await this.send(target, "Page.getLayoutMetrics", {});
      const content = metrics.cssContentSize ?? metrics.contentSize;
      const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
      const width = Math.ceil(Number(content?.width ?? 0));
      const height = Math.ceil(Number(content?.height ?? 0));
      if (!(width > 0 && height > 0)) return { ok: false, reason: "Page.getLayoutMetrics reported no usable content size" };
      if (height <= FULL_PAGE_TILE_HEIGHT) {
        const shot = await this.send(target, "Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        return {
          ok: true,
          capture: {
            kind: "imageDataUrl",
            imageDataUrl: `data:image/png;base64,${shot.data}`,
            width,
            height,
            viewportWidth: Math.ceil(Number(viewport?.clientWidth ?? 0)),
            viewportHeight: Math.ceil(Number(viewport?.clientHeight ?? 0))
          }
        };
      }
      const tileCount = Math.ceil(height / FULL_PAGE_TILE_HEIGHT);
      if (tileCount > FULL_PAGE_MAX_TILES) {
        return { ok: false, reason: `page is ${height}px tall (${tileCount} tiles), over the ${FULL_PAGE_MAX_TILES}-tile limit` };
      }
      const tiles = [];
      for (let index = 0; index < tileCount; index++) {
        const y = index * FULL_PAGE_TILE_HEIGHT;
        const tileHeight = Math.min(FULL_PAGE_TILE_HEIGHT, height - y);
        const shot = await this.send(target, "Page.captureScreenshot", {
          format: "webp",
          quality: FULL_PAGE_WEBP_QUALITY,
          captureBeyondViewport: true,
          clip: { x: 0, y, width, height: tileHeight, scale: 1 }
        });
        tiles.push({ index, y, height: tileHeight, imageDataUrl: `data:image/webp;base64,${shot.data}` });
      }
      return {
        ok: true,
        capture: {
          kind: "tiles",
          width,
          height,
          viewportWidth: Math.ceil(Number(viewport?.clientWidth ?? 0)),
          viewportHeight: Math.ceil(Number(viewport?.clientHeight ?? 0)),
          tiles
        }
      };
    } catch (error) {
      return { ok: false, reason: message(error) };
    } finally {
      if (attached) {
        await this.chrome.debugger.detach(target).catch((error) => {
          console.error(`[Tab Sleep] Failed to detach debugger from tab ${tab.id}`, error);
        });
      }
    }
  }
}
