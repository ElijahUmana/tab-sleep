import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_STATE_KEY, SETTINGS_KEY, previewStorageKey } from "../lib/constants.js";
import { TabSleepEngine } from "../lib/engine.js";
import { PreviewStore } from "../lib/preview-store.js";
import { createFakeChrome, makeTab } from "./fake-chrome.js";
import { FakeIndexedDbFactory } from "./fake-idb.js";
function clock(start = 1_000_000) { let now = start; return { now: () => now, advance: (ms) => { now += ms; } }; }
function engine(chrome, c) {
  let i = 0;
  const indexedDb = new FakeIndexedDbFactory();
  const previewStore = new PreviewStore({ indexedDb });
  const e = new TabSleepEngine(chrome, c.now, () => `token-${++i}`, {
    previewStore,
    failedWakeGraceMs: chrome.testOptions?.failedWakeGraceMs
  });
  if (chrome.testOptions) chrome.testOptions.engineRef = { current: e };
  e.previewStore = previewStore;
  return e;
}
// Seed a frozen record through the store the way the engine writes them.
// A bitmap seed uses the fake capture's exact bytes so dedup checks hold.
async function seedPreview(store, token, { html = null, capturedAt = 1_000_000 } = {}) {
  await store.savePreview(html === null
    ? { token, originalUrl: "https://example.com/tab-1", title: "Tab 1", capturedAt, frozenAt: capturedAt, images: [{ bytes: new Uint8Array([65, 66, 67, 68]), mime: "image/png", kind: "viewport" }] }
    : { token, originalUrl: "https://example.com/tab-1", title: "Tab 1", html, capturedAt, frozenAt: capturedAt });
}
function storeDb(e) {
  return e.previewStore.indexedDb.databases.get("tab-sleep-previews");
}
async function makeReady(e, chrome, c, id, { busy = false } = {}) {
  chrome.signals.set(id, { visible: true, localBusy: false, remoteBusy: false, bridgeReady: true });
  await e.handleSignal({ visible: true, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(id));
  chrome.signals.set(id, { visible: false, localBusy: busy, remoteBusy: false, bridgeReady: true });
  await e.handleSignal({ visible: false, busy, activity: false, bridgeReady: true }, await chrome.tabs.get(id));
  const state = chrome.storage.session.data[RUNTIME_STATE_KEY];
  state.signals[String(id)].lastActivityAt = state.captures[String(id)].capturedAt;
  await chrome.storage.session.set({ [RUNTIME_STATE_KEY]: state });
}
test("engine startup never enumerates or decodes legacy preview payloads", async () => {
  const c = clock();
  const chrome = createFakeChrome([makeTab(1, { active: true })], {
    signals: { 1: { visible: true } },
    local: {
      "preview:large-legacy": {
        token: "large-legacy",
        originalUrl: "https://example.com/legacy",
        title: "Large legacy",
        imageDataUrl: "data:image/png;base64,AAAA"
      }
    }
  });
  let getKeysCalls = 0;
  let legacyReads = 0;
  const originalGetKeys = chrome.storage.local.getKeys;
  const originalGet = chrome.storage.local.get;
  chrome.storage.local.getKeys = async () => { getKeysCalls++; return originalGetKeys(); };
  chrome.storage.local.get = async (keys) => {
    if (keys === "preview:large-legacy" || keys === null) legacyReads++;
    return originalGet(keys);
  };
  const previewStore = new PreviewStore({ indexedDb: new FakeIndexedDbFactory(), legacyStorageArea: chrome.storage.local });
  const e = new TabSleepEngine(chrome, c.now, () => "token-startup", { previewStore });
  if (chrome.testOptions) chrome.testOptions.engineRef = { current: e };

  await e.start();

  assert.equal(getKeysCalls, 0, "startup must not enumerate legacy preview keys");
  assert.equal(legacyReads, 0, "startup must not materialize legacy preview payloads");
});

test("three tiled visible active tabs never freeze", async () => {
  const c = clock(), chrome = createFakeChrome([makeTab(1,{active:true,windowId:1}),makeTab(2,{active:true,windowId:2}),makeTab(3,{active:true,windowId:3})], { signals: { 1:{visible:true},2:{visible:true},3:{visible:true} } });
  const e=engine(chrome,c); await e.start(); c.advance(600_000); const result=await e.scan(); assert.deepEqual(result.frozen,[]);
});
test("hidden tab with real in-flight request never freezes", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1,{active:true}),makeTab(2)], { signals:{1:{visible:true},2:{visible:false}} }); const e=engine(chrome,c); await e.start();
  e.handleRequestStarted({tabId:2,requestId:"r"}); c.advance(10_000); await new Promise((r)=>setTimeout(r,0)); const result=await e.scan(); assert.deepEqual(result.frozen,[]);
});
test("keep-alive polls and stale hanging requests do not pin a tab awake", async () => {
  // A quick poll that already finished (Gmail keep-alive) must not block sleep.
  // A HANGING request is still in flight — but webRequest-level in-flight
  // tracking is a background-side approximation; the page's own bridge (which
  // sees real fetch/XHR lifecycles) reports busy via heartbeats. A hung
  // webRequest record older than an hour is treated as leaked, not as work.
  const c=clock(), chrome=createFakeChrome([makeTab(1),makeTab(2)], {
    signals:{
      1:{visible:false,localBusy:false,remoteBusy:false,bridgeReady:true},
      2:{visible:false,localBusy:false,remoteBusy:false,bridgeReady:true}
    },
    local:{[SETTINGS_KEY]:{enabled:true,idleMinutes:0.5,skipPinned:true,skipAudible:true,respectAutoDiscardable:true,skipLoading:true}}
  });
  const e=engine(chrome,c); await e.start();
  // Quiet heartbeats every 2s keep signals fresh exactly like the live tracker,
  // on BOTH tabs (real pages heartbeat independently).
  for (let t=0; t<=181_000; t+=2_000) {
    c.advance(2_000);
    await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(1));
    await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
    if (t === 0) { e.handleRequestStarted({tabId:1,requestId:"poll"}); }
    if (t === 2_000) { e.handleRequestFinished({requestId:"poll"}); }
    if (t === 0) { e.handleRequestStarted({tabId:2,requestId:"hung"}); }
    await new Promise((r)=>setTimeout(r,0));
  }
  // Tab 2's request never finished; after 30s it is stale plumbing.
  const state = chrome.storage.session.data[RUNTIME_STATE_KEY];
  state.requestStartedAt["hung"] = state.requestStartedAt["hung"] - 30_001;
  await chrome.storage.session.set({ [RUNTIME_STATE_KEY]: state });
  const result=await e.scan();
  assert.deepEqual(result.frozen.sort(), [1, 2]);
});
test("hidden streaming transport keeps tab awake until work ends plus full idle", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1,{active:true,windowId:1}),makeTab(2,{active:true,windowId:2})], { signals:{1:{visible:true},2:{visible:false,remoteBusy:true}} }); const e=engine(chrome,c); await e.start();
  c.advance(600_000); assert.deepEqual((await e.scan()).frozen,[]);
  chrome.signals.get(2).remoteBusy=false; await e.handleSignal({visible:false,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(2)); c.advance(120_000); assert.deepEqual((await e.scan()).frozen,[]); // snapshot invalidated/missing => fail safe
});
test("quiet heartbeat refreshes proof without resetting 30-second idle age", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1,{active:true}),makeTab(2)],{local:{[SETTINGS_KEY]:{enabled:true,idleMinutes:0.5,skipPinned:true,skipAudible:true,respectAutoDiscardable:true,skipLoading:true}}}); const e=engine(chrome,c); await e.start();
  await makeReady(e,chrome,c,1); chrome.tabsData[0].active=false; chrome.tabsData[1].active=true; chrome.signals.set(2,{visible:true,localBusy:false,remoteBusy:false,bridgeReady:true});
  for (let elapsed=2_000; elapsed<=32_000; elapsed+=2_000) { c.advance(2_000); await e.handleSignal({visible:false,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(1)); }
  const state=chrome.storage.session.data[RUNTIME_STATE_KEY]; assert.equal(state.inactiveSince["1"],1_000_000); assert.equal(state.signals["1"].at,1_032_000);
  const didFreeze=await e.freeze(await chrome.tabs.get(1),await e.settings(),false); assert.equal(didFreeze,true);
});
test("hidden quiet tab freezes only with a current real snapshot", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1,{active:true}),makeTab(2)]); const e=engine(chrome,c); await e.start();
  await makeReady(e,chrome,c,1); chrome.tabsData[0].active=false; chrome.tabsData[1].active=true; chrome.signals.set(2,{visible:true,localBusy:false,remoteBusy:false,bridgeReady:true}); c.advance(120_000); await e.handleSignal({visible:false,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(1));
  const result=await e.freeze(await chrome.tabs.get(1),await e.settings(),false); assert.equal(result,true); assert.match(chrome.tabsData[0].url,/preview\/preview\.html/); assert.equal(chrome.tabsData[0].discarded,false); assert.deepEqual(chrome.calls.discarded,[]);
});
test("hidden quiet tab without bitmap screenshot freezes via exact DOM snapshot", async () => {
  const c = clock(), chrome = createFakeChrome([makeTab(1), makeTab(2, { active: true })], {
    signals: {
      1: { visible: false, localBusy: false, remoteBusy: false, bridgeReady: true, domSnapshot: true },
      2: { visible: true, localBusy: false, remoteBusy: false, bridgeReady: true }
    },
    local: { [SETTINGS_KEY]: { enabled: true, idleMinutes: 0.5, skipPinned: true, skipAudible: true, respectAutoDiscardable: true, skipLoading: true } },
    debuggerAttachFails: true
  });
  const e = engine(chrome, c);
  await e.start();
  // Tab 1 becomes hidden+quiet with NO bitmap capture ever taken and the
  // debugger unavailable, so the fallback chain lands on the DOM snapshot.
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(1));
  c.advance(120_000);
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(1));
  const result = await e.scan();
  assert.deepEqual(result.frozen, [1]);
  assert.match(chrome.tabsData[0].url, /preview\/preview\.html/);
  const state = chrome.storage.session.data[RUNTIME_STATE_KEY];
  const token = state.frozenTabs["1"].token;
  const record = await e.previewStore.getMetadata(token);
  assert.ok(record.html.includes("Tab 1"));
  assert.equal(record.originalUrl, "https://example.com/tab-1");
  const woken = await e.wake(token, await chrome.tabs.get(1));
  assert.equal(woken.url, "https://example.com/tab-1");
});
test("final freeze revalidates a minimized window becoming visible", async () => {
  const c=clock(), options={windowStates:{1:"normal",2:"minimized"},signals:{1:{visible:true},2:{visible:false,domSnapshot:true}},local:{[SETTINGS_KEY]:{enabled:true,idleMinutes:0.5,skipPinned:true,skipAudible:true,respectAutoDiscardable:true,skipLoading:true}}};
  const chrome=createFakeChrome([makeTab(1,{active:true,windowId:1}),makeTab(2,{active:true,windowId:2})],options); const e=engine(chrome,c); await e.start();
  await e.handleSignal({visible:false,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(2)); c.advance(120_000); await e.handleSignal({visible:false,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(2));
  options.windowStates[2]="normal";
  assert.equal(await e.freeze(await chrome.tabs.get(2),await e.settings(),false),false);
  assert.equal(chrome.tabsData[1].url,"https://example.com/tab-2");
});

test("selected tab of a minimized window may sleep; of open window never", async () => {
  // Two windows, each with a selected tab. Window 2 is minimized — its
  // selected tab is genuinely not visible and may sleep. Window 1 is open —
  // its selected tab must NEVER sleep, even with a dark paint signal.
  const c = clock(), chrome = createFakeChrome(
    [makeTab(1, { active: true, windowId: 1 }), makeTab(2, { active: true, windowId: 2 })],
    {
      signals: { 1: { visible: false, localBusy: false, remoteBusy: false, bridgeReady: true, domSnapshot: true }, 2: { visible: false, localBusy: false, remoteBusy: false, bridgeReady: true, domSnapshot: true } },
      windowStates: { 1: "normal", 2: "minimized" },
      local: { [SETTINGS_KEY]: { enabled: true, idleMinutes: 0.5, skipPinned: true, skipAudible: true, respectAutoDiscardable: true, skipLoading: true } }
    }
  );
  const e = engine(chrome, c);
  await e.start();
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(1));
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  c.advance(120_000);
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(1));
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  const result = await e.scan();
  // Only the minimized window's selected tab froze; the open window's selected tab stayed awake.
  assert.deepEqual(result.frozen, [2]);
});
test("missing tracker signal fails safe", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1,{active:true}),makeTab(2)], { signals:{1:{trackerReady:false,bridgeReady:false}} }); const e=engine(chrome,c); await e.start(); c.advance(600_000); assert.deepEqual((await e.scan()).frozen,[]);
});
test("visible activity invalidates old snapshot", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1,{active:true})]); const e=engine(chrome,c); await e.start(); chrome.signals.set(1,{visible:true,localBusy:false,remoteBusy:false,bridgeReady:true}); await e.handleSignal({visible:true,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(1)); const before=chrome.storage.session.data[RUNTIME_STATE_KEY].captures["1"]?.capturedAt; c.advance(1_000); chrome.signals.set(1,{visible:false,localBusy:false,remoteBusy:false,bridgeReady:true}); await e.handleSignal({visible:false,busy:false,activity:true,bridgeReady:true},await chrome.tabs.get(1)); const state=chrome.storage.session.data[RUNTIME_STATE_KEY]; assert.equal(state.captures["1"],undefined); assert.ok(before);
});
test("intermediate old-URL update cannot delete a freezing preview record", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1)]); const e=engine(chrome,c); await e.start();
  const token="freezing-race-token";
  await seedPreview(e.previewStore, token, { html: "<html><body>freezing race</body></html>", capturedAt: c.now() });
  const state=chrome.storage.session.data[RUNTIME_STATE_KEY];
  state.frozenTabs["1"]={token,originalUrl:"https://example.com/tab-1",status:"freezing"};
  state.captures["1"]={token,url:"https://example.com/tab-1",capturedAt:c.now(),hasImage:true};
  await chrome.storage.session.set({[RUNTIME_STATE_KEY]:state});
  await e.handleUpdated(1,{url:"https://example.com/tab-1"},await chrome.tabs.get(1));
  assert.ok(await e.previewStore.hasPreview(token));
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].status,"freezing");
});

