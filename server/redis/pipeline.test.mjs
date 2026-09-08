import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { packBody, unpackBody, entityDocument } from './payload.js';
import { RedisPipeline, GROUP } from './pipeline.js';
import { sourceUrl } from './plugin.js';

test('Flights and Live AIS retain 100K entries through startup and projection', {timeout: 60000}, async () => {
  const prefix = `gev-retention-test:${randomUUID()}`;
  const pipeline = new RedisPipeline({prefix});
  const client = await pipeline.connect();
  const cleanup = client.duplicate(); cleanup.on('error', () => {}); await cleanup.connect();
  try {
    for (const layer of ['flights', 'ais-live-vessels']) {
      const stream = `${prefix}:${layer}:stream`;
      // Old acknowledged history must survive both startup and new commits.
      for (let offset = 0; offset < 100005; offset += 1000) {
        const tx = client.multi();
        for (let i = offset; i < Math.min(offset + 1000, 100005); i++) tx.addCommand(['XADD', stream, '*', 'history', String(i)]);
        await tx.execAsPipeline();
      }
      const {state} = await pipeline.ensure(layer);
      assert.equal(state.maxlen, 100000);
      assert.equal(await client.xLen(stream), 100000, 'startup uses the layer retention');
      await pipeline.project(layer, 'one', packBody(Buffer.from(JSON.stringify({rows:[{id:'one', lat:1, lon:2}]})), 'application/json'));
      assert.equal(await client.xLen(stream), 100000, 'intake and consumer commits keep the larger history');
    }
    assert.equal((await pipeline.ensure('military')).state.maxlen, 10000);
  } finally {
    await pipeline.close();
    for (const layer of ['flights', 'ais-live-vessels', 'military']) {
      await cleanup.sendCommand(['FT.DROPINDEX', `${prefix}:${layer}:idx`]).catch(() => {});
    }
    const keys = await cleanup.keys(`${prefix}:*`);
    if (keys.length) await cleanup.unlink(keys);
    await cleanup.close();
  }
});

test('10K retention preserves a larger snapshot and its lifetime Stream count', {timeout: 60000}, async () => {
  const prefix = `gev-test:${randomUUID()}`;
  const pipeline = new RedisPipeline({prefix});
  try {
    assert.equal(pipeline.maxlen, 10000);
    const rows = Array.from({length: 12500}, (_, id) => ({id: String(id), lat: 1, lon: 2}));
    const result = JSON.parse(await pipeline.project('test', 'large', packBody(Buffer.from(JSON.stringify({rows})), 'application/json')));
    assert.deepEqual(result.rows, rows);
    const stats = (await pipeline.stats()).test;
    assert.equal(stats.entriesAdded, 12501);
    assert.ok(stats.length <= 10000);
    assert.equal(stats.pending, 0);
    const client = await pipeline.connect();
    // Another group's unread entries cannot be trimmed, even to meet MAXLEN.
    await client.sendCommand(['XGROUP','CREATE',`${prefix}:test:stream`,'slow-auditor','0']);
    await pipeline.project('test','extra',packBody(Buffer.from(JSON.stringify({rows:[{id:'extra'}]})), 'application/json'));
    const protectedStats = (await pipeline.stats()).test;
    assert.ok(protectedStats.length > 10000);
  } finally {
    const client = await pipeline.connect();
    const keys = await client.keys(`${prefix}:*`);
    // Stop the blocking worker before deleting its keys.
    const cleanup = client.duplicate(); cleanup.on('error',()=>{}); await cleanup.connect();
    await pipeline.close();
    if (keys.length) await cleanup.unlink(keys);
    await cleanup.close();
  }
});

