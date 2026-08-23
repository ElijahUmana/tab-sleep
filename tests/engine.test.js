import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_STATE_KEY, SETTINGS_KEY, previewStorageKey } from "../lib/constants.js";
import { TabSleepEngine } from "../lib/engine.js";
import { createFakeChrome, makeTab } from "./fake-chrome.js";
function clock(start = 1_000_000) { let now = start; return { now: () => now, advance: (ms) => { now += ms; } }; }
function engine(chrome, c) { let i = 0; const e = new TabSleepEngine(chrome, c.now, () => `token-${++i}`); if (chrome.testOptions) chrome.testOptions.engineRef = { current: e }; return e; }
async function makeReady(e, chrome, c, id, { busy = false } = {}) {
  chrome.signals.set(id, { visible: true, localBusy: false, remoteBusy: false, bridgeReady: true });
  await e.handleSignal({ visible: true, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(id));
  chrome.signals.set(id, { visible: false, localBusy: busy, remoteBusy: false, bridgeReady: true });
  await e.handleSignal({ visible: false, busy, activity: false, bridgeReady: true }, await chrome.tabs.get(id));
  const state = chrome.storage.session.data[RUNTIME_STATE_KEY];
  state.signals[String(id)].lastActivityAt = state.captures[String(id)].capturedAt;
  await chrome.storage.session.set({ [RUNTIME_STATE_KEY]: state });
}
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
    local: { [SETTINGS_KEY]: { enabled: true, idleMinutes: 0.5, skipPinned: true, skipAudible: true, respectAutoDiscardable: true, skipLoading: true } }
  });
  const e = engine(chrome, c);
  await e.start();
  // Tab 1 becomes hidden+quiet with NO bitmap capture ever taken.
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(1));
  c.advance(120_000);
  await e.handleSignal({ visible: false, busy: false, activity: false, bridgeReady: true }, await chrome.tabs.get(1));
  const result = await e.scan();
  assert.deepEqual(result.frozen, [1]);
  assert.match(chrome.tabsData[0].url, /preview\/preview\.html/);
  const state = chrome.storage.session.data[RUNTIME_STATE_KEY];
  const token = state.frozenTabs["1"].token;
  const record = chrome.storage.local.data[previewStorageKey(token)];
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
  await chrome.storage.local.set({[previewStorageKey(token)]:{token,originalUrl:"https://example.com/tab-1",title:"Tab 1",imageDataUrl:"data:image/png;base64,AAAA",capturedAt:c.now(),frozenAt:c.now()}});
  const state=chrome.storage.session.data[RUNTIME_STATE_KEY];
  state.frozenTabs["1"]={token,originalUrl:"https://example.com/tab-1",status:"freezing"};
  state.captures["1"]={token,url:"https://example.com/tab-1",capturedAt:c.now(),hasImage:true};
  await chrome.storage.session.set({[RUNTIME_STATE_KEY]:state});
  await e.handleUpdated(1,{url:"https://example.com/tab-1"},await chrome.tabs.get(1));
  assert.ok(chrome.storage.local.data[previewStorageKey(token)]);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].status,"freezing");
});

test("delayed old-URL update cannot delete a sleeping preview record", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1)]); const e=engine(chrome,c); await e.start();
  const token="sleeping-race-token";
  const previewUrl=`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`;
  await chrome.storage.local.set({[previewStorageKey(token)]:{token,originalUrl:"https://example.com/tab-1",title:"Tab 1",imageDataUrl:"data:image/png;base64,AAAA",capturedAt:c.now(),frozenAt:c.now()}});
  const state=chrome.storage.session.data[RUNTIME_STATE_KEY];
  state.frozenTabs["1"]={token,originalUrl:"https://example.com/tab-1",status:"sleeping",verifiedSleeping:true};
  state.captures["1"]={token,url:"https://example.com/tab-1",capturedAt:c.now(),hasImage:true};
  await chrome.storage.session.set({[RUNTIME_STATE_KEY]:state});
  await chrome.tabs.update(1,{url:previewUrl});
  await e.handleUpdated(1,{url:"https://example.com/tab-1"},{...(await chrome.tabs.get(1)),url:"https://example.com/tab-1",pendingUrl:previewUrl});
  assert.ok(chrome.storage.local.data[previewStorageKey(token)]);
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
  await chrome.storage.local.set({[previewStorageKey(token)]:{token,originalUrl:"https://example.com/tab-1",title:"Tab 1",html:"<html><body>frozen</body></html>",capturedAt:c.now(),frozenAt:c.now()}});
  const tab=await chrome.tabs.get(1);
  await e.handleUpdated(1,{url:`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`},{...tab,pendingUrl:`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`});
  assert.ok(chrome.storage.local.data[previewStorageKey(token)]);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].token,token);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].status,"freezing");
  await chrome.tabs.update(1,{url:`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`});
  await e.handlePreviewReady({token,kind:"test"},await chrome.tabs.get(1));
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"].status,"sleeping");
});

test("preview render failure restores the original page", async () => {
  const c=clock(), chrome=createFakeChrome([makeTab(1)]); const e=engine(chrome,c); await e.start();
  const token="failed-render-token";
  await chrome.storage.local.set({[previewStorageKey(token)]:{token,originalUrl:"https://example.com/tab-1",title:"Tab 1",html:"<html><body>broken render</body></html>",capturedAt:c.now(),frozenAt:c.now()}});
  const previewUrl=`chrome-extension://tab-sleep-test/preview/preview.html?token=${token}`;
  await chrome.tabs.update(1,{url:previewUrl});
  await e.restorePreview(await chrome.tabs.get(1),token);
  const result=await e.handlePreviewFailed({token,error:"missing visual"},await chrome.tabs.get(1));
  assert.equal(result.recovered,true);
  assert.equal(chrome.tabsData[0].url,"https://example.com/tab-1");
  assert.equal(chrome.storage.local.data[previewStorageKey(token)],undefined);
  assert.equal(chrome.storage.session.data[RUNTIME_STATE_KEY].frozenTabs["1"],undefined);
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