test("delayed old-URL update cannot delete a sleeping preview record", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1)]); const e=engine(chrome,c); await e.start();
  const token="sleeping-race-token";
  const previewUrl=`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`;
  await seedPreview(e.previewStore, token, { html: "<html><body>sleeping race</body></html>", capturedAt: c.now() });
  const state=chrome.storage.session.data[RUNTIME_STATE_KEY];
  state.frozenTabs["1"]={token,originalUrl:"https://example.com/tab-1",status:"sleeping",verifiedSleeping:true};
  state.captures["1"]={token,url:"https://example.com/tab-1",capturedAt:c.now(),hasImage:true};
  await chrome.storage.session.set({[RUNTIME_STATE_KEY]:state});
  await chrome.tabs.update(1,{url:previewUrl});
  await e.handleUpdated(1,{url:"https://example.com/tab-1"},{...(await chrome.tabs.get(1)),url:"https://example.com/tab-1",pendingUrl:previewUrl});
  assert.ok(await e.previewStore.hasPreview(token));
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].status,"sleeping");
});

test("pending preview URL resolves token before stale committed URL", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1)]); const e=engine(chrome,c); await e.start();
  const token="pending-token", previewUrl=`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`;
  const state=chrome.storage.session.data[RUNTIME_STATE_KEY]; state.frozenTabs["1"]={token,originalUrl:"https://example.com/tab-1",status:"freezing"}; await chrome.storage.session.set({[RUNTIME_STATE_KEY]:state});
  chrome.tabsData[0].pendingUrl=previewUrl;
  const resolved=await e.resolvePreviewTab(token,{...chrome.tabsData[0],url:"https://example.com/tab-1",pendingUrl:previewUrl});
  assert.equal(resolved.id,1);
});

