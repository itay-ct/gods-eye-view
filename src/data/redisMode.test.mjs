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
    assert.deepEqual(JSON.parse(options.body), { layer: 'military', url: '/api/adsblol/mil', method: 'GET' });
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