test('provider envelopes, entity ordering, duplicate IDs, and binary/TLE formats round-trip', () => {
  const payloads = [
    { states: [['abc123', 'ABC', 1, 2, 3, 4]], time: 200 },
    { ac: [{ hex: 'abc123', lat: 32 }], now: 200 },
    { rows: [{ mmsi: 12345, lon: 34 }], status: 'live' },
    { features: [{ id: 'a', geometry: { coordinates: [[1, 2], [3, 4]] } }, { id: 'a', properties: { name: 'duplicate' } }] },
    { data: { stations: [{ station_id: '1', num_bikes_available: 5 }] }, last_updated: 100 },
    { stations: [{ stationuuid: 'a' }], acceptedGeneration: 2 },
    { sources: [{ id: 'camera' }], results: [{ id: 'launch' }], fires: [{ id: 'fire' }] },
    { elements: [{ type: 'way', id: 123, geometry: [{ lat: 1, lon: 2 }] }] },
    [], { status: 'no-key' },
  ];
  for (const payload of payloads) {
    const packed = packBody(Buffer.from(JSON.stringify(payload)), 'application/json');
    const fields = Object.fromEntries(packed.records.map(r => [r.id, r.data]));
    assert.deepEqual(JSON.parse(unpackBody(packed.manifest, fields)), payload);
  }
  const tle = 'ISS\r\n1 25544U 98067A   26250.5\r\n2 25544  51.6400\r\n';
  for (const [buffer, type, url] of [[Buffer.from(tle), 'text/plain', '/api/celestrak/stations'], [Buffer.from([0, 255, 128, 13]), 'application/octet-stream', '/api/tomtom/flow/1/2/3.pbf']]) {
    const packed = packBody(buffer, type, url);
    assert.deepEqual(unpackBody(packed.manifest, Object.fromEntries(packed.records.map(r => [r.id, r.data]))), buffer);
  }
});

test('source routing cannot reach arbitrary hosts, credential files, or control APIs', () => {
  const base = 'http://127.0.0.1:4173';
  assert.equal(sourceUrl('military', '/api/adsblol/mil', base), `${base}/api/adsblol/mil`);
  for (const url of ['http://example.com/api/adsblol/mil', '//169.254.169.254/latest/meta-data', '/.env', '/api/setup/keys', '/api/redis/status']) {
    assert.throws(() => sourceUrl('military', url, base));
  }
});