test("preview navigation transition preserves its snapshot record", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1)]); const e=engine(chrome,c); await e.start();
  const token="transition-token";
  await seedPreview(e.previewStore, token, { html: "<html><body>frozen</body></html>", capturedAt: c.now() });
  const tab=await chrome.tabs.get(1);
  await e.handleUpdated(1,{url:`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`},{...tab,pendingUrl:`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`});
  assert.ok(await e.previewStore.hasPreview(token));
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].token,token);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].status,"freezing");
  await chrome.tabs.update(1,{url:`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`});
  await e.handlePreviewReady({token,kind:"test"},await chrome.tabs.get(1));
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].status,"sleeping");
});

test("preview render failure stays parked and only explicit wake navigates", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1)]); const e=engine(chrome,c); await e.start();
  const token="failed-render-token";
  await seedPreview(e.previewStore, token, { html: "<html><body>broken render</body></html>", capturedAt: c.now() });
  const previewUrl=`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`;
  await chrome.tabs.update(1,{url:previewUrl});
  await e.restorePreview(await chrome.tabs.get(1),token);
  const result=await e.handlePreviewFailed({token,error:"missing visual"},await chrome.tabs.get(1));
  assert.equal(result.parked,true);
  assert.equal(chrome.tabsData[0].url,previewUrl,"render failure must never navigate on selection");
  assert.equal(await e.previewStore.hasPreview(token),true,"failed visual remains available for explicit wake/retry");
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].status,"sleeping");
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].previewError,"missing visual");
});

