// Run against a disposable Redis 8.2+ instance, e.g. REDIS_URL=redis://127.0.0.1:16379 node scripts/redis-load-check.mjs
// Synthetic data stays in a unique namespace and is removed at the end.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {RedisPipeline} from '../server/redis/pipeline.js';
import {packBody} from '../server/redis/payload.js';

if (!process.env.REDIS_URL) throw new Error('Set REDIS_URL to a disposable Redis instance for this load check');
const prefix = `gev-load:${randomUUID()}`;
const pipeline = new RedisPipeline({prefix});
const client = (await pipeline.connect()).duplicate(); client.on('error', () => {}); await client.connect();
let monitoring = true;
const pings = [], errors = [], results = [];
let scriptMaxMs = 0;
const run = pipeline.runProjector.bind(pipeline);
pipeline.runProjector = async (...args) => {
  const started = performance.now();
  try {return await run(...args);}
  finally {scriptMaxMs = Math.max(scriptMaxMs, performance.now() - started);}
};
const monitor = (async () => {
  while (monitoring) {
    const started = performance.now();
    try {await client.ping(); pings.push(performance.now() - started);}
    catch (error) {errors.push(error.message);}
    await delay(10);
  }
})();
try {
  for (let round = 0; round < 3; round++) {
    const started = performance.now();
    const states = Array.from({length: 10000}, (_, id) => [id.toString(16).padStart(6, '0'), `DEMO ${id}`, 'Test', round, round, 34 + id / 10000, 32, 10000, false, 200, 90, 0, null, 10000, null, false, 0, 0]);
    const rows = Array.from({length: 12500}, (_, id) => ({mmsi: 200000000 + id, name: `DEMO SHIP ${id}`, lat: 32, lon: 34 + id / 12500, speed: 10, at: round}));
    // Two indexed layers ingest concurrently, with a separate Redis client probing responsiveness.
    await Promise.all([
      pipeline.project('flights', 'world', packBody(Buffer.from(JSON.stringify({states})), 'application/json'), '/api/opensky', null, false),
      pipeline.project('ais-live-vessels', 'world', packBody(Buffer.from(JSON.stringify({rows})), 'application/json'), '/api/ais-live', null, false),
    ]);
    const [flights, vessels] = await Promise.all([
      pipeline.snapshot('flights', 'world', null, {label: 'DEMO'}),
      pipeline.snapshot('ais-live-vessels', 'world', null, {label: 'DEMO'}),
    ]);
    assert.equal(JSON.parse(flights).states.length, 10000);
    assert.equal(JSON.parse(vessels).rows.length, 12500);
    const stats = await pipeline.stats();
    for (const value of Object.values(stats)) {
      assert.equal(value.pending, 0); assert.equal(value.lag, 0); assert.ok(value.length <= 100000);
    }
    results.push({round: round + 1, seconds: +((performance.now() - started) / 1000).toFixed(2)});
    console.log(JSON.stringify(results.at(-1)));
  }
  assert.deepEqual(errors, [], 'Redis must keep serving other clients during projection');
  pings.sort((a, b) => a - b);
  console.log(JSON.stringify({results, projectedUpdates: 67500, pingSamples: pings.length,
    pingP99Ms: +pings[Math.floor(pings.length * 0.99)].toFixed(2), pingMaxMs: +pings.at(-1).toFixed(2),
    projectorRoundTripMaxMs: +scriptMaxMs.toFixed(2), errors}, null, 2));
} finally {
  monitoring = false; await monitor;
  await pipeline.close();
  for (const layer of ['flights', 'ais-live-vessels']) await client.sendCommand(['FT.DROPINDEX', `${prefix}:${layer}:idx`]).catch(() => {});
  for await (const keys of client.scanIterator({MATCH: `${prefix}:*`, COUNT: 500})) if (keys.length) await client.unlink(keys);
  await client.close();
}
