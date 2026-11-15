import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { BackendMainWorkerClient, type WorkerBlock } from '../server/backendMainWorkerClient';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
it('catches up a 500ms delayed wake without skipping any output frames', async () => {
  const blocks: WorkerBlock[] = []; let failure: Error | undefined;
  const worker = new BackendMainWorkerClient(96000, { block: b => { blocks.push(b); worker.ack(b.pcm.byteLength); }, error: e => { failure = e; } });
  try {
    await worker.ready; await wait(220); worker.testDelay(500); await wait(850);
    expect(failure).toBeUndefined(); expect(blocks.length).toBeGreaterThanOrEqual(9);
    for (let i = 0; i < blocks.length; i++) expect(blocks[i].startFrame).toBe(i * 9600);
    expect(blocks.at(-1)!.lagMs).toBeLessThan(100);
    expect(Math.max(...blocks.map(b => b.lagMs))).toBeGreaterThan(200);
  } finally { worker.close(); }
});
it('rejects the unchanged two-second ahead bound with the actual worker mixer', async () => {
  const worker = new BackendMainWorkerClient(96000, { block: b => worker.ack(b.pcm.byteLength), error: () => {} });
  try {
    await worker.ready; const {frame} = await worker.state();
    await expect(worker.enqueue('song', 0, frame + 192000, new Uint8Array(6))).rejects.toThrow('out-of-window');
    await expect(worker.enqueue('song', 1, frame + 96000, new Uint8Array(6))).resolves.toBeDefined();
  } finally { worker.close(); }
});
it('reports a crash and never automatically restarts the worker epoch', async () => {
  let errors = 0; const worker = new BackendMainWorkerClient(96000, {block:b=>worker.ack(b.pcm.byteLength),error:()=>{errors++;}});
  await worker.ready; worker.testCrash(); await wait(200);
  expect(errors).toBe(1); await expect(worker.state()).rejects.toThrow('closed'); worker.close();
});
it('continues sample-counted rendering while the HTTP thread is blocked for 250ms', async () => {
  const blocks: WorkerBlock[] = []; const worker = new BackendMainWorkerClient(96000, {block:b=>{blocks.push(b);worker.ack(b.pcm.byteLength);},error:()=>{}});
  try { await worker.ready; await wait(120); const before=blocks.length;
    const end=performance.now()+250; while(performance.now()<end) { /* Deliberate HTTP/main-thread starvation. */ }
    await wait(80); expect(blocks.length-before).toBeGreaterThanOrEqual(2);
    for(let i=1;i<blocks.length;i++)expect(blocks[i].startFrame).toBe(blocks[i-1].startFrame+9600);
  } finally {worker.close();}
});

it('boots from the same ESM eval entrypoint used by the real App server', async () => {
  const {stdout} = await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',`import { BackendMainWorkerClient } from './server/backendMainWorkerClient.ts';const w=new BackendMainWorkerClient(96000,{block:b=>w.ack(b.pcm.byteLength),error:e=>{console.error(e);process.exitCode=1;}});await w.ready;console.log('ready');w.close();`],{timeout:5000});
  expect(stdout).toContain('ready');
});