test("missing frozen visual remains parked on selection and wakes only explicitly", async () => {
  const c=clock(), token="missing-visual-token";
  const previewUrl=`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`;
  const chrome=createFakeChrome([makeTab(1,{active:true,url:previewUrl})],{
    local:{previewIndex:{[token]:{tabId:1,originalUrl:"https://example.com/original",title:"Original",updatedAt:c.now()}}}
  });
  const e=engine(chrome,c); await e.start();
  await e.restorePreview(await chrome.tabs.get(1),token);
  assert.equal(chrome.tabsData[0].url,previewUrl,"selecting an orphaned frozen tab must not wake it");
  assert.equal(chrome.calls.updated.filter(({changes})=>changes.url==="https://example.com/original").length,0);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].originalUrl,"https://example.com/original");
  const response=await e.beginWake(token,await chrome.tabs.get(1));
  assert.equal(response.url,"https://example.com/original","trusted wake can use indexed runtime URL without a visual blob");
  assert.equal(chrome.tabsData[0].url,previewUrl,"WAKE_BEGIN alone records intent; preview gesture owns navigation");
});

test("preview does not wake on selection; deliberate wake restores URL", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1,{active:true}),makeTab(2)]); const e=engine(chrome,c); await e.start(); await makeReady(e,chrome,c,1); chrome.tabsData[0].active=false; chrome.tabsData[1].active=true; chrome.signals.set(2,{visible:true,localBusy:false,remoteBusy:false,bridgeReady:true}); c.advance(120_000); await e.handleSignal({visible:false,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(1)); await e.freeze(await chrome.tabs.get(1),await e.settings(),false);
  const frozen=chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"]; assert.ok(frozen); const preview=await chrome.tabs.get(1); assert.match(preview.url,/preview/); assert.equal(preview.discarded,false); assert.deepEqual(chrome.calls.discarded,[]); await e.handleActivated({tabId:1}); const stillFrozen=await chrome.tabs.get(1); assert.match(stillFrozen.url,/preview/); assert.equal(chrome.calls.updated.filter((call)=>call.changes.url==="https://example.com/tab-1").length,0); const response=await e.wake(frozen.token,stillFrozen); assert.equal(response.url,"https://example.com/tab-1");
});
test("failed preview URL load rolls back instead of leaving a spinning tab", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1),makeTab(2,{active:true})],{
    previewNeverCompletes:true,
    autoPreviewReady:false,
    signals:{1:{visible:false,localBusy:false,remoteBusy:false,bridgeReady:true,domSnapshot:true},2:{visible:true,localBusy:false,remoteBusy:false,bridgeReady:true}},
    local:{[SETTINGS_KEY]:{enabled:true,idleMinutes:0.5,skipPinned:true,skipAudible:true,respectAutoDiscardable:true,skipLoading:true}}
  });
  const e=engine(chrome,c); await e.start();
  await e.handleSignal({visible:false,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(1));
  c.advance(120_000);
  await e.handleSignal({visible:false,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(1));
  await assert.rejects(()=>e.freeze(chrome.tabsData[0],chrome.storage.local.data[SETTINGS_KEY],false),/did not finish loading/);
  assert.equal(chrome.tabsData[0].url,"https://example.com/tab-1");
  assert.equal(chrome.tabsData[0].discarded,false);
  assert.deepEqual(chrome.calls.discarded,[]);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"],undefined);
});

