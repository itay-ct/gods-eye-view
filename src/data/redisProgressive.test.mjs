import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readWhileIngesting} from './redisProgressive.js';

test('cached Redis data returns before ingestion finishes, then completion schedules a refresh', async () => {
  const lifetime=new AbortController(); let writer, refreshed=0, starts=0;
  const stream=new ReadableStream({start(controller){writer=controller;}});
  const encode=value=>new TextEncoder().encode(JSON.stringify(value)+'\n');
  const options={lifetime:lifetime.signal, signal:lifetime.signal,
    start:async()=>{starts++;return new Response(stream);},
    read:async receipt=>{assert.match(receipt.snapshotUrl,/snapshot/);return Response.json({ac:[{hex:'cached'}]});},
    onReceipt:()=>{},onProgress:()=>refreshed++,onError:error=>{throw error;}};
  const first=readWhileIngesting('warm-test',options);
  writer.enqueue(encode({snapshotUrl:'/api/redis/snapshot?layer=military',headers:{}}));
  assert.equal((await (await first).json()).ac[0].hex,'cached');
  await readWhileIngesting('warm-test',options);
  assert.equal(starts,1,'repeated refreshes must share the active ingestion');
  writer.enqueue(encode({done:true})); writer.close();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(refreshed>0);
});

test('cold reads wait for the first batch, not for the final commit', async () => {
  const lifetime=new AbortController();let writer,reads=0;
  const stream=new ReadableStream({start(controller){writer=controller;}});
  const first=readWhileIngesting('cold-test',{lifetime:lifetime.signal, signal:lifetime.signal,
    start:async()=>new Response(stream),
    read:async()=>++reads===1 ? Response.json({pending:true},{status:202}) : Response.json({rows:[{id:'first-batch'}]}),
    onReceipt:()=>{},onProgress:()=>{},onError:()=>{}});
  writer.enqueue(new TextEncoder().encode('{"snapshotUrl":"/api/redis/snapshot?layer=test","headers":{}}\n'));
  assert.equal((await (await first).json()).rows[0].id,'first-batch');
  writer.enqueue(new TextEncoder().encode('{"done":true}\n'));writer.close();
});
