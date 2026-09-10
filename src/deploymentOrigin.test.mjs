import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredOrigins, discoverPortalOrigins} from './deploymentOrigin.mjs';
import {admitKeySetupRequest} from './keySetupCore.mjs';

const origins = ['https://rl-s-labs-example.labs.ps-redis.com', 'https://80-p-rl-s-labs-example.labs.ps-redis.com'];
test('discovers exactly the two aliases of this portal VM from non-secret metadata', async () => {
  const requests=[];
  const result=await discoverPortalOrigins(async(url, options)=>{
    requests.push(url);
    assert.equal(options.headers['Metadata-Flavor'],'Google');
    return new Response(url.endsWith('/name')?'rl-s-labs-example':'labs.ps-redis.com',{headers:{'Metadata-Flavor':'Google'}});
  });
  assert.deepEqual(result,origins);
  assert.deepEqual(requests.map(url=>new URL(url).pathname),[
    '/computeMetadata/v1/instance/name','/computeMetadata/v1/instance/attributes/DOMAIN',
  ]);
});
test('metadata absence or unexpected identity never enables arbitrary origins', async () => {
  assert.deepEqual(await discoverPortalOrigins(async()=>{throw new Error('offline');}),[]);
  assert.deepEqual(await discoverPortalOrigins(async()=>new Response('labs.ps-redis.com')),[]);
  assert.deepEqual(await discoverPortalOrigins(async(url)=>new Response(url.endsWith('/name')?'other-vm':'labs.ps-redis.com',{headers:{'Metadata-Flavor':'Google'}})),[]);
  assert.deepEqual(await discoverPortalOrigins(async(url)=>new Response(url.endsWith('/name')?'rl-s-labs-example':'attacker.example',{headers:{'Metadata-Flavor':'Google'}})),[]);
});
test('explicit single origin wins over discovered aliases, invalid lists fail closed',()=>{
  assert.equal(configuredOrigins({}),null);
  assert.deepEqual(configuredOrigins({GEV_PUBLIC_ORIGINS:origins.join(',')}),origins);
  assert.deepEqual(configuredOrigins({GEV_PUBLIC_ORIGIN:origins[0],GEV_PUBLIC_ORIGINS:origins[1]}),[origins[0]]);
  assert.deepEqual(configuredOrigins({GEV_PUBLIC_ORIGINS:origins[0]+',*'}),[]);
});
test('POWER UP accepts both exact aliases only through the trusted container proxy',()=>{
  const request={method:'POST',remoteAddress:'127.0.0.1',hostHeader:'internal:80',contentType:'application/json',
    proxyHeaders:{'x-gev-setup-proxy':'1','x-forwarded-proto':'https'},
    env:{GEV_TRUST_SETUP_PROXY:'true',GEV_PUBLIC_ORIGINS:origins.join(',')}};
  for(const origin of origins) assert.deepEqual(admitKeySetupRequest({...request,origin}),{ok:true});
  assert.equal(admitKeySetupRequest({...request,origin:'https://rl-s-labs-other.labs.ps-redis.com'}).ok,false);
  assert.equal(admitKeySetupRequest({...request,origin:origins[0],remoteAddress:'192.0.2.1'}).ok,false);
  assert.equal(admitKeySetupRequest({...request,origin:undefined}).ok,false);
});
