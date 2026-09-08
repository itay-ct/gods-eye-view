import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {RedisPipeline, GROUP, snapshotMetadata} from './pipeline.js';
import {STAGE, COMMIT} from './projector.js';
import {packBody, entityDocument} from './payload.js';

const pack = rows => packBody(Buffer.from(JSON.stringify({rows})), 'application/json');
async function cleanup(pipeline, client, prefix) {
  await pipeline.close();
  const keys = await client.keys(`${prefix}:*`);
  if (keys.length) await client.unlink(keys);
  await client.close();
}

test('snapshot reads wait across partial publication and indexed writes remain bounded', {timeout: 30000}, async () => {
  const prefix = `gev-batch-test:${randomUUID()}`;
  const pipeline = new RedisPipeline({prefix});
  const connection = await pipeline.connect();
  const client = connection.duplicate(); client.on('error', () => {}); await client.connect();
  const rows = Array.from({length: 80}, (_, id) => ({id: String(id), lat: 1, nested: {empty: []}}));
  let release;
  try {
    await pipeline.project('test', 'one', pack(rows));
    const run = pipeline.runProjector.bind(pipeline);
    let paused;
    const ready = new Promise(resolve => {paused = resolve;});
    const gate = new Promise(resolve => {release = resolve;});
    pipeline.runProjector = async (client, state, script, payload) => {
      if (payload.phase === 'publish') assert.ok(payload.items.length <= 25);
      const result = await run(client, state, script, payload);
      if (payload.phase === 'publish' && payload.offset === 0) {paused(); await gate;}
      return result;
    };
    const update = pipeline.project('test', 'one', pack(rows.map(row => ({...row, lat: 2}))));
    await ready;
    let completed = false;
    const read = pipeline.snapshot('test', 'one').then(value => {completed = true; return value;});
    await delay(50);
    assert.equal(completed, false, 'strict snapshots still wait for atomic completion');
    const progressive = JSON.parse(await pipeline.snapshot('test', 'one', null, null, null, true));
    assert.equal(progressive.rows.length, 80, 'cached entities stay visible while new batches publish');
    assert.equal(progressive.rows.filter(row => row.lat === 2).length, 25, 'the first published batch is immediately readable');
    const controller = new AbortController();
    const cancelled = pipeline.snapshot('test', 'one', null, null, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, {name: 'AbortError'});
    assert.equal(await client.ping(), 'PONG', 'other clients can operate between batches');
    release();
    const [updated, snapshot] = await Promise.all([update, read]);
    assert.deepEqual(snapshot, updated);
    assert.ok(JSON.parse(snapshot).rows.every(row => row.lat === 2 && Array.isArray(row.nested.empty)));
    assert.equal(await client.exists(`${prefix}:test:publishing`), 0);
  } finally {release?.(); await cleanup(pipeline, client, prefix);}
});

test('a worker restart resumes a partially published commit without duplicating CMS counts', {timeout: 30000}, async () => {
  const prefix = `gev-batch-test:${randomUUID()}`;
  let pipeline = new RedisPipeline({prefix});
  const {state} = await pipeline.ensure('test');
  const client = (await pipeline.connect()).duplicate(); client.on('error', () => {}); await client.connect();
  const rows = Array.from({length: 60}, (_, id) => ({id: String(id), lat: 2}));
  const packed = pack(rows);
  const token = randomUUID();
  const base = `${prefix}:test`;
  const common = {cohort: 'one', token, epoch: state.epoch};
  const options = payload => ({keys: [state.stream, base, state.cms], arguments: [JSON.stringify(payload), GROUP, '3600', '10000', state.epoch]});
  try {
    await pipeline.project('test', 'one', pack(rows.map(row => ({...row, lat: 1}))));
    await pipeline.close();
    const tx = client.multi();
    for (const record of packed.records) tx.xAdd(state.stream, '*', {kind: 'record', ...common, id: record.id, document: JSON.stringify(entityDocument('test', 'one', record))});
    await tx.execAsPipeline();
    const items = packed.records.map(({id, item, entityKey}) => ({id, item, key: `${base}:entity:${entityKey}`}));
    const metadata = snapshotMetadata({...packed.manifest, token, items});
    const eventId = await client.xAdd(state.stream, '*', {kind: 'commit', ...common, items: JSON.stringify(items), metadata: JSON.stringify(metadata)});
    const [{messages}] = await client.xReadGroup(GROUP, 'local-view', [{key: state.stream, id: '>'}]);
    const records = messages.filter(event => event.message.kind === 'record');
    for (let offset = 0; offset < records.length; offset += 25) await client.eval(STAGE, options(records.slice(offset, offset + 25)));
    const commit = {cohort: 'one', token, eventId, metadata, metadataText: JSON.stringify(metadata)};
    await client.eval(COMMIT, options({...commit, phase: 'begin'}));
    const firstBatch = {...commit, phase: 'publish', offset: 0, items: items.slice(0, 25)};
    await client.eval(COMMIT, options(firstBatch));
    assert.equal(await client.eval(COMMIT, options(firstBatch)), 'replayed');
    assert.deepEqual(await client.sendCommand(['CMS.QUERY', state.cms, '0', '59']), [2, 1]);
    pipeline = new RedisPipeline({prefix});
    await pipeline.ensure('test');
    assert.deepEqual(JSON.parse(await pipeline.snapshot('test', 'one')), {rows});
    assert.deepEqual(await client.sendCommand(['CMS.QUERY', state.cms, '0', '59']), [2, 2]);
    assert.equal((await client.xPending(state.stream, GROUP)).pending, 0);
    assert.equal(await client.exists(`${base}:publishing`), 0);
    assert.deepEqual(await client.keys(`${base}:staging:${token}:*`), []);
  } finally {await cleanup(pipeline, client, prefix);}
});

