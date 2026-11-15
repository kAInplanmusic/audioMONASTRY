import { useEffect, useRef, useState } from 'react';
import { Radio, Volume2 } from 'lucide-react';
import { webRTCManager } from '../utils/WebRTCManager';
import { BackendMainPlayback, connectBackendMain } from '../core/transport/backendMainClient';

/** Dedicated PA output: server-rendered FLAC; Socket.IO retains endpoint membership only. */
export const MasterOutPage = () => {
  const [state, setState] = useState<'connecting'|'waiting'|'live'|'error'>('connecting');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState({sampleRate:0,channels:0});
  const [activated, setActivated] = useState(false);
  const [codec, setCodec] = useState('FLAC');
  const activeRef = useRef(false);
  const rateRef = useRef(0);
  const playback = useRef(new BackendMainPlayback());
  useEffect(() => webRTCManager.onOutputBusy(() => setBusy(true)), []);
  useEffect(() => {webRTCManager.sendEndpointReport({state,sampleRate:format.sampleRate,channels:format.channels});}, [state,format]);
  useEffect(() => {
    const player=playback.current;
    let socket:WebSocket|null=null, cancelled=false, connecting=false, failed=false;
    const fail=(cause:Error)=>{if(cancelled||failed)return;failed=true;setError(cause.message);setState('error');socket?.close();void player.close();};
    const connect=async()=>{
      if(connecting||socket||cancelled)return;connecting=true;
      try {
        const ticket=await webRTCManager.requestBackendMainTicket('pa');
        if(cancelled)return;
        socket=connectBackendMain(ticket,{
          ready: info=>{if(failed||cancelled)return;rateRef.current=info.sampleRate;setFormat({sampleRate:info.sampleRate,channels:info.channels});setState('waiting');if(activeRef.current)void player.activate(info.sampleRate).catch(fail);},
          chunk:async(meta,flac)=>{setCodec(meta.format==='s24le'?'PCM':'FLAC');if(!activeRef.current||failed||cancelled)return;const played=await player.play(meta,flac);if(played&&!cancelled&&!failed)setState('live');},
          error:fail,
        }, url=>webRTCManager.createBackendMainSocket(url));
        socket.onclose=()=>{if(!cancelled)fail(new Error('Backend Main connection closed'));};
      }catch(cause){fail(cause instanceof Error?cause:new Error(String(cause)));}finally{connecting=false;}
    };
    const progressTimer=setInterval(()=>{const report=player.progress();if(!failed&&!cancelled&&report&&socket?.readyState===WebSocket.OPEN&&socket.bufferedAmount<1024)socket.send(JSON.stringify(report));},100);
    webRTCManager.onSessionUpdate=info=>{if(info.joined)void connect();};
    return()=>{clearInterval(progressTimer);cancelled=true;webRTCManager.onSessionUpdate=()=>{};socket?.close();void player.close();};
  }, []);
  const activate=async()=>{
    activeRef.current=true;setActivated(true);
    if(rateRef.current){try{await playback.current.activate(rateRef.current);}catch(cause){setError(String(cause));setState('error');}}
  };
  return <main className="fixed inset-0 bg-black text-white flex flex-col items-center justify-center gap-6">
    {busy&&<div role="alert" data-testid="output-busy">Der Main-Ausgang Audio ist schon auf einem anderen Gerät geöffnet.</div>}
    <div className="flex items-center gap-3"><Radio/><h1>MASTER OUT</h1></div>
    <p>{state==='connecting'?'Verbinde mit Studio …':state==='waiting'?'Backend-Main verbunden — Audio aktivieren':state==='live'?'Backend-Main aktiv':'Ausgabe gestoppt'}</p>
    {format.sampleRate>0&&<p>{format.sampleRate/1000} kHz · {format.channels} Kanäle · {codec} 24 Bit</p>}
    {!activated&&<button onClick={()=>void activate()} className="px-6 py-3 rounded bg-cyan-700"><Volume2/>Main-Ausgabe aktivieren</button>}
    {error&&<p role="alert">{error}</p>}
  </main>;
};