test("disabled setting never freezes", async () => { const c=clock(),chrome=createFakeChrome([makeTab(1,{active:true})],{local:{[SETTINGS_KEY]:{enabled:false,idleMinutes:2}}});const e=engine(chrome,c);await e.start();c.advance(600_000);assert.deepEqual((await e.scan()).frozen,[]); });

test("always-open socket alone never pins a tab awake", async () => {
  // The bridge now only reports busy when a socket DELIVERED DATA recently.
  // Simulate that: remote busy during streaming, then silence. After the
  // stream ends (busy=false) plus full idle, the tab must sleep.
  const c=clock(), chrome=createFakeChrome([makeTab(1,{active:true}),makeTab(2,{active:false,windowId:2})], { signals:{1:{visible:true},2:{visible:false,remoteBusy:true}} }); const e=engine(chrome,c); await e.start();
  c.advance(600_000);
  assert.deepEqual((await e.scan()).frozen, []);
  chrome.signals.get(2).remoteBusy=false;
  await e.handleSignal({visible:false,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(2));
  c.advance(120_000);
  await e.handleSignal({visible:false,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(2));
  const result = await e.scan();
  assert.deepEqual(result.frozen, [2]);
});
test("quick finished polls do not keep recently-worked guard alive", async () => {
  // Sub-second polls completing every few seconds refreshed the 2-minute
  // "recently worked" lock forever. The lock now expires on its own: polls
  // finish, then full idle passes, then the tab sleeps.
  const c=clock(), chrome=createFakeChrome([makeTab(1,{active:true}),makeTab(2,{active:false,windowId:2})], { signals:{1:{visible:true},2:{visible:false}} }); const e=engine(chrome,c); await e.start();
  for (let i=0;i<60;i++){ e.handleRequestStarted({tabId:2,requestId:`p${i}`}); e.handleRequestFinished({requestId:`p${i}`}); }
  c.advance(600_000);
  await e.handleSignal({visible:false,busy:false,activity:false,bridgeReady:true},await chrome.tabs.get(2));
  await new Promise((r)=>setTimeout(r,0));
  const result = await e.scan();
  assert.deepEqual(result.frozen, [2]);
});

test("full-page debugger capture freezes a background tab with a whole-scrollable-page record", async () => {
  const c = clock(), chrome = createFakeChrome([makeTab(1, { active: true }), makeTab(2)], {
    signals: {
      1: { visible: true },
      2: { visible: false, localBusy: false, remoteBusy: false, bridgeReady: true }
    },
    pageLayout: { cssContentSize: { width: 1280, height: 800 }, cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } }
  });
  const e = engine(chrome, c);
  await e.start();
  // Tab 2 is hidden and quiet; its only visual can come from the debugger.
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  c.advance(120_000);
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  const result = await e.scan();
  assert.deepEqual(result.frozen, [2]);
  assert.equal(chrome.tabsData[1].discarded, false);
  const token = chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["2"].token;
  const storedRecord = await e.previewStore.getPreview(token);
  assert.ok(storedRecord.images.length > 0);
  assert.equal(storedRecord.images[0].mime, "image/png");
  const metadata = storedRecord.metadata;
  assert.equal(metadata.originalUrl, "https://example.com/tab-2");
  // The debugger attached to the sleeping tab and detached immediately.
  assert.deepEqual(chrome.calls.debuggerAttached.map((entry) => entry.tabId), [2]);
  assert.deepEqual(chrome.calls.debuggerDetached.map((entry) => entry.tabId), [2]);
});

test("very tall page is captured as vertical WebP tiles with offsets", async () => {
  const c = clock(), tileHeight = 4096;
  const chrome = createFakeChrome([makeTab(1, { active: true }), makeTab(2)], {
    signals: {
      1: { visible: true },
      2: { visible: false, localBusy: false, remoteBusy: false, bridgeReady: true }
    },
    pageLayout: { cssContentSize: { width: 1000, height: 3 * tileHeight + 512 }, cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } }
  });
  const e = engine(chrome, c);
  await e.start();
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  c.advance(120_000);
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  assert.deepEqual((await e.scan()).frozen, [2]);
  const token = chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["2"].token;
  const storedRecord = await e.previewStore.getPreview(token);
  const tiles = storedRecord.images.filter((image) => image.kind === "tile");
  assert.equal(tiles.length, 4);
  assert.deepEqual(tiles.map((tile) => tile.tileIndex), [0, 1, 2, 3]);
  assert.deepEqual(tiles.map((tile) => tile.yOffset), [0, tileHeight, 2 * tileHeight, 3 * tileHeight]);
  assert.equal(tiles[3].height, 512);
  for (const tile of tiles) assert.equal(tile.mime, "image/webp");
  // Every screenshot used the clip param; no single giant bitmap was requested.
  const shots = chrome.calls.debuggerCommands.filter((command) => command.method === "Page.captureScreenshot");
  assert.equal(shots.length, 4);
  for (const shot of shots) {
    assert.equal(shot.params.format, "webp");
    assert.equal(shot.params.clip.scale, 1);
  }
});

