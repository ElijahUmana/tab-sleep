# Tab Sleep

Tab Sleep is a private Chrome Manifest V3 extension that replaces quiet background websites with local frozen previews, releasing their live page contexts while keeping a visual you can inspect before waking the site.

## What it does

- Sleeps hidden, quiet HTTP(S) tabs after a configurable idle period.
- Keeps every tab selected in an open Chrome window awake, including tabs shown in tiled windows.
- Keeps loading, audible, protected, and actively working tabs awake.
- Tracks substantial network work and actively consumed streaming responses without relying on UI words such as “Thinking” or “Loading.”
- Ignores persistent socket plumbing, quick keep-alive polls, title changes, and cosmetic DOM churn.
- Stores frozen visuals only in the current Chrome profile.
- Shows the frozen visual immediately when a sleeping tab is selected.
- Wakes the original website only after a real click anywhere on the frozen page or keyboard activation.
- Never discards the lightweight preview page, preventing activation spinners and automatic reloads.

## Interaction model

1. A supported tab becomes hidden.
2. Tab Sleep waits for the entire configured idle interval.
3. Safety and work gates are checked again immediately before sleeping.
4. A local visual record is prepared.
5. The live site is replaced by `preview/preview.html`.
6. Selecting the tab displays the frozen visual without loading the original website.
7. A trusted click anywhere on the frozen visual (or Enter/Space) wakes the page: a durable wake transaction is recorded first, then the preview tab navigates itself to the original URL. The frozen visual stays fully on screen until the live page commits — no overlay, spinner, or blank flash beyond Chrome's own progress.
8. The frozen record is deleted only after the live page confirms it loaded. If the site fails (DNS/network error or commit timeout), the frozen visual is restored automatically with a retry affordance, preserving the original URL and screenshot.

## Safety invariants

Tab Sleep refuses to sleep a tab when any of these conditions apply:

- The tab is selected in a non-minimized Chrome window.
- The tab is loading.
- The page activity tracker is missing or stale.
- Audio or video is playing.
- Chrome reports the tab as audible.
- A substantial HTTP request is in flight.
- An actively consumed streaming response is making progress.
- The tab is protected, pinned (when configured), or marked non-discardable (when configured).
- A valid local visual cannot be prepared.

Persistent WebSockets and EventSources do not count as work by themselves. Short background requests do not restart the idle timer. A long response that is actively consumed as a stream remains protected beyond the ordinary request window.

## Frozen visuals

Tab Sleep uses two local preview paths:

### Bitmap preview

When a page was visibly selected and stable, Tab Sleep captures its viewport as a full-resolution PNG using `chrome.tabs.captureVisibleTab`. The preview decodes the PNG into a canvas before display.

### Script-free DOM fallback

Chrome cannot capture an arbitrary background tab through the Tabs API. For a never-visible tab, Tab Sleep creates a detached clone of the document, removes executable and embedded content, inserts the original base URL, and renders the result in a fully sandboxed `srcdoc` iframe.

The DOM fallback is best-effort. Canvas pixels, closed shadow roots, cross-origin frames, runtime-only form state, and some authenticated or blob-backed resources cannot be reproduced exactly.

## Installation

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository directory.
5. Pin Tab Sleep from Chrome’s Extensions menu if desired.

The installed extension ID for this checkout is currently:

```text
hhicpdhnbnakjogjbaldajnddmpidbpi
```

## Updating an unpacked installation

After changing source files:

1. Run the verification commands below.
2. Open `chrome://extensions` in each Chrome profile using the extension.
3. Click **Reload** on the Tab Sleep card.
4. Confirm the displayed version matches `manifest.json`.

Existing live pages receive fresh activity trackers after reload. Older callbacks retire automatically.

## Settings

Open **Tab Sleep → Settings** to configure:

- Automatic sleep on/off
- Idle threshold from 0.5 to 1,440 minutes
- Keep pinned tabs awake
- Keep audible tabs awake
- Respect Chrome’s non-discardable flag
- Wait for navigation to finish