test('real Streams → group → entity JSON: per-update counting, deletion, empty snapshots, pending recovery', { timeout: 60000 }, async () => {
  const prefix = `gev-test:${randomUUID()}`;
  const client = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
  client.on('error', () => {});
  await client.connect();
  let pipeline = new RedisPipeline({ prefix });
  const index = `${prefix}:search`;
  const pack = rows => packBody(Buffer.from(JSON.stringify({ rows })), 'application/json');
  const project = rows => pipeline.project('test', 'cohort', pack(rows));
  try {
    const first = [{ id: 'a', lat: 1 }, { id: 'b', lat: 2 }];
    assert.deepEqual(JSON.parse(await project(first)), { rows: first });
    const metadata = JSON.parse(await client.sendCommand(['JSON.GET', `${prefix}:test:snapshot:cohort`]));
    assert.equal(metadata.count, 2);
    assert.deepEqual(metadata.groups, [{path: ['rows'], count: 2}]);
    assert.equal(metadata.items, undefined);
    assert.equal(await client.type(`${prefix}:test:snapshot:cohort:members`), 'list');
    assert.deepEqual(await client.lRange(`${prefix}:test:snapshot:cohort:members`, 0, -1),
      [`${prefix}:test:entity:rows:a`, `${prefix}:test:entity:rows:b`]);
    assert.deepEqual(await client.keys(`${prefix}:test:*:owners`), []);
    // The same entity belongs to two snapshots without separate owner keys.
    await pipeline.project('test', 'overlap', pack([{id: 'b', lat: 2}]));
    assert.deepEqual(JSON.parse(await client.sendCommand(['JSON.GET', `${prefix}:test:entity:rows:b`, '.collections'])), ['cohort', 'overlap']);
    await client.sendCommand(['FT.CREATE', index, 'ON', 'JSON', 'PREFIX', '1', `${prefix}:test:entity:`,
      'SCHEMA', '$.id', 'AS', 'id', 'TAG', '$.latitude', 'AS', 'latitude', 'NUMERIC', '$.source.lat', 'AS', 'sourceLat', 'NUMERIC']);
    let found;
    for (let attempt = 0; attempt < 100; attempt++) {
      found = await client.sendCommand(['FT.SEARCH', index, '@latitude:[1 1]', 'NOCONTENT']);
      if (found[0] === 1) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(found[0], 1, 'Search indexes named numeric fields on individual JSON entities');
    await project(first);
    assert.deepEqual(await client.sendCommand(['CMS.QUERY', `${prefix}:test:frequency`, 'a', 'b']), [2, 3]);
    const beforeQuery = (await pipeline.stats()).test.entriesAdded;
    assert.deepEqual(await pipeline.updateCount('test', 'a'), {layer: 'test', id: 'a', count: 2, approximate: true});
    assert.equal((await pipeline.stats()).test.entriesAdded, beforeQuery, 'CMS lookup is read-only');
    assert.deepEqual(JSON.parse(await project([{ id: 'a', lat: 3 }])), { rows: [{ id: 'a', lat: 3 }] });
    assert.deepEqual(await client.sendCommand(['CMS.QUERY', `${prefix}:test:frequency`, 'a', 'b']), [3, 3]);
    assert.equal(await client.exists(`${prefix}:test:entity:rows:b`), 1, 'other snapshot still references b');
    assert.deepEqual(JSON.parse(await pipeline.snapshot('test', 'overlap')), {rows: [{id: 'b', lat: 2}]});
    await pipeline.project('test', 'overlap', pack([]));
    assert.equal(await client.exists(`${prefix}:test:entity:rows:b`), 0);
    const entity = JSON.parse(await client.sendCommand(['JSON.GET', `${prefix}:test:entity:rows:a`]));
    assert.equal(entity.source.lat, 3);
    assert.equal(entity.latitude, 3);
    assert.equal(await client.type(`${prefix}:test:entity:rows:a`), 'ReJSON-RL');
    // A Redis edit must be returned by a read-only snapshot without any new ingestion.
    const before = (await pipeline.stats()).test.entriesAdded;
    await client.sendCommand(['JSON.SET', `${prefix}:test:entity:rows:a`, '$.source.lat', '42']);
    assert.equal(JSON.parse(await pipeline.snapshot('test', 'cohort')).rows[0].lat, 42);
    assert.equal((await pipeline.stats()).test.entriesAdded, before);
    const info = await client.sendCommand(['XINFO', 'STREAM', `${prefix}:test:stream`]);
    const native = Object.fromEntries(Array.from({length: info.length / 2}, (_, i) => [info[i*2], info[i*2+1]]));
    const stats = (await pipeline.stats()).test;
    assert.equal(stats.entriesAdded, native['entries-added']);
    assert.equal(stats.lastGeneratedId, native['last-generated-id']);
    assert.equal(stats.lastIngestedAt, Number(native['last-generated-id'].split('-')[0]));
    await client.xTrim(`${prefix}:test:stream`, 'MAXLEN', 0);
    assert.equal((await pipeline.stats()).test.entriesAdded, before, 'lifetime count survives trimming');
    await client.del(`${prefix}:test:entity:rows:a`);
    await assert.rejects(pipeline.snapshot('test', 'cohort'), /Redis entity missing/);
    assert.deepEqual(JSON.parse(await project([])), { rows: [] });
    assert.equal((await pipeline.stats()).test.pending, 0);

    // Simulate a worker that received a complete generation but died before projection.
    await pipeline.close();
    await client.sendCommand(['FT.DROPINDEX', index]).catch(() => {});
    const token = randomUUID();
    const packed = pack([{ id: 'recovered', lat: 4 }]);
    const common = { cohort: 'cohort', token };
    const stream = `${prefix}:test:stream`;
    for (const record of packed.records) await client.xAdd(stream, '*', { kind: 'record', ...common, id: record.id, document: JSON.stringify(entityDocument('test','cohort',record)) });
    const manifest = { ...packed.manifest, token, items: packed.records.map(({ id, item, entityKey }) => ({ id, item, key: `${prefix}:test:entity:${entityKey}` })) };
    const commitId = await client.xAdd(stream, '*', { kind: 'commit', ...common, manifest: JSON.stringify(manifest), at: String(Date.now()) });
    await client.xReadGroup(GROUP, 'local-view', [{ key: stream, id: '>' }]);
    pipeline = new RedisPipeline({ prefix });
    await pipeline.ensure('test');
    const deadline = Date.now() + 10000;
    while ((await client.xPending(stream, GROUP)).pending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await client.xPending(stream, GROUP)).pending, 0);
    assert.deepEqual(await client.sendCommand(['CMS.QUERY', `${prefix}:test:frequency`, 'recovered']), [1]);

    // Redelivery of a completed commit must not count the records twice.
    await pipeline.close();
    await client.sendCommand(['XCLAIM', stream, GROUP, 'local-view', '0', commitId, 'FORCE']);
    pipeline = new RedisPipeline({ prefix });
    await pipeline.ensure('test');
    const retryDeadline = Date.now() + 10000;
    while ((await client.xPending(stream, GROUP)).pending && Date.now() < retryDeadline) await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(await client.sendCommand(['CMS.QUERY', `${prefix}:test:frequency`, 'recovered']), [1]);
    assert.equal((await pipeline.stats()).test.lag, 0);
  } finally {
    await pipeline.close();
    await client.sendCommand(['FT.DROPINDEX', index]).catch(() => {});
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length) await client.del(keys);
    await client.close();
  }
});


