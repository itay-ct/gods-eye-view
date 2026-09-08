import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerFetch, redisMeta, redisWarning, redisResetDetected, ingestAndRead, installRedisMode } from './redisMode.js';

function managerFixture() {
  const enabled = new Set();
  const listeners = new Set();
  const subscribe = listener => {listeners.add(listener); return () => listeners.delete(listener);};
  const manager = {isEffectivelyEnabled: id => enabled.has(id), subscribe,
    subscribeVisibilityRequests: subscribe, subscribeBeforeDestroy: subscribe};
  manager.setEnabled = (id, on) => {on ? enabled.add(id) : enabled.delete(id); for (const listener of listeners) listener({layerId: id});};
  installRedisMode(manager);
  return manager;
}

test('toggle warning covers connection, projector and request failures, and clears after recovery', () => {
  assert.match(redisWarning({_redisError: 'offline'}), /connection/);
  assert.match(redisWarning({_redisStats: {military: {error: 'OOM'}}}), /military: OOM/);
  assert.match(redisWarning({_redisRequestErrors: ['earthquakes: Redis entity missing']}), /Redis entity missing/);
  assert.equal(redisWarning({_redisError: null, _redisStats: {military: {error: null}}, _redisRequestErrors: []}), '');
});

test('No Redis calls the original fetch without changing source, options, or response', async () => {
  const original = globalThis.fetch;
  const response = { original: true };
  const options = { signal: new AbortController().signal };
  globalThis.fetch = async (url, init) => { assert.equal(url, '/api/opensky'); assert.equal(init, options); return response; };
  try {
    assert.equal(await layerFetch('flights')('/api/opensky', options), response);
    assert.equal(redisMeta({}, { id: 'flights' }), null);
  } finally { globalThis.fetch = original; }
});

test('Redis mode requests only the server projection and preserves cancellation', async () => {
  const previous = { fetch: globalThis.fetch, location: globalThis.location, storage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage') };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => 'yes' } });
  globalThis.location = { href: 'http://localhost:4173/', origin: 'http://localhost:4173' };
  const manager = managerFixture();
  manager.setEnabled('military', true);
  const signal = new AbortController().signal;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/redis/ingest');
    assert.equal(options.signal.aborted, signal.aborted);
    assert.deepEqual(JSON.parse(options.body), { layer: 'military', url: '/api/adsblol/mil', method: 'GET', progressive:true });
    return { ok: false, status: 503 };
  };
  try { assert.equal((await layerFetch('military')('/api/adsblol/mil', { signal })).status, 503); }
  finally {
    manager.disposePanelExtension();
    globalThis.fetch = previous.fetch;
    if (previous.location === undefined) delete globalThis.location; else globalThis.location = previous.location;
    if (previous.storage) Object.defineProperty(globalThis, 'sessionStorage', previous.storage); else delete globalThis.sessionStorage;
  }
});


test('a changed Redis generation triggers recovery, ordinary stats and first load do not', () => {
  assert.equal(redisResetDetected(null, {military: {epoch: 'a'}}), false);
  assert.equal(redisResetDetected({military: {epoch: 'a'}}, {military: {epoch: 'a', entriesAdded: 10}}), false);
  assert.equal(redisResetDetected({military: {epoch: 'a'}}, {military: {epoch: 'b'}}), true);
});

test('satellite filter refresh reuses Redis references and only reingests a missing projection', async () => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: {getItem: () => 'yes'}});
  globalThis.location = {href: 'http://localhost:4173/', origin: 'http://localhost:4173'};
  const manager = managerFixture();
  manager.setEnabled('satellites', true);
  let ingests = 0, failure = null;
  globalThis.fetch = async url => {
    if (url === '/api/redis/ingest') {
      ingests++;
      return new Response(JSON.stringify({snapshotUrl: '/api/redis/snapshot?layer=satellites&cohort=a', headers: {'content-type': 'text/plain'}}) + '\n' + JSON.stringify({done:true}) + '\n');
    }
    if (failure) {
      const error = failure; failure = null;
      return Response.json({error}, {status: 503});
    }
    return new Response('Redis TLE', {headers: {'x-gev-data-path': 'redis-json', 'x-gev-filtered': '1'}});
  };
  try {
    const read = layerFetch('satellites');
    await read('/api/celestrak/visual');
    const response = await read('/api/celestrak/visual', {redisReadOnly: true});
    assert.equal(await response.text(), 'Redis TLE');
    assert.equal(response.headers.get('x-gev-filtered'), '1', 'empty-result authority survives the adapter');
    assert.equal(ingests, 1);
    failure = 'Redis Search connection unavailable';
    assert.equal((await read('/api/celestrak/visual', {redisReadOnly: true})).status, 503);
    assert.equal(ingests, 1, 'Search errors must not create source updates');
    failure = 'Redis snapshot not found';
    assert.equal((await read('/api/celestrak/visual', {redisReadOnly: true})).status, 200);
    assert.equal(ingests, 2, 'expired/reset snapshots recover through the Stream');
  } finally {
    manager.disposePanelExtension(); globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
    if (storage) Object.defineProperty(globalThis, 'sessionStorage', storage); else delete globalThis.sessionStorage;
  }
});

