import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach,expect,it } from 'vitest';
import { WebSocket } from 'ws';
import { attachBackendMainTransport } from '../server/backendMainTransport';
import { encodeBackendMainInput } from '../src/core/transport/backendMainProtocol';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const closers:Array<()=>void>=[];
afterEach(()=>{for(const close of closers.splice(0))close();});
it('does not turn 80ms acknowledgement latency into a per-source 12.5 packet/s limit',async()=>{
 const server=createServer();let admitted=0;
 const transport=attachBackendMainTransport(server,{authenticate:()=> 'alice',authorize:()=>true,encoding:'pcm24',onWorkerCreated:worker=>{
  const enqueue=worker.enqueue.bind(worker);worker.enqueue=async(...args:Parameters<typeof enqueue>)=>{const result=await enqueue(...args);admitted++;await wait(80);return result;};
 }});closers.push(()=>{transport.close();server.close();});server.listen(0,'127.0.0.1');await once(server,'listening');
 const ws=new WebSocket(`ws://127.0.0.1:${(server.address()as{port:number}).port}/api/main-audio?session=pipeline&role=contributor&plugin=song`);ws.on('error',()=>{});closers.push(()=>ws.terminate());
 const [data]=await once(ws,'message');const ready=JSON.parse(data.toString());
 for(let sequence=0;sequence<80;sequence++)ws.send(encodeBackendMainInput(sequence,ready.frame+96000+sequence*960,new Uint8Array(960*6)));
 await wait(1700);expect(admitted).toBe(80);expect(ws.readyState).toBe(WebSocket.OPEN);
});
it('counts unacknowledged packets against the same 128-packet budget',async()=>{
 const server=createServer();
 const transport=attachBackendMainTransport(server,{authenticate:()=> 'alice',authorize:()=>true,encoding:'pcm24',onWorkerCreated:worker=>{
  const enqueue=worker.enqueue.bind(worker);worker.enqueue=async(...args:Parameters<typeof enqueue>)=>{await enqueue(...args);return new Promise(()=>{});};
 }});closers.push(()=>{transport.close();server.close();});server.listen(0,'127.0.0.1');await once(server,'listening');
 const ws=new WebSocket(`ws://127.0.0.1:${(server.address()as{port:number}).port}/api/main-audio?session=budget&role=contributor&plugin=song`);ws.on('error',()=>{});closers.push(()=>ws.terminate());
 const [data]=await once(ws,'message');const ready=JSON.parse(data.toString());const closed=once(ws,'close');
 for(let sequence=0;sequence<129;sequence++)ws.send(encodeBackendMainInput(sequence,ready.frame+96000+sequence,new Uint8Array(6)));
 const [code]=await closed;expect(code).toBe(1008);
});