test('schema 2 manifests migrate without changing entities, Stream history or CMS', async () => {
  const prefix = `gev-test:${randomUUID()}`;
  const pipeline = new RedisPipeline({prefix});
  const client = await pipeline.connect();
  const base = `${prefix}:test`;
  const packed = packBody(Buffer.from(JSON.stringify({rows: [{id: 'a', nested: {empty: []}}], time: 123})), 'application/json');
  const record = packed.records[0];
  const entity = `${base}:entity:${record.entityKey}`;
  const manifest = {...packed.manifest, token: 'existing-token', items: [{id: record.id, item: record.item, key: entity}]};
  try {
    await client.set(`${base}:projection-schema`, '2');
    await client.set(`${base}:view:old`, JSON.stringify(manifest), {EX: 3600});
    await client.sendCommand(['JSON.SET', entity, '$', JSON.stringify({...entityDocument('test', 'old', record), cohort: 'old'})]);
    await client.sAdd(`${entity}:owners`, 'old');
    await client.sendCommand(['XGROUP', 'CREATE', `${base}:stream`, GROUP, '$', 'MKSTREAM']);
    await client.sendCommand(['CMS.INITBYPROB', `${base}:frequency`, '0.001', '0.01']);
    await client.sendCommand(['CMS.INCRBY', `${base}:frequency`, 'a', '7']);
    await pipeline.ensure('test');
    assert.deepEqual(JSON.parse(await pipeline.snapshot('test', 'old')), {rows: [{id: 'a', nested: {empty: []}}], time: 123});
    assert.equal(await client.exists([`${base}:view:old`, `${entity}:owners`]), 0);
    assert.match(await client.get(`${base}:projection-schema`), /^3:/);
    assert.deepEqual(JSON.parse(await client.sendCommand(['JSON.GET', entity, '.collections'])), ['old']);
    assert.equal((await pipeline.stats()).test.entriesAdded, 0);
    assert.deepEqual(await client.sendCommand(['CMS.QUERY', `${base}:frequency`, 'a']), [7]);
    // A membership whose snapshot expired must not keep an entity alive forever.
    await pipeline.project('test', 'new', packed);
    await client.del(`${base}:snapshot:old`);
    await pipeline.project('test', 'new', packBody(Buffer.from('{"rows":[]}'), 'application/json'));
    assert.equal(await client.exists(entity), 0);
  } finally {
    const cleanup = client.duplicate(); cleanup.on('error', () => {}); await cleanup.connect();
    await pipeline.close();
    const keys = await cleanup.keys(`${prefix}:*`);
    if (keys.length) await cleanup.unlink(keys);
    await cleanup.close();
  }
});


test('flush recovery repairs status, concurrent intake and a flush during commit', {timeout: 30000}, async () => {
  const prefix = `gev-test:${randomUUID()}`;
  const pipeline = new RedisPipeline({prefix});
  const client = await pipeline.connect();
  const clear = async () => {const keys = await client.keys(`${prefix}:*`); if (keys.length) await client.unlink(keys);};
  const packed = packBody(Buffer.from('{"ac":[{"hex":"a","lat":1,"lon":2}]}'), 'application/json');
  try {
    await pipeline.project('military', 'live', packed);
    const initial = (await pipeline.stats()).military;
    // Equivalent to FLUSHDB for this isolated namespace, without touching demo data.
    await clear();
    const repaired = (await pipeline.stats()).military;
    assert.equal(repaired.error, null);
    assert.notEqual(repaired.epoch, initial.epoch);
    assert.equal(repaired.entriesAdded, 0);
    const workers = await Promise.all(Array.from({length: 8}, () => pipeline.ensure('military')));
    assert.equal(new Set(workers.map(worker => worker.state)).size, 1);
    assert.equal((await client.xInfoConsumers(`${prefix}:military:stream`, GROUP)).length, 1);
    assert.equal(JSON.parse(await pipeline.project('military', 'live', packed)).ac[0].hex, 'a');
    // A missing group or sketch also repairs, without taking down /status.
    await client.sendCommand(['XGROUP', 'DESTROY', `${prefix}:military:stream`, GROUP]);
    assert.equal((await pipeline.stats()).military.error, null);
    await client.del(`${prefix}:military:frequency`);
    assert.equal((await pipeline.stats()).military.error, null);
    const original = client.sendCommand.bind(client);
    let flushed = false;
    client.sendCommand = async (...args) => {
      if (!flushed && args[0][0] === 'XADD' && args[0].includes('commit')) {
        flushed = true;
        await clear();
      }
      return original(...args);
    };
    try { assert.equal(JSON.parse(await pipeline.project('military', 'live', packed)).ac[0].hex, 'a'); }
    finally {client.sendCommand = original;}
    assert.ok(flushed);
    const final = (await pipeline.stats()).military;
    assert.equal(final.error, null);
    assert.equal(final.pending, 0);
    assert.equal(final.lag, 0);
    assert.deepEqual(await client.sendCommand(['CMS.QUERY', `${prefix}:military:frequency`, 'a']), [1]);
  } finally {
    const cleanup = client.duplicate(); cleanup.on('error', () => {}); await cleanup.connect();
    await pipeline.close();
    const keys = await cleanup.keys(`${prefix}:*`);
    if (keys.length) await cleanup.unlink(keys);
    await cleanup.close();
  }
});