test('receipt-only ingestion does not assemble and discard a duplicate Redis snapshot', async () => {
  const prefix = `gev-batch-test:${randomUUID()}`;
  const pipeline = new RedisPipeline({prefix});
  const client = (await pipeline.connect()).duplicate(); client.on('error', () => {}); await client.connect();
  try {
    pipeline.snapshot = () => {throw new Error('unexpected readback');};
    await pipeline.project('test', 'one', pack([{id: 'a'}]), '', null, false);
    assert.equal(await client.exists(`${prefix}:test:snapshot:one`), 1);
  } finally {await cleanup(pipeline, client, prefix);}
});

test('a cold progressive snapshot exposes the first batch before the full catalogue is committed', async () => {
  const prefix=`gev-batch-test:${randomUUID()}`;
  const pipeline=new RedisPipeline({prefix});
  const client=(await pipeline.connect()).duplicate();client.on('error',()=>{});await client.connect();
  let release, ready;
  const gate=new Promise(resolve=>{release=resolve;});
  const firstBatch=new Promise(resolve=>{ready=resolve;});
  const run=pipeline.runProjector.bind(pipeline);
  pipeline.runProjector=async (...args)=>{
    const result=await run(...args);
    if(args[3].phase==='publish' && args[3].offset===0){ready();await gate;}
    return result;
  };
  try {
    const project=pipeline.project('test','cold',pack(Array.from({length:80},(_,id)=>({id:String(id)}))));
    await firstBatch;
    assert.equal(JSON.parse(await pipeline.snapshot('test','cold',null,null,null,true)).rows.length,25);
    release();assert.equal(JSON.parse(await project).rows.length,80);
  } finally {release();await cleanup(pipeline,client,prefix);}
});

test('progressive HTTP delivers cached Redis data before its upstream finishes and abort stops intake', async () => {
  const {createServer}=await import('node:http');
  const {redisLayersPlugin}=await import('./plugin.js');
  const {digest}=await import('./payload.js');
  const prefix=`gev-batch-test:${randomUUID()}`;
  let middleware, upstream;
  const server=createServer((req,res)=>{
    if(req.url.startsWith('/api/redis/')){req.url=req.url.slice('/api/redis'.length);void middleware(req,res);}
    else upstream=res;
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const cohort=digest(`${base}/api/adsblol/mil\nGET\n`).slice(0,24);
  const seed=new RedisPipeline({prefix});
  const client=(await seed.connect()).duplicate();client.on('error',()=>{});await client.connect();
  await seed.project('military',cohort,packBody(Buffer.from('{"ac":[{"hex":"cached","flight":"CACHED","lat":32,"lon":34}]}'),'application/json'));
  await seed.close();
  const plugin=redisLayersPlugin({pipelineOptions:{prefix}});
  plugin.configureServer({httpServer:server,middlewares:{use:(path,fn)=>{middleware=fn;}}});
  try {
    const controller=new AbortController();
    const response=await fetch(`${base}/api/redis/ingest`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({layer:'military',url:'/api/adsblol/mil',progressive:true}),signal:controller.signal});
    const reader=response.body.getReader();
    const packet=JSON.parse(new TextDecoder().decode((await reader.read()).value).split('\n')[0]);
    const cached=await (await fetch(base+packet.snapshotUrl)).json();
    assert.equal(cached.ac[0].hex,'cached');
    const heartbeat=JSON.parse(new TextDecoder().decode((await reader.read()).value).trim());
    assert.deepEqual(heartbeat,{heartbeat:true},'waiting for upstream is not projection progress');
    controller.abort();await delay(80);
    upstream?.end('{"ac":[{"hex":"late"}]}');await delay(80);
    assert.equal(await client.xLen(`${prefix}:military:stream`),2,'aborted source never enters the Stream');
  } finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await plugin.closeBundle();
    await client.sendCommand(['FT.DROPINDEX',`${prefix}:military:idx`]).catch(()=>{});
    const keys=await client.keys(`${prefix}:*`);if(keys.length)await client.unlink(keys);await client.close();
  }
});
