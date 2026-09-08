import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {enrichFlightRecords} from './flightEnrichment.js';
import {packBody, entityDocument} from './payload.js';

test('cached types join individual state records without changing source vectors or counting lookups', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-enrichment-'));
  try {
    const cachePath = path.join(dir, 'adsbdb.json');
    const now = Date.now();
    await writeFile(cachePath, JSON.stringify({aircraft: {
      abcdef: {at: now - 1000, data: {typeName:'Boeing 787 8',typeCode:'B788',registration:'N786AV'}},
      '123456': {at: now - 86400000, data:{typeName:'Expired'}},
      '654321': {at: now, data:null},
    }}));
    const states = ['ABCDEF','123456','654321','111111'].map(id=>[id,'TEST',null,now/1000,now/1000,1,2,300]);
    const packed = packBody(Buffer.from(JSON.stringify({states})), 'application/json', '/api/opensky');
    await enrichFlightRecords(packed, {cachePath,now});
    assert.equal(packed.records.length,4);
    const doc = entityDocument('flights','test',packed.records[0]);
    assert.equal(doc.id,'abcdef'); assert.equal(doc.typeName,'Boeing 787 8');
    assert.equal(doc.typeKnown,1); assert.equal(doc.enrichmentUpdatedAt,now-1000);
    assert.deepEqual(doc.source,states[0]);
    for(const record of packed.records.slice(1)) assert.equal(record.enrichment,undefined);
    await enrichFlightRecords(packed,{cachePath:path.join(dir,'missing')});
  } finally {await rm(dir,{recursive:true,force:true});}
});
