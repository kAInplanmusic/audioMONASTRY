import { describe, expect, it } from 'vitest';
import { routeMonitorSignal, type MonitorParticipant } from '../server/monitorSignaling';
const audio = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n';
const participants: MonitorParticipant[] = [
 { userId:'owner',sessionId:'room',mode:'member',socketId:'owner-socket' },
 { userId:'dj',sessionId:'room',mode:'member',socketId:'dj-socket' },
 { userId:'other',sessionId:'room',mode:'member',socketId:'other-socket' },
 { userId:'pa',sessionId:'room',mode:'master-out',socketId:'pa-socket' },
 { userId:'outside',sessionId:'another',mode:'member',socketId:'outside-socket' },
];
const actor=(userId:string,mode='member')=>({userId,sessionId:'room',mode});
describe('private monitor relay authority',()=>{
 it('forwards owner offer/member answer/ICE only to the selected member, stamps identity',()=>{
  expect(routeMonitorSignal({type:'offer',targetUserId:'dj',sdp:audio,senderUserId:'forged',sessionId:'forged'},actor('owner'),participants,'owner')).toEqual({ok:true,targetSocketId:'dj-socket',payload:{type:'offer',senderUserId:'owner',targetUserId:'dj',sdp:audio}});
  expect(routeMonitorSignal({type:'answer',targetUserId:'owner',sdp:audio},actor('dj'),participants,'owner').ok).toBe(true);
  expect(routeMonitorSignal({type:'candidate',targetUserId:'owner',candidate:{candidate:'candidate:1',sdpMid:'0',sdpMLineIndex:0,extra:'dropped'}},actor('dj'),participants,'owner')).toMatchObject({ok:true,payload:{candidate:{candidate:'candidate:1',sdpMid:'0',sdpMLineIndex:0}}});
  expect(routeMonitorSignal({type:'candidate',targetUserId:'dj',candidate:null},actor('owner'),participants,'owner').ok).toBe(true);
 });
 it('rejects unjoined, output, cross-session and member-to-member paths',()=>{
  for(const [who,target,type]of [['unknown','owner','answer'],['pa','owner','answer'],['owner','pa','offer'],['owner','outside','offer'],['dj','other','candidate'],['dj','owner','offer'],['owner','dj','answer']]){
   expect(routeMonitorSignal({targetUserId:target,type,sdp:audio,candidate:null},actor(who,who==='pa'?'master-out':'member'),participants,'owner').ok).toBe(false);
  }
 });
 it('rejects video/data SDP, oversized or malformed ICE and stale owner direction',()=>{
  for(const sdp of [audio+'m=video 0 UDP/TLS/RTP/SAVPF 96\r\n',audio+'m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n','v=0\r\n',audio+'x'.repeat(50000)])expect(routeMonitorSignal({targetUserId:'dj',type:'offer',sdp},actor('owner'),participants,'owner').ok).toBe(false);
  expect(routeMonitorSignal({targetUserId:'dj',type:'candidate',candidate:{candidate:'x'.repeat(3000)}},actor('owner'),participants,'owner').ok).toBe(false);
  expect(routeMonitorSignal({targetUserId:'dj',type:'offer',sdp:audio},actor('owner'),participants,'other').ok).toBe(false);
 });
});
