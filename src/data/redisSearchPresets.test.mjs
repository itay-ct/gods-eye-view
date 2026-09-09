import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SEARCH_LAYERS,SEARCH_PRESETS,quickSearchOptions,presetPlan} from './redisSearchPresets.js';
import {compilePlan} from '../../server/redis/userSearch.js';
const viewport={west:30,east:40,south:20,north:40};
const selected={id:'picked',layer:'flights',latitude:32,longitude:34};
test('every enabled-layer combination gets 3–5 unique, executable, relevant suggestions',()=>{
 for(let mask=0;mask<2**SEARCH_LAYERS.length;mask++){
  const layers=SEARCH_LAYERS.map(([id],i)=>({id,enabled:Boolean(mask&(1<<i))}));
  for(const target of [null,selected])for(const view of [null,viewport]){
   const options=quickSearchOptions(target,layers,{viewport:view});
   assert.ok(mask?options.length>=3&&options.length<=5:options.length===0,`mask ${mask}`);
   assert.equal(new Set(options.map(p=>p.id)).size,options.length);
   for(const option of options){
    assert.ok(layers.some(layer=>layer.id===option.layer&&layer.enabled));
    const plan=presetPlan(option.id,'gev');
    assert.ok(plan.scope!=='viewport'||view);
    assert.ok(plan.scope!=='selected'||target);
   }
  }
 }
});
test('selection adds nearby searches without crowding out other investigations',()=>{
 const layers=SEARCH_LAYERS.map(([id])=>({id,enabled:true}));
 const options=quickSearchOptions(selected,layers,{viewport});
 assert.equal(options.filter(p=>p.id.startsWith('closest:')).length,2);
 assert.ok(options.every(p=>p.id!=='closest:flights'));
 const disabled=quickSearchOptions(selected,[{id:'radio',enabled:true}],{viewport});
 assert.ok(disabled.every(p=>p.layer==='radio'));
 assert.ok(!quickSearchOptions({...selected,latitude:null},layers).some(p=>p.id.startsWith('closest:')));
 assert.deepEqual(quickSearchOptions(null,[{id:'cctv',enabled:true}]),[]);
});
test('all catalog queries compile against their actual index fields',()=>{
 const common=[['id','TAG'],['latitude','NUMERIC'],['longitude','NUMERIC'],['location','GEO'],['speedMps','NUMERIC'],['altitudeM','NUMERIC']];
 const extras={flights:[['typeName','TEXT']],military:[['typeName','TEXT']],satellites:[['name','TEXT'],['type','TEXT']],'ais-live-vessels':[],'local-datacenters':[['operator','TEXT']],radio:[['tag','TAG']]};
 for(const preset of SEARCH_PRESETS){
  const plan=presetPlan(preset.id,'gev');
  const schemas=[{index:plan.index,layer:preset.layer,fields:[...common,...extras[preset.layer]].map(([name,type])=>({name,type}))}];
  const result=compilePlan(plan,schemas,{viewport});
  assert.ok(['FT.SEARCH','FT.AGGREGATE'].includes(result.command[0]));
 }
});