test("Gmail-style nested scroller is stitched and live scroll position is restored", async () => {
  const c = clock();
  const nestedRegion = {
    index: 0,
    x: 220,
    y: 140,
    viewportWidth: 960,
    viewportHeight: 500,
    scrollWidth: 960,
    scrollHeight: 1_400,
    originalScrollTop: 175
  };
  const chrome = createFakeChrome([makeTab(1, { active: true }), makeTab(2)], {
    signals: {
      1: { visible: true },
      2: { visible: false, localBusy: false, remoteBusy: false, bridgeReady: true }
    },
    pageLayout: { cssContentSize: { width: 1280, height: 800 }, cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } },
    nestedRegions: [nestedRegion]
  });
  const e = engine(chrome, c);
  await e.start();
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  c.advance(120_000);
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  const nestedResult = await e.scan();
  assert.deepEqual(nestedResult.frozen, [2], JSON.stringify(nestedResult));
  const token = chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["2"].token;
  const stored = await e.previewStore.getPreview(token);
  assert.deepEqual(stored.metadata.nestedRegions, [nestedRegion]);
  const nestedTiles = stored.images.filter((image) => image.kind === "nested");
  assert.deepEqual(nestedTiles.map((tile) => tile.yOffset), [0, 500, 900]);
  assert.equal(nestedTiles.every((tile) => tile.regionIndex === 0), true);
  const restorationCalls = chrome.calls.executed.filter((call) => Array.isArray(call.args?.[0]));
  assert.ok(restorationCalls.length > 0, "live nested scroll positions must be restored in finally");
});

