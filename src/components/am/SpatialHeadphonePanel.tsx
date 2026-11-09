import React,{useCallback,useEffect,useRef,useState} from 'react';
import {audioEngine} from '../../utils/audioEngine';
import {planClubSpeakers,type SpatialClubCount} from '../../core/spatial/v2/clubPlanner';
import {LocalV2SpatialMonitorController} from '../../audio/spatial/localV2SpatialMonitorController';

/** Local-only spatial headphone control, never changes shared session state. */
export function SpatialHeadphonePanel(){
  const controller=useRef<LocalV2SpatialMonitorController|null>(null);
  if(!controller.current)controller.current=new LocalV2SpatialMonitorController(audioEngine.v2LiveSink);
  const [channels,setChannels]=useState<SpatialClubCount>(16);
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  const [deviceId,setDeviceId]=useState('');
  const [status,setStatus]=useState<'off'|'starting'|'on'|'error'>('off');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [generation,setGeneration]=useState(0);
  const plan=useCallback(()=>planClubSpeakers({widthM:8,depthM:8,satellites:channels}),[channels]);
  const loadDevices=useCallback(async()=>{
    if(!navigator.mediaDevices?.enumerateDevices){setDevices([]);return;}
    try{
      const found=await navigator.mediaDevices.enumerateDevices();
      setDevices(found.filter(d=>d.kind==='audiooutput'));
    }catch{setDevices([]);}
  },[]);
  useEffect(()=>{
    void loadDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange',loadDevices);
    return ()=>{
      navigator.mediaDevices?.removeEventListener?.('devicechange',loadDevices);
      controller.current?.stop();
    };
  },[loadDevices]);
  const stop=()=>{
    setGeneration(v=>v+1);
    controller.current?.stop();
    setStatus('off');setError('');setBusy(false);
  };
  const start=async()=>{
    if(busy)return;
    setBusy(true);setStatus('starting');setError('');
    const ticket=generation+1;setGeneration(ticket);
    try{
      const c=controller.current!;
      if(deviceId)await c.startOnDevice(plan(),deviceId);
      else await c.start(plan());
      if(!c.isActive)throw new Error('Monitor not active');
      setStatus('on');
    }catch(e){
      controller.current?.stop();
      setStatus('error');setError(e instanceof Error?e.message:String(e));
    }finally{setBusy(false);}
  };
  const changeChannels=(value:SpatialClubCount)=>{
    if(status==='on'||status==='starting')stop();
    setChannels(value);
  };
  return <section aria-label="Spatial-Kopfhörermonitor" style={{border:'1px solid var(--am-border, #666)',borderRadius:8,padding:12,marginTop:12}}>
    <strong>Virtual Club · Kopfhörer</strong>
    <p className="am-hint">Lokales binaurales Monitoring (ITD/ILD). Benötigt SharedArrayBuffer und Cross-Origin-Isolation. Master bleibt unverändert.</p>
    <label className="am-lbl" htmlFor="spatial-monitor-channels">Lautsprecher</label>
    <select id="spatial-monitor-channels" className="am-sel" value={channels} disabled={busy} onChange={e=>changeChannels(Number(e.target.value) as SpatialClubCount)}>
      {[12,16,24,32].map(n=><option key={n} value={n}>{n} Kanäle</option>)}
    </select>
    <label className="am-lbl" htmlFor="spatial-monitor-device" style={{display:'block',marginTop:8}}>Kopfhörer-Ausgabe</label>
    <select id="spatial-monitor-device" className="am-sel" value={deviceId} disabled={busy} onChange={e=>{if(status==='on')stop();setDeviceId(e.target.value);}}>
      <option value="">Standard-Audioausgang</option>
      {devices.map((d,i)=><option key={d.deviceId||i} value={d.deviceId}>{d.label||`Audioausgang ${i+1}`}</option>)}
    </select>
    <div style={{display:'flex',gap:8,marginTop:10}}>
      <button type="button" className="am-tg" onClick={()=>void loadDevices()} disabled={busy}>Geräte suchen</button>
      <button type="button" className="am-tg" disabled={busy&&status!=='starting'} onClick={()=>status==='on'||status==='starting'?stop():void start()}>
        {status==='on'?'Monitor AUS':status==='starting'?'Abbrechen':'Monitor EIN'}
      </button>
    </div>
    <p role="status" aria-live="polite" className="am-hint">{status==='on'?'Binaural aktiv':status==='starting'?'Verbindung wird aufgebaut':status==='error'?'Verbindung fehlgeschlagen':'Binaural aus'}</p>
    {error&&<p role="alert" style={{color:'#ff8585'}}>{error}</p>}
  </section>;
}
