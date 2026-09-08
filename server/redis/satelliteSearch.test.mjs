import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RedisPipeline } from './pipeline.js';
import { packBody, entityDocument } from './payload.js';
import { satelliteFields } from './satellite.js';
import { satelliteQuery } from './satelliteSearch.js';

const tle = (name = 'OKEAN-O', id = '25860') => `${name}\r\n1 ${id}U 99039A   26250.86940188  .00000369  00000+0  54956-4 0  9990\r\n2 ${id}  97.9235 308.6859 0001928  95.4766 264.6666 14.80546859461348\r\n`;
const pack = (text, group) => packBody(Buffer.from(text), 'text/plain', `/api/celestrak/${group}`);

test('satellite documents expose the UI name, catalog type, orbital elements and dated SGP4 position', () => {
  const record = pack(tle(), 'visual').records[0];
  const doc = entityDocument('satellites', 'visual', record);
  assert.equal(doc.name, 'OKEAN-O'); assert.equal(doc.label, doc.name);
  assert.equal(doc.type, 'VISUAL');
  assert.equal(doc.orbit.inclinationDeg, 97.9235);
  assert.equal(doc.orbit.eccentricity, 0.0001928);
  assert.equal(doc.orbit.meanMotionRevPerDay, 14.80546859);
  assert.equal(doc.internationalDesignator, '99039A');
  assert.equal(doc.source.text, tle(), 'exact source retained for original GEV propagation');
  const atEpoch = satelliteFields(tle(), record.satelliteGroup, new Date(doc.orbit.epoch));
  assert.equal(atEpoch.positionStatus, 'propagated');
  assert.ok(Math.abs(atEpoch.latitude) <= 90);
  assert.ok(Math.abs(atEpoch.longitude) <= 180);
  assert.ok(atEpoch.altitudeM > 100000);
  assert.ok(atEpoch.speedMps > 1000);
  assert.equal(entityDocument('satellites', '', pack(tle('GPS TEST'), 'gps-ops').records[0]).type, 'NAV · GPS');
  assert.throws(() => satelliteFields('broken', null), /Incomplete/);
});

test('filter input is literal words with AND semantics, never query operators', () => {
  assert.equal(satelliteQuery({name: '  OKEAN-O ', type: 'VISUAL'}), '@name:(OKEAN* O) @type:(VISUAL)');
  assert.equal(satelliteQuery({name: '', type: ''}), '*');
  assert.equal(satelliteQuery({name: 'ISS | @type:{GEO}'}), '@name:(ISS* type* GEO*)');
  assert.equal(satelliteQuery({name: 'STAR', type: 'COMMS'}), '@name:(STAR*) @type:(COMMS)');
  assert.throws(() => satelliteQuery({name: '*|'}), /letters or numbers/);
  assert.throws(() => satelliteQuery({type: 'a'.repeat(121)}), /120/);
});

test('real FT.SEARCH filters full satellite snapshots, leaves Streams/CMS intact and repairs indexes', {timeout: 60000}, async () => {
  const prefix = `gev-search-test:${randomUUID()}`;
  const p = new RedisPipeline({prefix});
  const project = (text, group) => p.project('satellites', group, pack(text, group), `/api/celestrak/${group}`);
  try {
    const text = Array.from({length: 25}, (_, i) => tle(`OKEAN ${i}`, String(25860 + i))).join('');
    await project(text, 'visual');
    const client = await p.connect();
    const before = (await p.stats()).satellites.entriesAdded;
    assert.equal((await p.snapshot('satellites', 'visual', null, {})).toString(), text, 'no default 10-result truncation');
    assert.equal((await p.snapshot('satellites', 'visual', null, {name: 'OKEAN', type: 'visual'})).toString(), text);
    assert.equal((await p.snapshot('satellites', 'visual', null, {name: 'absent'})).length, 0);
    assert.equal((await p.snapshot('satellites', 'visual', null, {name: 'OKEAN', type: 'geo'})).length, 0);
    assert.equal((await p.stats()).satellites.entriesAdded, before);
    assert.equal((await p.updateCount('satellites', '25860')).count, 1);
    const starlink = tle('STARLINK-1234', '30000');
    await project(starlink + tle('ONEWEB-1234', '30001'), 'starlink');
    const beforeSearch = (await p.stats()).satellites.entriesAdded;
    assert.equal((await p.snapshot('satellites', 'starlink', null, {name: 'star', type: 'COMMS'})).toString(), starlink);
    assert.equal((await p.snapshot('satellites', 'starlink', null, {name: 'STAR', type: 'NAV'})).length, 0);
    assert.equal((await p.stats()).satellites.entriesAdded, beforeSearch, 'prefix filtering does not ingest');
    // Edit only the indexed field: the search result must change without ingestion.
    await client.sendCommand(['JSON.SET', `${prefix}:satellites:entity:records:25860`, '$.name', '"RENAMED"']);
    assert.equal((await p.snapshot('satellites', 'visual', null, {name: 'RENAMED'})).toString(), tle('OKEAN 0'));
    // Canonical type follows source priority even when the less specific feed commits last.
    await project(tle('OKEAN 0'), 'stations');
    await project(text, 'visual');
    assert.equal((await p.snapshot('satellites', 'visual', null, {type: 'station'})).toString(), tle('OKEAN 0'));
    assert.equal((await p.snapshot('satellites', 'stations', null, {type: 'visual'})).length, 0);
    // Removing a membership restores the remaining group's type.
    await p.project('satellites', 'stations', {records: [], manifest: {encoding: 'tle', template: null, groups: [{path: [], ids: []}]}}, '/api/celestrak/stations');
    assert.equal((await p.snapshot('satellites', 'visual', null, {type: 'station'})).length, 0);
    assert.equal((await p.snapshot('satellites', 'visual')).toString(), text, 'filter off restores full snapshot');
    await client.sendCommand(['FT.DROPINDEX', `${prefix}:satellites:idx`]);
    assert.equal((await p.snapshot('satellites', 'visual', null, {name: 'OKEAN'})).toString(), text, 'recreated index waits for existing documents');
    const calls = await client.sendCommand(['INFO', 'commandstats']);
    assert.match(calls, /cmdstat_ft.search:calls=[1-9]/i);
  } finally {
    const client = await p.connect();
    const cleanup = client.duplicate(); cleanup.on('error', () => {}); await cleanup.connect();
    await p.close();
    await cleanup.sendCommand(['FT.DROPINDEX', `${prefix}:satellites:idx`]).catch(() => {});
    const keys = await cleanup.keys(`${prefix}:*`);
    if (keys.length) await cleanup.unlink(keys);
    await cleanup.close();
  }
});