test('cancelled ingestion does not append more records or commit a partial snapshot', async () => {
  const prefix = `gev-test:${randomUUID()}`;
  const pipeline = new RedisPipeline({prefix});
  const client = await pipeline.connect();
  const controller = new AbortController();
  const original = pipeline.checkEpoch.bind(pipeline);
  let checks = 0;
  pipeline.checkEpoch = async (...args) => {await original(...args); if (++checks === 2) controller.abort();};
  const packed = packBody(Buffer.from(JSON.stringify({rows: Array.from({length: 1500}, (_, id) => ({id}))})), 'application/json');
  try {
    await assert.rejects(pipeline.project('test', 'cancelled', packed, '', controller.signal), {name: 'AbortError'});
    assert.equal((await pipeline.stats()).test.entriesAdded, 100, 'only the batch accepted before cancellation remains');
    await assert.rejects(pipeline.snapshot('test', 'cancelled'), /snapshot not found/);
    pipeline.checkEpoch = original;
    const snapshots = [1, 2].map(lat => packBody(Buffer.from(JSON.stringify({rows: [{id: 'shared', lat}]})), 'application/json'));
    const results = await Promise.all(snapshots.map(packed => pipeline.project('test', 'shared', packed)));
    assert.deepEqual(results.map(buffer => JSON.parse(buffer).rows[0].lat), [1, 2], 'independent requests serialize same-source commits');
  } finally {
    const cleanup = client.duplicate(); cleanup.on('error', () => {}); await cleanup.connect();
    await pipeline.close(); const keys = await cleanup.keys(`${prefix}:*`);
    if (keys.length) await cleanup.unlink(keys); await cleanup.close();
  }
});

test('closing the browser request cancels server intake before projection', {timeout: 15000}, async () => {
  const {createServer} = await import('node:http');
  const {redisLayersPlugin} = await import('./plugin.js');
  const prefix = `gev-test:${randomUUID()}`;
  const plugin = redisLayersPlugin({pipelineOptions: {prefix}});
  let middleware, sourceResponse, sourceArrived;
  const arrived = new Promise(resolve => {sourceArrived = resolve;});
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/redis/')) {req.url = req.url.slice('/api/redis'.length); void middleware(req, res);}
    else {sourceResponse = res; sourceArrived();}
  });
  plugin.configureServer({httpServer: server, middlewares: {use: (path, fn) => {middleware = fn;}}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({url: process.env.REDIS_URL || 'redis://127.0.0.1:6379'});
  client.on('error', () => {}); await client.connect();
  try {
    const controller = new AbortController();
    const response = fetch(`${base}/api/redis/ingest`, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({layer: 'military', url: '/api/adsblol/mil'}), signal: controller.signal});
    const rejected = assert.rejects(response, {name: 'AbortError'});
    await arrived; controller.abort(); await rejected;
    await new Promise(resolve => setTimeout(resolve, 50));
    sourceResponse.writeHead(200, {'content-type': 'application/json'});
    sourceResponse.end('{"ac":[{"hex":"a"}]}');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await client.xLen(`${prefix}:military:stream`), 0);
    const status = await (await fetch(`${base}/api/redis/status`)).json();
    assert.deepEqual(status.errors, [], 'expected cancellation must not become a Redis warning');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await plugin.closeBundle(); const keys = await client.keys(`${prefix}:*`);
    if (keys.length) await client.unlink(keys); await client.quit();
  }
});
