import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RedisPipeline} from './pipeline.js';
import {packBody} from './payload.js';
import {radioCategories,stationMatchesRadioCategory} from '../../src/data/radioTags.js';
import {radioQuery} from './radioSearch.js';
test('radio names and category tags are safe Search inputs',()=>{
 assert.equal(radioQuery({name:'folk',tag:'genre:folk'}),'@label:(folk*) @tag:{genre\\:folk}');
 assert.throws(()=>radioQuery({tag:'unknown'}));
});
test('radio Search matches the existing visual categories and preserves the full directory envelope',async()=>{
 const p=new RedisPipeline({prefix:`gev-radio-test:${randomUUID()}`});
 const stations=[{id:'one',name:'Folk World',tags:['folk-rock'],lat:1,lon:2},{id:'two',name:'News One',tags:'news,interview',lat:2,lon:3},{id:'three',name:'Unknown',tags:[],lat:3,lon:4}];
 const payload={stations,acceptedGeneration:4,catalogInstance:'test',stale:false,degraded:false};
 try{
  await p.project('radio','catalogue',packBody(Buffer.from(JSON.stringify(payload)),'application/json','/api/radio/stations'));
  const before=(await p.stats()).radio.entriesAdded;
  for(const tag of ['all','genre:folk','music','news','talk','other']){
   const result=JSON.parse(await p.snapshot('radio','catalogue',null,{name:'',tag}));
   assert.deepEqual(result,{...payload,stations:stations.filter(station=>stationMatchesRadioCategory(station,tag))});
  }
  assert.equal(JSON.parse(await p.snapshot('radio','catalogue',null,{name:'NO MATCH',tag:'all'})).stations.length,0);
  assert.equal((await p.stats()).radio.entriesAdded,before);
  assert.ok(radioCategories(stations[0]).includes('genre:folk'));
 }finally{const c=(await p.connect()).duplicate();c.on('error',()=>{});await c.connect();await p.close();await c.sendCommand(['FT.DROPINDEX',`${p.prefix}:radio:idx`]).catch(()=>{});const keys=await c.keys(`${p.prefix}:*`);if(keys.length)await c.unlink(keys);await c.close();}
});
