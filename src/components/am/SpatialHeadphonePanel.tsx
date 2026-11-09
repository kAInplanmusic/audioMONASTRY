import React,{useCallback,useEffect,useRef,useState} from 'react';
import {audioEngine} from '../../utils/audioEngine';
import {planClubSpeakers,type SpatialClubCount} from '../../core/spatial/v2/clubPlanner';
import {LocalV2SpatialMonitorController} from '../../audio/spatial/localV2SpatialMonitorController';

/** Local-only spatial headphone control, never changes shared session state. */
export function SpatialHeadphonePanel({positions,spatialEnabled}:{positions:Record<string,{x:number;y:number;on:boolean}>;spatialEnabled:boolean}){
  const controller=useRef<LocalV2SpatialMonitorController|null>(null);
  if(!controller.current)controller.current=new LocalV2SpatialMonitorController(audioEngine.v2LiveSink);
  const [channels,setChannels]=useState<SpatialClubCount>(16);
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  const [deviceId,setDeviceId]=useState('');
  const [status,setStatus]=useState<'off'|'starting'|'on'|'error'>('off');
  const [error,setError]=useState('');
  const [deviceRevision,setDeviceRevision]=useState(0);
  const positionsRef=useRef(positions);
  positionsRef.current=positions;
  const generation=useRef(0);
  const mounted=useRef(true);
  const plan=useCallback(()=>planClubSpeakers({widthM:8,depthM:8,satellites:channels}),[channels]);
  const loadDevices=useCallback(async()=>{
    if(!navigator.mediaDevices?.enumerateDevices){setDevices([]);return;}
    try{
      const found=await navigator.mediaDevices.enumerateDevices();
      setDevices(found.filter(d=>d.kind==='audiooutput'));
      setDeviceRevision(v=>v+1);
    }catch{setDevices([]);}
  },[]);
  useEffect(()=>{
    void loadDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange',loadDevices);
    mounted.current=true;
    return ()=>{
      mounted.current=false;
      generation.current++;
      navigator.mediaDevices?.removeEventListener?.('devicechange',loadDevices);
      controller.current?.stop();
    };
  },[loadDevices]);
  // No manual on/off: a specifically selected local headphone output is the
  // authoritative routing signal. Never infer headphones from the default device.
  useEffect(()=>{
    const ticket=++generation.current;
    const c=controller.current!;
    const device=devices.find(d=>d.deviceId===deviceId);
    const headphoneReady=Boolean(spatialEnabled&&deviceId&&device&&
      /headphone|headset|kopfhörer|earbud|airpods|buds|xm[3456]/i.test(device.label)&&
      typeof SharedArrayBuffer!=='undefined'&&
      typeof crossOriginIsolated!=='undefined'&&crossOriginIsolated&&
      audioEngine.v2LiveSink.isConnected);
    if(!headphoneReady){
      c.stop();
      setStatus('off');setError('');
      return;
    }
    setStatus('starting');setError('');
    const selectedDeviceId=deviceId;
    let cancelled=false;
    const activate=async()=>{
      try{
        await c.startOnDevice(plan(),selectedDeviceId);
        if(cancelled||ticket!==generation.current){c.stop();return;}
        for(const [track,pos] of Object.entries(positionsRef.current)){
          if(pos.on&&/^channel[1-8]$/.test(track))
            audioEngine.v2LiveSink.setSpatialTrackPosition(track as import('../../core/audio/V2StudioGraph').V2Channel,{x:pos.x*3.5,y:pos.y*3.5});
        }
        if(mounted.current){setStatus('on');setBusy(false);}
      }catch(e){
        if(!cancelled&&mounted.current&&ticket===generation.current){
          c.stop();setStatus('error');setBusy(false);
          setError(e instanceof Error?e.message:String(e));
        }
      }
    };
    void activate();
    return ()=>{
      cancelled=true;
      generation.current++;
      c.stop();
    };
  },[spatialEnabled,deviceId,channels,deviceRevision,plan,devices]);
  return <section aria-label="Spatial-Kopfhörermonitor" style={{border:'1px solid var(--am-border, #666)',borderRadius:8,padding:12,marginTop:12}}>
    <strong>Virtual Club · Kopfhörer</strong>
    <p className="am-hint">Automatisch: Spatial + erkannter Kopfhörer-Ausgang → binaural. Sonst Stereo. Kein manueller Monitor-Schalter.</p>
    <label className="am-lbl" htmlFor="spatial-monitor-channels">Lautsprecher</label>
    <select id="spatial-monitor-channels" className="am-sel" value={channels} onChange={e=>setChannels(Number(e.target.value) as SpatialClubCount)}>
      {[12,16,24,32].map(n=><option key={n} value={n}>{n} Kanäle</option>)}
    </select>
    <label className="am-lbl" htmlFor="spatial-monitor-device" style={{display:'block',marginTop:8}}>Kopfhörer-Ausgabe</label>
    <select id="spatial-monitor-device" className="am-sel" value={deviceId} disabled={busy} onChange={e=>setDeviceId(e.target.value)}>
      <option value="">Standard-Audioausgang</option>
      {devices.map((d,i)=><option key={d.deviceId||i} value={d.deviceId}>{d.label||`Audioausgang ${i+1}`}</option>)}
    </select>
    <button type="button" className="am-tg" onClick={()=>void loadDevices()} style={{marginTop:8}}>Geräte aktualisieren</button>
    <p role="status" aria-live="polite" className="am-hint">{status==='on'?'Automatisch: Binaural':status==='starting'?'Kopfhörer-Monitor wird verbunden':status==='error'?'Stereo-Fallback (Binaural nicht verfügbar)':'Automatisch: Stereo'}</p>
    {error&&<p role="alert" style={{color:'#ff8585'}}>{error}</p>}
  </section>;
}
