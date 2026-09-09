// Shared catalog and server-owned plans: suggestions never invoke the model.
export const SEARCH_LAYERS = [
  ['flights', 'flight'], ['military', 'military flight'], ['satellites', 'satellite'],
  ['ais-live-vessels', 'AIS vessel'], ['local-datacenters', 'datacenter'], ['radio', 'radio station'],
];
const count = (query='*',scope='global') => ({operation:'aggregate',query,scope,focus:false,metrics:[{function:'COUNT',field:'',alias:'count'}]});
const average = (query='*',scope='global') => ({...count(query,scope),metrics:[{function:'AVG',field:'speedMps',alias:'averageSpeedMps'},{function:'COUNT',field:'',alias:'objects'}]});
const fastest = (query='@speedMps:[0 +inf]') => ({query,sortBy:'speedMps'});
const highest = () => ({query:'@altitudeM:[0 +inf]',sortBy:'altitudeM'});
const groups = (field,scope='global') => ({...count('*',scope),groupBy:[field],sortBy:'count',limit:5});
const preset = (id,layer,label,plan) => ({id,layer,label,plan});
export const SEARCH_PRESETS = [
  preset('tel-aviv-flights','flights','Flights within 500 km of Tel Aviv',count('@location:[34.7818 32.0853 500 km]')),
  preset('fastest-flight','flights','Fastest flight worldwide',fastest()),
  preset('flight-types','flights','Which aircraft types are most common?',groups('typeName')),
  preset('highest-flight','flights','Which flight is flying highest?',highest()),
  preset('flight-speed-in-view','flights','Average flight speed in this view',average('*','viewport')),

  preset('military-types','military','Most common military aircraft types',groups('typeName')),
  preset('military-in-view','military','How many military flights in this view?',count('*','viewport')),
  preset('fastest-military','military','Fastest military flight',fastest()),
  preset('highest-military','military','Highest flying military aircraft',highest()),
  preset('military-speed','military','Average military flight speed',average()),

  preset('starlink-speed','satellites','Average Starlink speed',average('@name:(STARLINK*)')),
  preset('satellite-types','satellites','Which satellite types dominate?',groups('type')),
  preset('fastest-comms','satellites','Fastest communications satellite',fastest('@type:(COMMS*) @speedMps:[0 +inf]')),
  preset('highest-satellite','satellites','Which satellite orbits highest?',highest()),
  preset('satellites-in-view','satellites','How many satellites over this view?',count('*','viewport')),

  preset('vessels-in-view','ais-live-vessels','How many AIS vessels in this view?',count('*','viewport')),
  preset('suez-vessels','ais-live-vessels','Vessels within 150 km of the Suez Canal',count('@location:[32.35 30.6 150 km]')),
  preset('hormuz-vessels','ais-live-vessels','Vessels within 100 km of Hormuz',count('@location:[56.3 26.6 100 km]')),
  preset('gibraltar-vessels','ais-live-vessels','Vessels within 100 km of Gibraltar',count('@location:[-5.6 35.96 100 km]')),
  preset('vessel-count','ais-live-vessels','How many AIS vessels are tracked?',count()),

  preset('datacenter-operators','local-datacenters','Top 5 datacenter operators',groups('operator')),
  preset('datacenters-in-view','local-datacenters','How many datacenters in this view?',count('*','viewport')),
  preset('datacenter-operators-in-view','local-datacenters','Leading datacenter operators in this view',groups('operator','viewport')),
  preset('datacenter-count','local-datacenters','How many datacenters are cataloged?',count()),
  preset('datacenter-operator-count','local-datacenters','How many distinct datacenter operators?',{...count(),metrics:[{function:'COUNT_DISTINCT',field:'operator',alias:'operators'}]}),

  preset('radio-news','radio','Find news radio stations', {query:'@tag:{news}',limit:5}),
  preset('radio-in-view','radio','How many radio stations in this view?',count('*','viewport')),
  preset('radio-talk','radio','How many stations carry talk radio?',count('@tag:{talk}')),
  preset('radio-music','radio','How many stations carry music?',count('@tag:{music}')),
  preset('radio-count','radio','How many radio stations are cataloged?',count()),
];
export function quickSearchOptions(selected,layers,{viewport=null}={}) {
  const active=SEARCH_LAYERS.filter(([id])=>layers.some(layer=>layer.id===id&&layer.enabled));
  const near=selected&&Number.isFinite(selected.latitude)&&Number.isFinite(selected.longitude)&&Math.abs(selected.latitude)<=85.05112878&&Math.abs(selected.longitude)<=180;
  const options=near?active.filter(([id])=>id!==selected.layer).concat(active.filter(([id])=>id===selected.layer)).slice(0,2)
    .map(([layer,label])=>({id:`closest:${layer}`,layer,label:`Closest ${label} to this object`})) : [];
  const queues=active.map(([layer])=>SEARCH_PRESETS.filter(p=>p.layer===layer&&(p.plan.scope!=='viewport'||viewport)));
  // Round-robin ensures multiple active layers get represented, then fills with
  // different investigations even when only one layer is enabled. Stable ordering
  // avoids buttons moving under the pointer as the map/feed refreshes.
  for(let row=0;row<5&&options.length<5;row++)for(const queue of queues){
    if(queue[row]&&options.length<5){const {id,layer,label}=queue[row];options.push({id,layer,label});}
  }
  return options;
}
export function presetPlan(id,prefix) {
  const near=SEARCH_LAYERS.find(([layer])=>id===`closest:${layer}`);
  const preset=SEARCH_PRESETS.find(p=>p.id===id);
  if(!near&&!preset)throw new Error('Unknown quick search');
  const layer=near?.[0]||preset.layer;
  const plan={index:`${prefix}:${layer}:idx`,query:'*',operation:'search',sortBy:'',sortDirection:'DESC',limit:1,groupBy:[],metrics:[],scope:'global',region:null,focus:true,explanation:near?`Closest ${near[1]} to the selected object.`:preset.label,clarification:null};
  return near?{...plan,operation:'nearest',scope:'selected'}:{...plan,...preset.plan};
}
