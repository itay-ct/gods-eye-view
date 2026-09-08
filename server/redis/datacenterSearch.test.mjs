import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RedisPipeline} from './pipeline.js';
import {packBody} from './payload.js';
import {datacenterQuery} from './datacenterSearch.js';

test('datacenter names use literal prefix terms and operators use exact tags',()=>{
  assert.equal(datacenterQuery({name:'Lond',operator:'AT&T'}),'@name:(Lond*) @operatorExact:{AT\\&T}');
  assert.equal(datacenterQuery({}), '*');
  assert.throws(()=>datacenterQuery({name:'*|'}));
});
test('datacenter Search filters original GeoJSON and ranks operators in the name scope without ingesting',async()=>{
 const p=new RedisPipeline({prefix:`gev-dc-test:${randomUUID()}`});
 const layer='local-datacenters';
 const feature=(id,name,operator)=>({id,type:'Feature',geometry:{type:'Point',coordinates:[1,2]},properties:{tags:{name,...(operator ? {operator} : {})}}});
 const features=[feature(1,'London One','AT&T'),feature(2,'London Two','at&t'),feature(3,'Paris','Equinix'),feature(4,'London Unknown',undefined)];
 try{
  const packed=packBody(Buffer.from(features.map(JSON.stringify).join('\n')),'text/plain','/src/data/local_data/datacenters/datacenters.geojsonl');
  await p.project(layer,'catalogue',packed);
  const before=(await p.stats())[layer].entriesAdded;
  const parse=b=>b.toString().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(parse(await p.snapshot(layer,'catalogue',null,{name:'Lond',operator:'AT&T'})),features.slice(0,2));
  assert.deepEqual(parse(await p.snapshot(layer,'catalogue',null,{name:'NoMatch'})),[]);
  assert.deepEqual(parse(await p.snapshot(layer,'catalogue')),features);
  assert.deepEqual(await p.datacenterOperators('Lond'),{types:[{name:'AT&T',count:2}],total:3,typed:2});
  assert.deepEqual((await p.datacenterOperators('')).types,[{name:'AT&T',count:2},{name:'Equinix',count:1}]);
  assert.equal((await p.stats())[layer].entriesAdded,before);
  const c=await p.connect();await c.sendCommand(['FT.DROPINDEX',`${p.prefix}:${layer}:idx`]);
  assert.equal((await p.datacenterOperators()).total,4);
 }finally{
  const c=(await p.connect()).duplicate();c.on('error',()=>{});await c.connect();await p.close();
  await c.sendCommand(['FT.DROPINDEX',`${p.prefix}:${layer}:idx`]).catch(()=>{});
  const keys=await c.keys(`${p.prefix}:*`);if(keys.length)await c.unlink(keys);await c.close();
 }
});
