import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3, "manifest_version must be 3");
assert.equal(manifest.background.type, "module", "service worker must use ES modules");
assert.deepEqual(
  manifest.permissions,
  ["alarms", "contextMenus", "debugger", "scripting", "sessions", "storage", "tabs", "unlimitedStorage", "webRequest"],
  "permanent permissions changed unexpectedly"
);
assert.deepEqual(manifest.host_permissions, ["<all_urls>"], "capture coverage must remain all URLs");

const referencedFiles = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  "preview/preview.html"
];
for (const relativePath of new Set(referencedFiles)) {
  const absolutePath = resolve(root, relativePath);
  assert(existsSync(absolutePath), `Missing manifest/runtime asset: ${relativePath}`);
  assert(statSync(absolutePath).size > 0, `Empty manifest/runtime asset: ${relativePath}`);
}

const scripts = [
  "service-worker.js",
  "lib/constants.js",
  "lib/engine.js",
  "lib/full-page-capture.js",
  "lib/policy.js",
  "lib/preview-store.js",
  "lib/rules.js",
  "lib/sessions.js",
  "options/options.js",
  "popup/popup.js",
  "preview/preview.js",
  "content/activity.js",
  "content/page-activity-bridge.js",
  "tests/fake-chrome.js",
  "tests/fake-idb.js",
  "tests/bridge.test.js",
  "tests/constants.test.js",
  "tests/policy.test.js",
  "tests/preview-store.test.js",
  "tests/engine.test.js",
  "tests/rules.test.js",
  "tests/sessions.test.js"
];
const projectFiles = [...scripts, "README.md", ".gitignore"];
for (const projectFile of projectFiles) {
  const absolutePath = resolve(root, projectFile);
  assert(existsSync(absolutePath), `Missing project file: ${projectFile}`);
  assert(statSync(absolutePath).size > 0, `Empty project file: ${projectFile}`);
}
for (const script of scripts) {
  execFileSync(process.execPath, ["--check", resolve(root, script)], { stdio: "inherit" });
}

const htmlFiles = ["options/options.html", "popup/popup.html", "preview/preview.html"];
for (const htmlFile of htmlFiles) {
  const source = readFileSync(resolve(root, htmlFile), "utf8");
  assert(!/<script(?![^>]*\bsrc=)/i.test(source), `${htmlFile} contains inline script`);
  assert(!/\son\w+=/i.test(source), `${htmlFile} contains an inline event handler`);
}