test("freeze never reuses a cached visible viewport as the sleeping visual", async () => {
  const c = clock();
  const chrome = createFakeChrome([makeTab(1, { active: true }), makeTab(2)], {
    signals: { 1: { visible: true }, 2: { visible: false, localBusy: false, remoteBusy: false, bridgeReady: true } },
    pageLayout: { cssContentSize: { width: 1280, height: 7_000 }, cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } }
  });
  const e = engine(chrome, c);
  await e.start();
  const staleToken = "viewport-only";
  await e.previewStore.savePreview({ token: staleToken, tabId: 2, originalUrl: "https://example.com/tab-2", capturedAt: c.now(), images: [{ bytes: new Uint8Array([65, 66, 67]), mime: "image/png", kind: "viewport" }] });
  const state = chrome.storage.session.data[RUNTIME_STATE_KEY];
  state.captures["2"] = { token: staleToken, url: "https://example.com/tab-2", capturedAt: c.now(), hasImage: true };
  await chrome.storage.session.set({ [RUNTIME_STATE_KEY]: state });
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  c.advance(120_000);
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  const freshResult = await e.scan();
  assert.deepEqual(freshResult.frozen, [2], JSON.stringify(freshResult));
  const frozenToken = chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["2"].token;
  assert.notEqual(frozenToken, staleToken);
  const record = await e.previewStore.getPreview(frozenToken);
  assert.ok(record.images.length > 1, "sleeping visual must contain the newly captured full-page tiles");
});

test("debugger-blocked page falls back and still freezes without scrolling or focusing", async () => {
  const c = clock(), chrome = createFakeChrome([makeTab(1, { active: true }), makeTab(2)], {
    signals: {
      1: { visible: true },
      2: { visible: false, localBusy: false, remoteBusy: false, bridgeReady: true, domSnapshot: true }
    },
    debuggerAttachFails: true
  });
  const e = engine(chrome, c);
  await e.start();
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  c.advance(120_000);
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  const result = await e.scan();
  assert.deepEqual(result.frozen, [2]);
  assert.equal(chrome.calls.debuggerDetached.length, 0);
  const token = chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["2"].token;
  const record = await e.previewStore.getMetadata(token);
  assert.ok(typeof record.html === "string" && record.html.includes("Tab 2"));
  const woken = await e.wake(token, await chrome.tabs.get(2));
  assert.equal(woken.url, "https://example.com/tab-2");
});

test("huge page refuses tiled capture cleanly and still freezes via DOM fallback", async () => {
  const c = clock(), chrome = createFakeChrome([makeTab(1, { active: true }), makeTab(2)], {
    signals: {
      1: { visible: true },
      2: { visible: false, localBusy: false, remoteBusy: false, bridgeReady: true, domSnapshot: true }
    },
    pageLayout: { cssContentSize: { width: 1280, height: 265 * 4096 + 1 }, cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } }
  });
  const e = engine(chrome, c);
  await e.start();
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  c.advance(120_000);
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(2));
  // 265+ tiles exceeds FULL_PAGE_MAX_TILES=64: capture refuses without taking
  // screenshots, and the DOM fallback still produces a valid freeze.
  const result = await e.scan();
  assert.deepEqual(result.frozen, [2]);
  const commands = chrome.calls.debuggerCommands.filter((command) => command.method === "Page.captureScreenshot");
  assert.equal(commands.length, 0);
  assert.deepEqual(chrome.calls.debuggerDetached.map((entry) => entry.tabId), [2]);
  const token = chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["2"].token;
  const record = await e.previewStore.getMetadata(token);
  assert.ok(typeof record.html === "string" && record.html.includes("Tab 2"));
});