test('a flush between receipt and snapshot retries the Redis path once and respects abort', async () => {
  const original = globalThis.fetch;
  let ingests = 0, reads = 0;
  const ingest = async () => {ingests++; return Response.json({snapshotUrl: '/api/redis/snapshot?layer=military&cohort=a', headers: {'content-type': 'application/json'}});};
  globalThis.fetch = async () => ++reads === 1 ? new Response('missing snapshot', {status: 503}) :
    Response.json({ac: [{hex: 'a'}]}, {headers: {'x-gev-data-path': 'redis-json'}});
  try {
    assert.deepEqual(await (await ingestAndRead(ingest)).json(), {ac: [{hex: 'a'}]});
    assert.equal(ingests, 2); assert.equal(reads, 2);
    const controller = new AbortController();
    globalThis.fetch = async () => {controller.abort(); return new Response('', {status: 503});};
    await assert.rejects(ingestAndRead(ingest, controller.signal), {name: 'AbortError'});
    assert.equal(ingests, 3);
  } finally {globalThis.fetch = original;}
});


test('OFF blocks every layer, including helper calls; OFF cancels pending requests and ON starts fresh', async () => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const originalFetch = globalThis.fetch;
  const location = globalThis.location;
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: {getItem: () => 'yes'}});
  globalThis.location = {href: 'http://localhost:4173/', origin: 'http://localhost:4173'};
  const manager = managerFixture();
  let calls = 0;
  globalThis.fetch = async () => {calls++; throw new Error('Unexpected fetch');};
  try {
    for (const layer of ['flights', 'military', 'earthquakes', 'satellites', 'rocket-launches', 'traffic', 'cctv', 'radio', 'bikeshare', 'ais-live-vessels', 'military-installations', 'local-datacenters', 'local-dams', 'telegeography-submarine-cables', 'local-firms']) {
      await assert.rejects(layerFetch(layer)('/source'), {name: 'AbortError'});
    }
    assert.equal(calls, 0);
    manager.setEnabled('military', true);
    let pendingSignal;
    globalThis.fetch = (url, {signal}) => new Promise((resolve, reject) => {
      calls++; pendingSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
    const pending = layerFetch('military')('/api/adsblol/mil');
    manager.setEnabled('military', false);
    await assert.rejects(pending, {name: 'AbortError'});
    assert.equal(pendingSignal.aborted, true);
    await assert.rejects(layerFetch('military')('/api/adsblol/mil'), {name: 'AbortError'});
    assert.equal(calls, 1);
    manager.setEnabled('military', true);
    globalThis.fetch = async (url, {signal}) => {
      calls++; assert.equal(signal.aborted, false);
      return new Response('', {status: 503});
    };
    assert.equal((await layerFetch('military')('/api/adsblol/mil')).status, 503);
    assert.equal(calls, 2);
  } finally {
    manager.disposePanelExtension(); globalThis.fetch = originalFetch;
    if (location === undefined) delete globalThis.location; else globalThis.location = location;
    if (storage) Object.defineProperty(globalThis, 'sessionStorage', storage); else delete globalThis.sessionStorage;
  }
});

test('transient health failures recover without requesting a page reload; real Redis resets still recover', async () => {
  const {updateRedisStatus} = await import('./redisMode.js');
  const manager={};
  const healthy={layers:{traffic:{epoch:'a',error:null},cctv:{epoch:'b',error:null}},errors:[]};
  assert.equal(updateRedisStatus(manager,healthy),false);
  for(let i=0;i<3;i++) {
    manager._redisError='Redis unavailable';
    assert.equal(updateRedisStatus(manager,healthy),false,'timeout recovery must not restart the globe');
    assert.equal(redisWarning(manager),'');
  }
  assert.equal(updateRedisStatus(manager,{layers:{traffic:{error:'timeout'}},errors:[]}),false);
  assert.equal(updateRedisStatus(manager,healthy),false,'a layer error must not erase its known epoch');
  assert.equal(updateRedisStatus(manager,{...healthy,layers:{...healthy.layers,traffic:{epoch:'new',error:null}}}),true);
});

test('warning retry repairs Redis and refreshes only enabled layers without reload or optimistic error clearing', async()=>{
 const {retryRedisLayers}=await import('./redisMode.js');
 const original=globalThis.fetch;const calls=[];
 const manager={getAll:()=>[{id:'traffic'},{id:'radio'}],isEffectivelyEnabled:id=>id==='traffic',
  refreshLayer:async id=>{calls.push(id);return true;},_refreshTogglePanel:()=>{}};
 globalThis.fetch=async(url,init)=>{
  if(url==='/api/redis/retry'){assert.deepEqual(JSON.parse(init.body),{layers:['traffic']});return Response.json({ready:true});}
  return Response.json({layers:{traffic:{epoch:'a',error:null}},errors:['traffic · source fetch: still unavailable']});
 };
 try{await retryRedisLayers(manager);assert.deepEqual(calls,['traffic']);assert.match(redisWarning(manager),/still unavailable/);}
 finally{globalThis.fetch=original;}
});
