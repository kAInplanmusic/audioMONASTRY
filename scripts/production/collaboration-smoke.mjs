// Runs inside the existing app container; leaves plugin/audio parameters untouched.
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
const base='http://127.0.0.1:8080';
const token=process.env.STUDIO_ACCESS_TOKEN;
const headers={'x-studio-token':token};
const sockets=[];
function once(socket,event) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('EVENT_TIMEOUT')),10000);
    socket.once(event,data=>{clearTimeout(timer);resolve(data)});
  });
}
try {
  const online=await fetch(base+'/api/online',{headers}).then(r=>r.json());
  assert.equal(online.online,0,'ACTIVE_SESSION_PRESENT');
  const latencies=[];
  await Promise.all(Array.from({length:4},async()=>{
    for(let n=0;n<15;n++) {
      const start=performance.now();
      const response=await fetch(base+'/api/health',{headers});
      assert.equal(response.status,200);
      assert.equal((await response.json()).status,'ok');
      latencies.push(performance.now()-start);
    }
  }));
  for(let i=0;i<5;i++) {
    const socket=io(base,{path:'/webrtc-signaling',transports:['websocket'],reconnection:false,auth:{token},timeout:10000});
    sockets.push(socket);
    await Promise.race([once(socket,'connect'),once(socket,'connect_error').then(()=>{throw Error('SOCKET_AUTH_FAILED')})]);
    const joined=once(socket,i<4?'session-members':'session-full');
    socket.emit('join-session',{userId:'deployment-smoke-'+i});
    const state=await joined;
    if(i===4)assert.equal(state.max,4);
  }
  for(const socket of sockets.slice(0,4)) {
    for(let i=0;i<10;i++) {
      const t0=Date.now();
      const reply=await new Promise((resolve,reject)=>socket.timeout(5000).emit('clock-ping',{t0},(error,data)=>error?reject(Error('CLOCK_TIMEOUT')):resolve(data)));
      assert.equal(reply.t0,t0);
      assert.ok(Number.isFinite(reply.t1)&&reply.t2>=reply.t1);
    }
  }
  latencies.sort((a,b)=>a-b);
  console.log(JSON.stringify({passed:true,healthRequests:latencies.length,httpP95Ms:Math.round(latencies[Math.ceil(latencies.length*.95)-1]),collaboratingUsers:4,fifthUserRejected:true,clockExchanges:40}));
} catch(error) {
  console.log(JSON.stringify({passed:false,errorCode:error.message==='ACTIVE_SESSION_PRESENT'?'ACTIVE_SESSION_PRESENT':'COLLABORATION_SMOKE_FAILED'}));
  process.exitCode=1;
} finally {
  for(const socket of sockets)socket.disconnect();
}
