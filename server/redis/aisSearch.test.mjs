import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RedisPipeline} from './pipeline.js';
import {packBody} from './payload.js';
import {aisQuery} from './aisSearch.js';
test('AIS label query treats text as prefix words',()=>{
 assert.equal(aisQuery({label:'EVER'}),'@label:(EVER*)');assert.equal(aisQuery({label:''}),'*');assert.throws(()=>aisQuery({label:'*|'}));
});
test('AIS Search preserves feed metadata, scopes rows, and never ingests while filtering',async()=>{
 const p=new RedisPipeline({prefix:`gev-ais-test:${randomUUID()}`});const layer='ais-live-vessels';
 const payload={status:'open',lastMessageAt:123,rows:[{mmsi:'123',name:'EVER GIVEN',lat:1,lon:2},{mmsi:'456',name:'OCEAN STAR',lat:3,lon:4}]};
 try{
  await p.project(layer,'view',packBody(Buffer.from(JSON.stringify(payload)),'application/json','/api/ais-live'));
  const before=(await p.stats())[layer].entriesAdded;
  assert.deepEqual(JSON.parse(await p.snapshot(layer,'view',null,{label:'ever'})),{...payload,rows:[payload.rows[0]]});
  assert.deepEqual(JSON.parse(await p.snapshot(layer,'view',null,{label:'absent'})),{...payload,rows:[]});
  assert.deepEqual(JSON.parse(await p.snapshot(layer,'view')),payload);
  assert.equal((await p.stats())[layer].entriesAdded,before);
  const c=await p.connect();await c.sendCommand(['FT.DROPINDEX',`${p.prefix}:${layer}:idx`]);
  assert.equal(JSON.parse(await p.snapshot(layer,'view',null,{label:'OCEAN'})).rows.length,1);
 }finally{
  const c=(await p.connect()).duplicate();c.on('error',()=>{});await c.connect();await p.close();
  await c.sendCommand(['FT.DROPINDEX',`${p.prefix}:${layer}:idx`]).catch(()=>{});
  const keys=await c.keys(`${p.prefix}:*`);if(keys.length)await c.unlink(keys);await c.close();
 }
});
