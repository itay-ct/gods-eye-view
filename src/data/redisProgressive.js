// Keep ingestion's response stream open in the background. Closing it cancels
// the server's source request; the layer's lifetime signal owns this connection.
const jobs = new Map();
const pause = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const finish = () => {signal?.removeEventListener('abort', abort); resolve();};
  const timer = setTimeout(finish, ms);
  const abort = () => {clearTimeout(timer); reject(signal.reason);};
  signal?.addEventListener('abort', abort, {once:true});
});
export async function readWhileIngesting(key, {start, read, signal, lifetime, onReceipt, onProgress, onError}) {
  let job = jobs.get(key);
  if (!job || job.done || job.lifetime.aborted) {
    job = {done:false, lifetime, shown:false};
    jobs.set(key, job);
    let resolveReceipt, rejectReceipt;
    job.ready = new Promise((resolve,reject) => {resolveReceipt=resolve; rejectReceipt=reject;});
    void (async () => {
      try {
        const response = await start(lifetime);
        if (!response.ok) {job.completed=true; resolveReceipt({failure:response}); return;}
        const reader = response.body.getReader();
        const decoder = new TextDecoder(); let pending = '';
        while (true) {
          const {done,value} = await reader.read();
          if (done) break;
          pending += decoder.decode(value, {stream:true});
          let newline;
          while ((newline=pending.indexOf('\n')) >= 0) {
            const line=pending.slice(0,newline);pending=pending.slice(newline+1);
            if (!line.trim()) continue;
            const packet=JSON.parse(line);
            if (packet.snapshotUrl) {job.receipt=packet; onReceipt(packet); resolveReceipt(packet);}
            else if (packet.headers && job.receipt) Object.assign(job.receipt.headers, packet.headers);
            if (packet.error) throw new Error(packet.error);
            if (packet.done) job.completed=true;
            if (job.shown && packet.progress && !packet.done) onProgress();
          }
        }
        if (!job.completed) throw new Error('Redis ingestion connection closed before completion');
      } catch (error) {
        job.error=error;rejectReceipt(error);
        if (!lifetime.aborted) onError(error);
      } finally {
        job.done=true;
        if (jobs.get(key)===job) jobs.delete(key);
        if (job.shown && !lifetime.aborted) onProgress();
      }
    })();
  }
  const receipt = await job.ready;
  if (receipt.failure) return receipt.failure;
  while (true) {
    signal?.throwIfAborted(); lifetime.throwIfAborted();
    const response = await read(receipt, signal);
    if (response.status !== 202) {job.shown=true; if(job.done) onProgress(); return response;}
    if (job.error) throw job.error;
    await pause(100, signal);
  }
}
