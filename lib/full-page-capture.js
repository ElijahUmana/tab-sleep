import {
  FULL_PAGE_ATTACH_TIMEOUT_MS,
  FULL_PAGE_MAX_TILES,
  FULL_PAGE_TILE_HEIGHT,
  FULL_PAGE_WEBP_QUALITY,
  NESTED_SCROLL_MAX_REGIONS,
  NESTED_SCROLL_MAX_TILES,
  NESTED_SCROLL_SETTLE_MS
} from "./constants.js";

const DEBUG_PROTOCOL_VERSION = "1.3";
const NESTED_STATE_KEY = "__TAB_SLEEP_SCROLL_CAPTURE__";
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

function screenshotParams(format, clip = null) {
  return {
    format,
    ...(format === "webp" ? { quality: FULL_PAGE_WEBP_QUALITY } : {}),
    captureBeyondViewport: true,
    ...(clip ? { clip } : {})
  };
}

export class FullPageCapturer {
  constructor(chromeApi) {
    this.chrome = chromeApi;
    this.queue = Promise.resolve();
  }

  send(target, method, params) {
    return this.chrome.debugger.sendCommand(target, method, params);
  }

  capture(tab) {
    const operation = this.queue.then(() => this.performCapture(tab));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async captureDocument(target, width, height, viewport) {
    if (height <= FULL_PAGE_TILE_HEIGHT) {
      const shot = await this.send(target, "Page.captureScreenshot", screenshotParams("png"));
      return {
        kind: "imageDataUrl",
        imageDataUrl: `data:image/png;base64,${shot.data}`,
        width,
        height,
        viewportWidth: Math.ceil(Number(viewport?.clientWidth ?? width)),
        viewportHeight: Math.ceil(Number(viewport?.clientHeight ?? height))
      };
    }
    const tileCount = Math.ceil(height / FULL_PAGE_TILE_HEIGHT);
    if (tileCount > FULL_PAGE_MAX_TILES) {
      throw new Error(`page is ${height}px tall (${tileCount} tiles), over the ${FULL_PAGE_MAX_TILES}-tile limit`);
    }
    const tiles = [];
    for (let index = 0; index < tileCount; index++) {
      const y = index * FULL_PAGE_TILE_HEIGHT;
      const tileHeight = Math.min(FULL_PAGE_TILE_HEIGHT, height - y);
      const shot = await this.send(target, "Page.captureScreenshot", screenshotParams("webp", { x: 0, y, width, height: tileHeight, scale: 1 }));
      tiles.push({ index, y, height: tileHeight, width, imageDataUrl: `data:image/webp;base64,${shot.data}` });
    }
    return {
      kind: "tiles",
      width,
      height,
      viewportWidth: Math.ceil(Number(viewport?.clientWidth ?? width)),
      viewportHeight: Math.ceil(Number(viewport?.clientHeight ?? height)),
      tiles
    };
  }

  async discoverNestedRegions(tab) {
    const results = await this.chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [NESTED_STATE_KEY, NESTED_SCROLL_MAX_REGIONS],
      func: (markerPrefix, maxRegions) => {
        const viewportArea = Math.max(1, innerWidth * innerHeight);
        const candidates = [...document.querySelectorAll("*")].map((element) => {
          if (element === document.scrollingElement || element === document.documentElement || element === document.body) return null;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const visibleWidth = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
          const visibleHeight = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
          const scrollable = /(auto|scroll|overlay)/.test(style.overflowY) || element.scrollHeight > element.clientHeight;
          if (!scrollable || element.scrollHeight <= element.clientHeight + 8) return null;
          if (element.clientWidth < 160 || element.clientHeight < 120 || visibleWidth < 120 || visibleHeight < 100) return null;
          if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return null;
          const area = visibleWidth * visibleHeight;
          if (area < viewportArea * 0.04) return null;
          return { element, rect, area, score: area * Math.log2(2 + element.scrollHeight / element.clientHeight) };
        }).filter(Boolean).sort((a, b) => b.score - a.score);
        const selected = [];
        for (const candidate of candidates) {
          const overlaps = selected.some((prior) => {
            const left = Math.max(candidate.rect.left, prior.rect.left);
            const right = Math.min(candidate.rect.right, prior.rect.right);
            const top = Math.max(candidate.rect.top, prior.rect.top);
            const bottom = Math.min(candidate.rect.bottom, prior.rect.bottom);
            const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
            return overlap / Math.min(candidate.area, prior.area) > 0.75;
          });
          if (!overlaps) selected.push(candidate);
          if (selected.length >= maxRegions) break;
        }
        return selected.map(({ element, rect }, index) => {
          const marker = `${markerPrefix}-${index}`;
          const priorMarker = element.getAttribute("data-tab-sleep-capture-region");
          element.setAttribute("data-tab-sleep-capture-region", marker);
          return {
            index,
            marker,
            priorMarker,
            x: rect.left + scrollX + element.clientLeft,
            y: rect.top + scrollY + element.clientTop,
            viewportWidth: element.clientWidth,
            viewportHeight: element.clientHeight,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
            originalScrollTop: element.scrollTop,
            originalScrollLeft: element.scrollLeft
          };
        });
      }
    });
    return Array.isArray(results?.[0]?.result) ? results[0].result : [];
  }

  async scrollNestedRegion(tab, region, scrollTop) {
    const results = await withTimeout(
      this.chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [region.marker, Math.max(0, Math.round(scrollTop)), NESTED_SCROLL_SETTLE_MS],
        func: async (marker, requestedTop, settleMs) => {
          const element = document.querySelector(`[data-tab-sleep-capture-region="${CSS.escape(marker)}"]`);
          if (!element) return null;
          element.scrollTop = requestedTop;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await new Promise((resolve) => setTimeout(resolve, settleMs));
          return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight };
        }
      }),
      FULL_PAGE_ATTACH_TIMEOUT_MS,
      "nested scroll capture"
    );
    return results?.[0]?.result ?? null;
  }

  async captureNestedRegions(target, tab, regions) {
    const captured = [];
    let totalTiles = 0;
    for (const region of regions) {
      const tiles = [];
      let requestedTop = 0;
      let stableHeight = region.scrollHeight;
      const seenPositions = new Set();
      while (true) {
        const state = await this.scrollNestedRegion(tab, region, requestedTop);
        if (!state || !Number.isFinite(state.scrollTop)) throw new Error(`nested scroll region ${region.index} disappeared during capture`);
        const positionKey = Math.round(state.scrollTop);
        if (seenPositions.has(positionKey)) break;
        seenPositions.add(positionKey);
        totalTiles++;
        if (totalTiles > NESTED_SCROLL_MAX_TILES) {
          throw new Error(`nested scroll capture requires more than ${NESTED_SCROLL_MAX_TILES} tiles`);
        }
        const shot = await this.send(target, "Page.captureScreenshot", screenshotParams("webp", {
          x: region.x,
          y: region.y,
          width: region.viewportWidth,
          height: region.viewportHeight,
          scale: 1
        }));
        tiles.push({
          index: tiles.length,
          y: state.scrollTop,
          height: region.viewportHeight,
          width: region.viewportWidth,
          imageDataUrl: `data:image/webp;base64,${shot.data}`
        });
        stableHeight = Math.max(stableHeight, Number(state.scrollHeight) || stableHeight);
        const maxScrollTop = Math.max(0, stableHeight - region.viewportHeight);
        if (state.scrollTop >= maxScrollTop - 1) break;
        requestedTop = Math.min(maxScrollTop, state.scrollTop + region.viewportHeight);
      }
      captured.push({ ...region, scrollHeight: stableHeight, tiles });
    }
    return captured;
  }

  async restoreNestedRegions(tab, regions) {
    await this.chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [regions],
      func: async (capturedRegions) => {
        for (const region of capturedRegions) {
          const element = document.querySelector(`[data-tab-sleep-capture-region="${CSS.escape(region.marker)}"]`);
          if (!element) continue;
          element.scrollTop = region.originalScrollTop;
          element.scrollLeft = region.originalScrollLeft;
          if (region.priorMarker === null) element.removeAttribute("data-tab-sleep-capture-region");
          else element.setAttribute("data-tab-sleep-capture-region", region.priorMarker);
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
  }

  async performCapture(tab) {
    const target = { tabId: tab.id };
    let attached = false;
    let nestedRegions = [];
    try {
      await withTimeout(this.chrome.debugger.attach(target, DEBUG_PROTOCOL_VERSION), FULL_PAGE_ATTACH_TIMEOUT_MS, "debugger attach");
      attached = true;
      const metrics = await this.send(target, "Page.getLayoutMetrics", {});
      const content = metrics.cssContentSize ?? metrics.contentSize;
      const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
      const width = Math.ceil(Number(content?.width ?? 0));
      const height = Math.ceil(Number(content?.height ?? 0));
      if (!(width > 0 && height > 0)) return { ok: false, reason: "Page.getLayoutMetrics reported no usable content size" };

      const capture = await this.captureDocument(target, width, height, viewport);
      nestedRegions = await this.discoverNestedRegions(tab);
      if (nestedRegions.length > 0) capture.nestedRegions = await this.captureNestedRegions(target, tab, nestedRegions);
      return { ok: true, capture };
    } catch (error) {
      return { ok: false, reason: message(error) };
    } finally {
      if (attached && nestedRegions.length > 0) {
        await this.restoreNestedRegions(tab, nestedRegions).catch((error) => {
          console.error(`[Tab Sleep] Failed to restore nested scroll positions in tab ${tab.id}`, error);
        });
      }
      if (attached) {
        await this.chrome.debugger.detach(target).catch((error) => {
          console.error(`[Tab Sleep] Failed to detach debugger from tab ${tab.id}`, error);
        });
      }
    }
  }
}