The popup also lets you protect the current page and manually freeze eligible inactive tabs. Manual freeze bypasses idle age only; it never bypasses visibility, work, media, loading, or visual-validity gates.

## Sessions, history, and recovery

The Settings page has a **Sessions** section (also reachable from the popup):

- **Automatic snapshots** of every window and tab group are taken roughly every 10 minutes after tab changes. The last 20 are kept.
- **Named sessions** capture the same snapshot under a name you choose; saving again with the same name updates it in place.
- **Restore** a whole session, one window, one tab group, or a single tab. Entries whose frozen preview still exists reopen as sleeping preview pages instead of live websites; everything else reopens as a normal URL.
- **Searchable history** records saves, snapshots, and restores (capped at 500 entries).
- **Import/export** moves sessions plus settings as one JSON file. Settings sync through Chrome Sync when enabled; frozen previews never leave this machine.
- A **recovery manifest** maps every parked tab to its original URL so tabs can be recovered after an update or restart even when runtime state was lost.

## Architecture

```text
content/activity.js
  └─ trusted user input, media state, liveness heartbeat

content/page-activity-bridge.js (MAIN world)
  └─ transport liveness and streaming-consumer progress

service-worker.js
  └─ Chrome event adapters and async message transport

lib/engine.js
  ├─ serialized runtime state
  ├─ request fences
  ├─ capture and preview records
  ├─ freeze/wake transactions
  └─ worker-start reconciliation

lib/policy.js
  └─ ordered safety/work/idle eligibility gates

preview/
  ├─ canvas bitmap renderer
  ├─ sandboxed DOM fallback
  └─ click-anywhere wake surface
```

Runtime signals live in `chrome.storage.session`. Settings, metrics, preview records, and the preview index live in `chrome.storage.local`.

## Development

Requirements:

- Chrome 150 or newer
- Node.js 20 or newer

Install dependencies are not required; the project uses Node’s built-in test runner.

```bash
npm test
npm run check
```

`npm test` covers policy, engine lifecycle races, preview preservation and recovery, settings normalization, request plumbing, and long streaming-response protection.

`npm run check` validates:

- Manifest version and permissions
- Referenced assets
- JavaScript syntax
- CSP-safe HTML and scripts
- Async message-channel handling
- No preview discard calls
- Preview startup, render acknowledgment, and click-to-wake invariants

## Troubleshooting

### A tab never sleeps

Check whether it is:

- selected in an open window;
- pinned while **Keep pinned tabs awake** is enabled;
- loading, audible, or playing media;
- actively receiving/consuming a response;
- missing a fresh activity signal.

The popup reports aggregate state, and `metrics.lastScanReasons` in extension local storage records the latest policy outcomes.

### The frozen tab restores itself

A broken or missing visual is treated as a failed freeze. Tab Sleep restores the original URL rather than leaving an unusable placeholder.

### Extension context invalidated

This can appear for callbacks from an older content-script generation immediately after reloading an unpacked extension. The current generation supersedes older callbacks and re-establishes its liveness heartbeat.

### A DOM fallback looks different

The fallback is script-free and cannot exactly preserve every browser rendering primitive. Visit the page once while visible to let Tab Sleep cache a bitmap preview.

## Permissions

- `tabs`: tab metadata, navigation, and visible-tab capture
- `scripting`: tracker injection, signal probes, and detached DOM fallback capture
- `storage`: settings, runtime state, metrics, and local frozen visuals
- `sessions`: session snapshots and sleep history records
- `alarms`: periodic eligibility scans
- `webRequest`: request lifecycle fences
- `unlimitedStorage`: local preview records without the standard extension storage quota
- `<all_urls>`: supported-page tracking and capture coverage

## Privacy

Tab Sleep does not sync preview records or send them to an application server. Frozen visuals remain in the Chrome profile’s local extension storage and are deleted when their preview is cleared or woken.

## Version

Current version: **4.1.1**