for (const relativePath of [...scripts, "manifest.json", ...htmlFiles]) {
  const source = readFileSync(resolve(root, relativePath), "utf8");
  assert(!/\beval\s*\(/i.test(source), `${relativePath} uses eval`);
  assert(!/new\s+Function\s*\(/i.test(source), `${relativePath} constructs executable strings`);
}

const serviceWorkerSource = readFileSync(resolve(root, "service-worker.js"), "utf8");
assert(serviceWorkerSource.includes("sendResponse"), "async runtime messages must reply through sendResponse");
assert(serviceWorkerSource.includes("return true"), "async runtime messages must keep the response channel open");

const engineSource = readFileSync(resolve(root, "lib/engine.js"), "utf8");
assert(engineSource.includes("captureVisibleTab"), "engine must capture a frozen preview");
assert(!engineSource.includes("tabs.discard"), "preview pages must stay loaded so selection shows the frozen visual without reloading");
assert(engineSource.includes("pendingUrl ?? tab.url"), "freeze navigation must tolerate pre-commit URLs");
assert(engineSource.includes("liveToken === frozen.token"), "stale tab updates must not delete frozen records");
assert(engineSource.includes('scripting.executeScript'), "engine must reinject activity tracking into already-open tabs and probe per-tab signals");
assert(engineSource.includes('content/activity.js'), "engine must reinject the packaged activity tracker");
assert(engineSource.includes('content/page-activity-bridge.js'), "engine must inject the main-world transport bridge");
assert(engineSource.includes("captureDomSnapshot"), "engine must fall back to an exact DOM snapshot for tabs without a bitmap capture");
assert(engineSource.includes("captureFullPage"), "engine must attempt an entire-scrollable-page capture before falling back");

const previewStoreSource = readFileSync(resolve(root, "lib/preview-store.js"), "utf8");
assert(previewStoreSource.includes("migrateLegacyToken"), "legacy previews must migrate one named token on demand");
assert(previewStoreSource.includes("storageArea.getKeys()"), "explicit legacy maintenance must enumerate keys without materializing all storage");
assert(!previewStoreSource.includes("storageArea.get(null)"), "legacy preview migration must never read the complete storage area into memory");
assert(!engineSource.includes("migratePreviewRecords"), "extension startup must never bulk-migrate legacy preview payloads");

const fullPageSource = readFileSync(resolve(root, "lib/full-page-capture.js"), "utf8");
assert(fullPageSource.includes("chrome.debugger") || fullPageSource.includes("debugger.sendCommand"), "full-page capture must use the debugger protocol");
assert(fullPageSource.includes("captureBeyondViewport"), "full-page capture must screenshot beyond the viewport");
assert(fullPageSource.includes("detach"), "full-page capture must detach the debugger in a finally block");
assert(fullPageSource.includes("clip:"), "tall pages must be captured as clipped vertical tiles");

const previewHtml = readFileSync(resolve(root, "preview/preview.html"), "utf8");
assert(previewHtml.includes('sandbox="allow-same-origin"'), "DOM snapshot iframe may expose its inert document for scroll restoration");
assert(!previewHtml.includes("allow-scripts"), "DOM snapshot iframe must never execute scripts");
const previewJs = readFileSync(resolve(root, "preview/preview.js"), "utf8");
assert(previewJs.includes("new PreviewStore()"), "preview must read image Blobs directly from same-origin IndexedDB");
assert(previewJs.includes("srcdoc"), "preview must render DOM snapshots via srcdoc");
assert(previewJs.includes("void loadWhenVisible()"), "preview must defer legacy/image loading until the frozen tab is visible");
assert(!previewJs.includes("chrome.storage.local.get"), "preview page must never bypass the bounded preview-store read path");
assert(previewJs.includes('type: "PREVIEW_READY"'), "preview must confirm the frozen visual painted");
assert(previewJs.includes('preview.addEventListener("click"'), "clicking anywhere on the frozen visual must wake the page");
assert(previewJs.includes("event.isTrusted"), "tab activation/synthetic clicks and keys must not wake the page");
assert(previewJs.includes("scrollTo(record.scrollX"), "DOM previews must restore recorded scroll position");
assert(!previewJs.includes("wakeButton"), "wake must not require a separate button");
assert(previewJs.includes("renderTiledPreview"), "preview must render tiled full-page captures");

const bridgeSource = readFileSync(resolve(root, "content/page-activity-bridge.js"), "utf8");
assert(bridgeSource.includes("ReadableStreamDefaultReader"), "streaming response consumption must be tracked");
assert(bridgeSource.includes("STREAM_PROGRESS_GRACE_MS"), "stream progress must protect long responses");
assert(bridgeSource.includes("REALTIME_BURST_THRESHOLD"), "realtime traffic must require an active message burst");

const sessionsSource = readFileSync(resolve(root, "lib/sessions.js"), "utf8");
assert(sessionsSource.includes("SESSION_HISTORY_LIMIT"), "session history must be capped");
assert(sessionsSource.includes("previewToken"), "restores must prefer still-sleeping preview tokens over live URLs");
const serviceWorkerSessions = readFileSync(resolve(root, "service-worker.js"), "utf8");
assert(serviceWorkerSessions.includes("SESSIONS_EXPORT"), "service worker must route sessions export messages");
assert(serviceWorkerSessions.includes("reconcileAfterRestart"), "sessions reconciliation must run on worker start");

const readme = readFileSync(resolve(root, "README.md"), "utf8");
assert(readme.includes("## Installation"), "README must include installation instructions");
assert(readme.includes("## Safety invariants"), "README must document safety behavior");
assert(readme.includes("## Development"), "README must document development commands");

console.log("Manifest, assets, syntax, permanent permissions, CSP, lifecycle, stream-work, preview, and documentation invariants verified.");
