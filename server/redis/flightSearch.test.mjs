import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RedisPipeline} from './pipeline.js';
import {packBody} from './payload.js';
import {flightQuery} from './flightSearch.js';

const position = (id, label = 'VLG29AJ') => [id, label, 'Spain', 1788849963, 1788849963, 6.941, 51.1849, 3299, false, 179, 30, -5, null, 3459, '1000', false, 0, 0];
const packed = (data, url = '/api/opensky') => packBody(Buffer.from(JSON.stringify(data)), 'application/json', url);

test('flight label uses safe prefix Search and selected type names are literal exact tags', () => {
  assert.equal(flightQuery({label: 'VLG', typeName: 'Airbus A320-232'}), '@kind:{states} @label:(VLG*) @typeNameExact:{Airbus\\ A320\\-232}');
  assert.throws(() => flightQuery({label: '*|'}));
});

test('Stream enrichment merges into flight JSON, survives positions, and powers distinct sorted Search', {timeout: 60000}, async () => {
  const prefix = `gev-flight-test:${randomUUID()}`;
  const p = new RedisPipeline({prefix});
  const update = rows => p.project('flights', 'positions', packed({time: 1788849963, states: rows}), '/api/opensky');
  const enrich = (id, data) => p.project('flights', `type-${id}`, packed({found: true, ...data}, `/api/adsbdb/type/${id}`), `/api/adsbdb/type/${id}`);
  try {
    const client = await p.connect();
    const read = async id => JSON.parse(await client.sendCommand(['JSON.GET', `${prefix}:flights:entity:states:${id}`]));
    const row = position('34454b');
    await update([row]);
    assert.equal((await read('34454b')).typeName, undefined);
    await enrich('34454b', {typeCode: 'A320', typeName: 'Airbus A320-232', registration: 'EC-TEST'});
    assert.deepEqual((await read('34454b')).source, row, 'enrichment must not replace the state vector');
    await update([position('34454b', 'VLG123')]);
    const entity = await read('34454b');
    assert.equal(entity.label, 'VLG123'); assert.equal(entity.typeName, 'Airbus A320-232');
    assert.equal(entity.registration, 'EC-TEST');
    assert.equal((await p.updateCount('flights', '34454b')).count, 3);
    const view = JSON.parse(await p.snapshot('flights', 'positions', null, {label: 'VLG', typeName: 'Airbus A320-232'}));
    assert.equal(view.states.length, 1);
    assert.equal(view.aircraft['34454b'].typeCode, 'A320');
    assert.deepEqual(JSON.parse(await p.snapshot('flights', 'positions', null, {label: 'BAW'})).states, []);
    assert.equal(JSON.parse(await p.snapshot('flights', 'type-34454b')).typeName, entity.typeName);
    // A lookup can arrive before the next position snapshot.
    await enrich('abcdef', {typeName: 'Boeing 737', typeCode: 'B738'});
    assert.deepEqual(await p.flightTypes(), [{name: 'Airbus A320-232', count: 1}], 'enrichment-only records are not displayed aircraft');
    await update([row, position('ABCDEF', 'BAW1')]);
    assert.equal((await read('abcdef')).typeName, 'Boeing 737');
    await enrich('abcdef', {typeName: null, typeCode: null});
    assert.equal((await read('abcdef')).typeName, 'Boeing 737', 'missing values do not erase useful enrichment');
    await Promise.all([
      update([row, position('abcdef', 'BAW2')]),
      enrich('abcdef', {registration: 'G-TEST'}),
    ]);
    assert.equal((await read('abcdef')).registration, 'G-TEST', 'concurrent source commits preserve enrichment');
    assert.equal((await read('abcdef')).label, 'BAW2');
    assert.deepEqual(await p.flightTypes(), [{name: 'Airbus A320-232', count: 1}, {name: 'Boeing 737', count: 1}]);
    // More than 20 duplicates of one model must not consume the dropdown.
    const many = Array.from({length: 55}, (_, i) => position((0x100000 + i).toString(16), `TEST${i}`));
    await update(many);
    for (let i = 0; i < many.length; i++) {
      await enrich(many[i][0], {typeName: i < 30 ? 'Model 00' : `Model ${String(i - 29).padStart(2, '0')}`});
    }
    const coverage = await p.flightTypeSummary('');
    assert.equal(coverage.total, 57);
    assert.equal(coverage.typed, 57);
    assert.equal(coverage.types[0].count, 30);
    await update([...many, position('999999', 'UNKNOWN')]);
    const updated = await p.flightTypeSummary('');
    assert.equal(updated.total, 58, 'empty label refresh includes new untyped aircraft');
    assert.equal(updated.typed, 57);
    assert.equal((await p.flightTypeSummary('BAW')).total, 1);
    assert.equal((await p.flightTypeSummary('NOMATCH')).total, 0);
    const before = (await p.stats()).flights.entriesAdded;
    const options = await p.flightTypes();
    assert.equal(options.length, 20);
    assert.deepEqual(options.slice(0, 4).map(x => x.name), ['Model 00', 'Airbus A320-232', 'Boeing 737', 'Model 01']);
    assert.equal(options[0].count, 30);
    assert.deepEqual(await p.flightTypes('BAW'), [{name: 'Boeing 737', count: 1}]);
    assert.deepEqual(await p.flightTypes('NOMATCH'), []);
    const retained = JSON.parse(await p.snapshot('flights', 'positions'));
    assert.equal(retained.states.length, 58, 'regional snapshots retain cached aircraft');
    assert.equal((await p.updateCount('flights', '34454b')).count, 5, 'retention does not count as ingestion');
    await client.del(`${prefix}:flights:entity:states:34454b`);
    assert.equal(JSON.parse(await p.snapshot('flights', 'positions')).states.length, 57, 'expired aircraft disappear from the view');
    assert.equal(new Set(options.map(x => x.name)).size, 20);
    assert.equal((await p.stats()).flights.entriesAdded, before, 'dropdown is read-only');
    const beforeRebuild = await p.flightTypes();
    await client.sendCommand(['FT.DROPINDEX', `${prefix}:flights:idx`]);
    assert.deepEqual(await p.flightTypes(), beforeRebuild, 'index rebuild includes existing enriched JSON');
    await enrich('999999', {typeName: 'Model 00'});
    assert.equal((await p.flightTypeSummary('')).types[0].count, 31, 'empty-label ranking updates when enrichment arrives');
    // Completed-commit redelivery remains idempotent for CMS and enrichment.
    const events = await client.xRevRange(`${prefix}:flights:stream`, '+', '-', {COUNT: 1});
    const countBefore = (await p.updateCount('flights', many.at(-1)[0])).count;
    await client.xAdd(`${prefix}:flights:stream`, '*', events[0].message);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await p.updateCount('flights', many.at(-1)[0])).count, countBefore);
    const cached = packed({states:[position('222222','CACHE1')]});
    cached.records[0].enrichment = {typeName:'Cached model',typeCode:'B788',typeKnown:1,enrichmentUpdatedAt:Date.now()-1000};
    await p.project('flights','cached-position',cached,'/api/opensky');
    assert.equal((await read('222222')).typeName,'Cached model');
    assert.equal((await p.updateCount('flights','222222')).count,1);
    await enrich('222222',{typeName:'Newer model'});
    await p.project('flights','cached-position',cached,'/api/opensky');
    assert.equal((await read('222222')).typeName,'Newer model','older disk cache must not overwrite newer enrichment');

  } finally {
    const client = await p.connect(); const cleanup = client.duplicate(); cleanup.on('error', () => {}); await cleanup.connect();
    await p.close();
    await cleanup.sendCommand(['FT.DROPINDEX', `${prefix}:flights:idx`]).catch(() => {});
    const keys = await cleanup.keys(`${prefix}:*`); if (keys.length) await cleanup.unlink(keys);
    await cleanup.close();
  }
});