test("wake records durable intent first and deletes the record only after commit", async () => {
  const c = clock(), chrome = createFakeChrome([makeTab(1)]);
  const e = engine(chrome, c);
  await e.start();
  const token = "wake-commit-token", previewUrl = `chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`;
  await seedPreview(e.previewStore, token, { capturedAt: c.now() });
  const state = chrome.storage.session.data[RUNTIME_STATE_KEY];
  state.frozenTabs["1"] = { token, originalUrl: "https://example.com/tab-1", status: "sleeping", verifiedSleeping: true };
  await chrome.storage.session.set({ [RUNTIME_STATE_KEY]: state });
  await chrome.tabs.update(1, { url: previewUrl });
  const response = await e.beginWake(token, await chrome.tabs.get(1));
  assert.equal(response.url, "https://example.com/tab-1");
  assert.equal(response.tabId, 1);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].status, "waking");
  assert.equal(chrome.storage.local.data.wakeTransactions["1"].token, token);
  assert.ok(await e.previewStore.hasPreview(token), "record must survive until the live page commits");
  // The preview navigates itself (location.replace); Chrome commits the URL.
  await chrome.tabs.update(1, { url: "https://example.com/tab-1" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await e.previewStore.hasPreview(token), false);
  assert.equal(chrome.storage.local.data.wakeTransactions["1"], undefined);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"], undefined);
  assert.equal(chrome.storage.local.data.metrics.totalWoken, 1);
});

test("failed wake restores the frozen preview with retry and keeps the record", async () => {
  const c = clock(), chrome = createFakeChrome([makeTab(1)], { urlsThatNeverComplete: ["https://example.com/tab-1"], failedWakeGraceMs: 100 });
  const e = engine(chrome, c);
  await e.start();
  const token = "wake-fail-token", previewUrl = `chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`;
  await seedPreview(e.previewStore, token, { capturedAt: c.now() });
  const state = chrome.storage.session.data[RUNTIME_STATE_KEY];
  state.frozenTabs["1"] = { token, originalUrl: "https://example.com/tab-1", status: "sleeping", verifiedSleeping: true };
  await chrome.storage.session.set({ [RUNTIME_STATE_KEY]: state });
  await chrome.tabs.update(1, { url: previewUrl });
  await e.beginWake(token, await chrome.tabs.get(1));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(await e.previewStore.hasPreview(token), "a failed wake must keep the recoverable record");
  assert.match(chrome.tabsData[0].url, /retry=1/);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].status, "sleeping");
  assert.equal(chrome.storage.local.data.wakeTransactions["1"], undefined);
});

test("interrupted wake reconciles from the durable transaction after restart", async () => {
  const c = clock(), chrome = createFakeChrome([makeTab(1)]);
  const e = engine(chrome, c);
  await e.start();
  const token = "wake-restart-token";
  await seedPreview(e.previewStore, token, { capturedAt: c.now() });
  await chrome.storage.local.set({
    wakeTransactions: { "1": { token, tabId: 1, originalUrl: "https://example.com/tab-1", startedAt: c.now() } }
  });
  // The worker died after Chrome committed the live document.
  await chrome.tabs.update(1, { url: "https://example.com/tab-1" });
  await e.reconcileWakeTransactions();
  assert.equal(await e.previewStore.hasPreview(token), false);
  assert.equal(chrome.storage.local.data.wakeTransactions["1"], undefined);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"], undefined);
  assert.equal(chrome.storage.local.data.metrics.totalWoken, 1);
});

test("reconcile keeps an intact frozen record when the live page never committed", async () => {
  const c = clock(), chrome = createFakeChrome([makeTab(1)]);
  const e = engine(chrome, c);
  await e.start();
  const token = "wake-orphan-token";
  await seedPreview(e.previewStore, token, { capturedAt: c.now() });
  await chrome.storage.local.set({
    wakeTransactions: { "1": { token, tabId: 1, originalUrl: "https://example.com/tab-1", startedAt: c.now() } }
  });
  // The worker died mid-restore; the tab is back on the frozen visual.
  await chrome.tabs.update(1, { url: `${e.previewUrlPrefix}?token=${token}&retry=1` });
  await e.reconcileWakeTransactions();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(await e.previewStore.hasPreview(token), "record must survive when the site never loaded");
  assert.equal(chrome.storage.local.data.wakeTransactions["1"], undefined);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].status, "sleeping");
});
