import http from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { expect, it } from 'vitest';
import { createSessionRuntime } from '../server/sessionRuntime';
import { createRealtimeHub } from '../server/realtime';
function event(socket:Socket,name:string){return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(name+' timeout')),5000);socket.once(name,value=>{clearTimeout(timer);resolve(value);});});}
function send(socket:Socket,data:object){return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('monitor ack timeout')),5000);socket.emit('monitor-signal',data,(ack:any)=>{clearTimeout(timer);resolve(ack);});});}
const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n';
it('private real signaling authenticates sender, routes only selected member, excludes ghosts and follows mixer handover',async()=>{
 const runtime=createSessionRuntime(),server=http.createServer();
 const hub=await createRealtimeHub(server,{sessionRuntime:runtime,pluginLockTtlMs:60000,addServerAudit:()=>{},resolveSessionMainOutUserId:()=>runtime.session.lockOwner('mixer')??'',studioTokenMissing:false,studioAuthOpen:true,studioAccessToken:'',studioSessionSecret:'',safeTokenEqual:()=>false,looksLikeStudioSession:()=>false,verifyStudioSession:async()=>false,log:()=>{},warn:()=>{}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address()as import('node:net').AddressInfo).port;
 const sockets:Socket[]=[];
 try{
  for(const [userId,mode]of [['owner','member'],['dj','member'],['other','member'],['pa','master-out'],['unjoined','']]){
   const socket=io(`http://127.0.0.1:${port}`,{path:'/webrtc-signaling/',transports:['websocket'],forceNew:true,autoConnect:false});sockets.push(socket);
   const connected=event(socket,'connect');socket.connect();await connected;
   if(mode){const joined=event(socket,'session-members');socket.emit('join-session',{userId,mode});await joined;}
  }
  const [owner,dj,other,pa,unjoined]=sockets;
  const received:any[][]=sockets.map(()=>[]);sockets.forEach((socket,index)=>socket.on('monitor-signal',data=>received[index].push(data)));
  const forwarded=event(dj,'monitor-signal');expect(await send(owner,{targetUserId:'dj',type:'offer',sdp,senderUserId:'forged'})).toEqual({ok:true});
  expect(await forwarded).toMatchObject({senderUserId:'owner',targetUserId:'dj',type:'offer',sdp});
  await new Promise(r=>setTimeout(r,30));expect(received.map(rows=>rows.length)).toEqual([0,1,0,0,0]);
  const answer=event(owner,'monitor-signal');expect(await send(dj,{targetUserId:'owner',type:'answer',sdp})).toEqual({ok:true});await answer;
  for(const [socket,data]of [[other,{targetUserId:'dj',type:'offer',sdp}],[owner,{targetUserId:'pa',type:'offer',sdp}],[pa,{targetUserId:'owner',type:'answer',sdp}],[unjoined,{targetUserId:'dj',type:'offer',sdp,senderUserId:'owner'}],[owner,{targetUserId:'dj',type:'offer',sdp:sdp+'m=video 9 UDP/TLS/RTP/SAVPF 96\r\n'}]]as const){expect((await send(socket,data)).ok).toBe(false);}
  const transfer=event(other,'plugin-lock');owner.emit('plugin-lock-transfer',{pluginId:'mixer',toUserId:'other'});expect((await transfer).lockedBy).toBe('other');
  expect((await send(owner,{targetUserId:'dj',type:'offer',sdp})).ok).toBe(false);
  const newOwnerOffer=event(dj,'monitor-signal');expect((await send(other,{targetUserId:'dj',type:'offer',sdp})).ok).toBe(true);expect((await newOwnerOffer).senderUserId).toBe('other');
 }finally{sockets.forEach(socket=>socket.disconnect());await hub.close();hub.io.close();runtime.stop();await new Promise<void>(r=>server.close(()=>r()));}
});
