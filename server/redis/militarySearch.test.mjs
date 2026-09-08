import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RedisPipeline} from './pipeline.js';
import {packBody} from './payload.js';
import {militaryQuery} from './militarySearch.js';

test('military Search uses callsign prefixes, exact types and label-scoped ranked counts', async () => {
  const prefix=`gev-test:${randomUUID()}`;
  const pipeline=new RedisPipeline({prefix});
  const client=await pipeline.connect();
  try {
    const ac=[{hex:'a',flight:'RCH001',t:'C17',lat:32,lon:34},{hex:'b',flight:'RCH002',t:'C17',lat:32,lon:34},
      {hex:'c',flight:'TEST01',t:'C130',lat:32,lon:34},{hex:'d',flight:'RCH003',lat:32,lon:34}];
    await pipeline.project('military','one',packBody(Buffer.from(JSON.stringify({ac,msg:'ok'})),'application/json'));
    assert.match(militaryQuery({label:'RCH'}), /@label:\(RCH\*\)/);
    assert.deepEqual(await pipeline.militaryTypes('RCH'), {types:[{name:'C17',count:2}],total:3,typed:2});
    const before=(await pipeline.stats()).military.entriesAdded;
    const read=filter=>pipeline.snapshot('military','one',null,filter).then(JSON.parse);
    assert.deepEqual((await read({label:'RCH',typeName:'C17'})).ac.map(a=>a.hex),['a','b']);
    assert.equal((await read({label:'missing'})).ac.length,0);
    assert.equal((await pipeline.stats()).military.entriesAdded,before);
  } finally {
    const cleanup=client.duplicate();cleanup.on('error',()=>{});await cleanup.connect();await pipeline.close();
    await cleanup.sendCommand(['FT.DROPINDEX',`${prefix}:military:idx`]).catch(()=>{});
    const keys=await cleanup.keys(`${prefix}:*`);if(keys.length)await cleanup.unlink(keys);await cleanup.close();
  }
});
