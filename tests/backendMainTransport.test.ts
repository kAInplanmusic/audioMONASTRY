import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { attachBackendMainTransport } from '../server/backendMainTransport';
import { encodeBackendMainInput } from '../src/core/transport/backendMainProtocol';

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });
it('authenticates upgrades and revokes contributor access before accepting another packet', async () => {
  const server = createServer(); let authorized = true;
  const transport = attachBackendMainTransport(server, { authenticate: req => req.headers.cookie === 'session=ok' ? 'user' : null, authorize: access => authorized && access.session === 'studio' && access.plugin === 'synth' });
  closers.push(() => { transport.close(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as {port: number}).port;
  const url = `ws://127.0.0.1:${port}/api/main-audio?role=contributor&session=studio&plugin=synth`;
  const denied = new WebSocket(url); denied.on('error', () => {}); await new Promise<void>(resolve => denied.on('close', () => resolve()));
  const ws = new WebSocket(url, { headers: { cookie: 'session=ok' } }); ws.on('error', () => {}); closers.push(() => ws.terminate());
  const [ready] = await once(ws, 'message'); const frame = JSON.parse(ready.toString()).frame;
  authorized = false;
  ws.send(encodeBackendMainInput(0, frame + 1000, new Uint8Array(6)));
  const [code] = await once(ws, 'close'); expect(code).toBe(1008);
});

it('falls back after a slow FLAC encode with continuous, byte-exact PCM24 chunks', async () => {
  const server = createServer(); let encodes = 0;
  const transport = attachBackendMainTransport(server, {
    authenticate: () => 'user', authorize: () => true,
    encodeFlac: async () => { encodes++; await new Promise(resolve => setTimeout(resolve, 150)); return Buffer.from('fLaC'); },
  });
  closers.push(() => { transport.close(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as {port: number}).port;
  const base = `ws://127.0.0.1:${port}/api/main-audio?session=studio`;
  const receiver = new WebSocket(`${base}&role=pa`); receiver.on('error', () => {}); closers.push(() => receiver.terminate());
  const output: Array<{meta: any; data: Buffer}> = []; let pending: any;
  receiver.on('message', (data, binary) => { if (!binary) { const m = JSON.parse(data.toString()); if (m.type === 'chunk') pending = m; } else if (pending) { output.push({ meta: pending, data: Buffer.from(data as Buffer) }); pending = undefined; } });
  await once(receiver, 'open');
  const contributor = new WebSocket(`${base}&role=contributor&plugin=synth`); contributor.on('error', () => {}); closers.push(() => contributor.terminate());
  const [ready] = await once(contributor, 'message');
  const start = JSON.parse(ready.toString()).frame + 28800;
  const pcm = Buffer.alloc(9600 * 6); for (let i = 0; i < pcm.length; i += 3) pcm.writeIntLE(i % 2 ? -7654321 : 1234567, i, 3);
  contributor.send(encodeBackendMainInput(0, start, pcm));
  const deadline = Date.now() + 4000;
  while (!output.some(chunk => chunk.meta.startFrame === start) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  expect(output.length).toBeGreaterThan(1); expect(encodes).toBe(1);
  expect(output[0].meta.format).toBe('flac');
  const raw = output.find(chunk => chunk.meta.startFrame === start)!;
  expect(raw.meta.format).toBe('s24le'); expect(raw.meta.fallbackReason).toBe('encoder-delayed'); expect(raw.meta.encodeMs).toBeGreaterThan(80); expect(raw.data).toEqual(pcm);
  for (let i = 1; i < output.length; i++) { expect(output[i].meta.sequence).toBe(output[i - 1].meta.sequence + 1); expect(output[i].meta.startFrame).toBe(output[i - 1].meta.startFrame + output[i - 1].meta.frames); }
});

it('keeps a valid contributor against duplicates and replaces it after authority changes', async () => {
  const server = createServer(); let owner = 'alice';
  const transport = attachBackendMainTransport(server, {
    authenticate: req => String(req.headers.cookie), authorize: access => access.principal === owner,
    encoding: 'pcm24',
  });
  closers.push(() => { transport.close(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}/api/main-audio?role=contributor&session=studio&plugin=eq`;
  const connect = (user: string) => { const ws = new WebSocket(url, { headers: { cookie: user } }); ws.on('error', () => {}); closers.push(() => ws.terminate()); return ws; };
  const old = connect('alice'); await once(old, 'message');
  const duplicate = connect('alice'); await new Promise<void>(resolve => duplicate.on('close', () => resolve()));
  expect(old.readyState).toBe(WebSocket.OPEN);
  owner = 'bob';
  const oldClosed = once(old, 'close');
  const replacement = connect('bob'); await once(replacement, 'message'); await oldClosed;
  expect(replacement.readyState).toBe(WebSocket.OPEN);
  const another = connect('bob'); await new Promise<void>(resolve => another.on('close', () => resolve()));
  expect(replacement.readyState).toBe(WebSocket.OPEN);
});

it('serializes packets while authorization is asynchronous', async () => {
  const server = createServer(); let calls = 0;
  const transport = attachBackendMainTransport(server, {
    authenticate: () => 'alice', authorize: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 15)); return true; }, encoding: 'pcm24',
  });
  closers.push(() => { transport.close(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/main-audio?role=contributor&session=studio&plugin=eq`);
  ws.on('error', () => {}); closers.push(() => ws.terminate());
  const [ready] = await once(ws, 'message'); const frame = JSON.parse(ready.toString()).frame + 1000;
  ws.send(encodeBackendMainInput(0, frame, new Uint8Array(6)));
  ws.send(encodeBackendMainInput(1, frame + 1, new Uint8Array(6)));
  await new Promise(resolve => setTimeout(resolve, 70));
  expect(ws.readyState).toBe(WebSocket.OPEN); expect(calls).toBeGreaterThanOrEqual(4);
});

it('closes output connections on worker crash and refuses a silent new epoch', async () => {
  const server=createServer();let crash: (()=>void)|undefined;
  const transport=attachBackendMainTransport(server,{authenticate:()=> 'alice',authorize:()=>true,encoding:'pcm24',onWorkerCreated:w=>{crash=()=>w.testCrash();}});
  closers.push(()=>{transport.close();server.close();});server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`ws://127.0.0.1:${(server.address() as {port:number}).port}/api/main-audio?session=crash&role=pa`;
  const ws=new WebSocket(url);ws.on('error',()=>{});closers.push(()=>ws.terminate());await once(ws,'message');
  const closed=once(ws,'close');crash!();const [code]=await closed;expect(code).toBe(1011);
  const again=new WebSocket(url);again.on('error',()=>{});await new Promise<void>(resolve=>again.on('close',()=>resolve()));expect(again.readyState).toBe(WebSocket.CLOSED);
});
