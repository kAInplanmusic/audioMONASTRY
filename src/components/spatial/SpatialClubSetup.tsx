import React, {useEffect,useMemo,useState} from 'react';
import {spatialMeterBridge} from '../../core/spatial/v2/meterBridge';
import type {VirtualFrame} from '../../core/spatial/v2/virtualInterface';
import {SpatialLiveVisualizer} from './SpatialLiveVisualizer';
import {planClubSpeakers,createChannelProbeSchedule,SPATIAL_CLUB_COUNTS,type SpatialClubCount} from '../../core/spatial/v2/clubPlanner';
import {storageGetJson,storageSetJson} from '../../utils/storage';

const KEY='spatialmonk-club-setup-v3';
interface Prefs {
  widthM:number; depthM:number; satellites:SpatialClubCount; subs:0|1|2;
  lockStereo:boolean; leftX:number;leftY:number;rightX:number;rightY:number;
}
const DEFAULT:Prefs={widthM:8,depthM:8,satellites:16,subs:0,lockStereo:false,
  leftX:-2,leftY:4,rightX:2,rightY:4};
const load=():Prefs=>{
  try{
    const v=storageGetJson<Partial<Prefs>>(KEY);
    if(!v)return DEFAULT;
    return {...DEFAULT,...v,
      widthM:typeof v.widthM==='number'&&Number.isFinite(v.widthM)&&v.widthM>=1&&v.widthM<=100?v.widthM:8,
      depthM:typeof v.depthM==='number'&&Number.isFinite(v.depthM)&&v.depthM>=1&&v.depthM<=100?v.depthM:8,
      satellites:SPATIAL_CLUB_COUNTS.includes(v.satellites as SpatialClubCount)?v.satellites as SpatialClubCount:16,
      subs:[0,1,2].includes(v.subs as number)?v.subs as 0|1|2:0};
  }catch{return DEFAULT;}
};
export function SpatialClubSetup({disabled=false,onLayoutChange}:{
  disabled?:boolean;onLayoutChange?:(id:string)=>void;
}){
  const [expanded,setExpanded]=useState(false);
  const [prefs,setPrefs]=useState<Prefs>(load);
  const [showTable,setShowTable]=useState(false);
  const [visualizerOpen,setVisualizerOpen]=useState(false);
  const [meterFrame,setMeterFrame]=useState<VirtualFrame|null>(null);
  useEffect(()=>{
    spatialMeterBridge.configure(prefs.satellites);
    return spatialMeterBridge.subscribe(setMeterFrame);
  },[prefs.satellites]);
  const update=(patch:Partial<Prefs>)=>setPrefs(old=>{const next={...old,...patch};try{storageSetJson(KEY,next);}catch{}return next;});
  const result=useMemo(()=>{
    try{return {plan:planClubSpeakers({widthM:prefs.widthM,depthM:prefs.depthM,
      satellites:prefs.satellites,subwoofers:prefs.subs,
      fixedSpeakers:prefs.lockStereo?[
        {id:'L',positionM:{x:prefs.leftX,y:prefs.leftY}},
        {id:'R',positionM:{x:prefs.rightX,y:prefs.rightY}},
      ]:[]}),error:''};}
    catch(e){return {plan:null,error:e instanceof Error?e.message:'Invalid setup'};}
  },[prefs]);
  const plan=result.plan;
  const setNumber=(key:keyof Prefs,value:string)=>{
    if(value.trim()==='')return;
    const n=Number(value);if(Number.isFinite(n))update({[key]:n} as Partial<Prefs>);
  };
  const scale=Math.min(340/prefs.widthM,340/prefs.depthM);
  const roomW=prefs.widthM*scale,roomH=prefs.depthM*scale;
  const x0=200-roomW/2,y0=200-roomH/2;
  const toX=(x:number)=>200+x*scale;
  const toY=(y:number)=>200-y*scale;
  return <div style={{display:'grid',gap:8}}>
    <button type="button" className="am-tg" onClick={()=>setExpanded(x=>!x)}
      aria-expanded={expanded}>RAUM & LS SETUP {expanded?'▴':'▾'}</button>
    {expanded&&<>
      <div className="am-hint">Automatischer Club-Plan · X/Y getrennt · Ohrhöhe · keine Hardwareausgabe</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
        <label className="am-lbl">X · Breite (m)
          <input className="am-sel" type="number" min={1} max={100} step={0.1}
            value={prefs.widthM} disabled={disabled} onChange={e=>setNumber('widthM',e.target.value)}
            style={{width:'100%',display:'block'}}/>
        </label>
        <label className="am-lbl">Y · Tiefe (m)
          <input className="am-sel" type="number" min={1} max={100} step={0.1}
            value={prefs.depthM} disabled={disabled} onChange={e=>setNumber('depthM',e.target.value)}
            style={{width:'100%',display:'block'}}/>
        </label>
        <label className="am-lbl">Satelliten
          <select className="am-sel" value={prefs.satellites} disabled={disabled}
            onChange={e=>update({satellites:Number(e.target.value) as SpatialClubCount})}
            style={{width:'100%',display:'block'}}>
            {SPATIAL_CLUB_COUNTS.map(n=><option key={n} value={n}>{n} Kanäle</option>)}
          </select>
        </label>
        <label className="am-lbl">Separate Subwoofer
          <select className="am-sel" value={prefs.subs} disabled={disabled}
            onChange={e=>update({subs:Number(e.target.value) as 0|1|2})}
            style={{width:'100%',display:'block'}}>
            {[0,1,2].map(n=><option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <label className="am-lbl">
        <input type="checkbox" checked={prefs.lockStereo} disabled={disabled}
          onChange={e=>update({lockStereo:e.target.checked})}/> Vorhandene Stereo L/R als Fixpunkte
      </label>
      {prefs.lockStereo&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
        {([['leftX','Links X'],['leftY','Links Y'],['rightX','Rechts X'],['rightY','Rechts Y']] as const).map(([key,label])=>
          <label className="am-lbl" key={key}>{label} (m)
            <input className="am-sel" type="number" step={0.05} value={prefs[key]}
              style={{display:'block',width:'100%'}} disabled={disabled}
              onChange={e=>setNumber(key,e.target.value)}/>
          </label>)}
      </div>}
      {result.error&&<div role="alert" className="am-hint" style={{color:'var(--warn)'}}>{result.error}</div>}
      {plan&&<>
        <svg viewBox="0 0 400 400" width="100%" role="img"
          aria-label={`Rechteckiger Raum ${prefs.widthM} mal ${prefs.depthM} Meter, ${prefs.satellites} Satelliten`}
          style={{background:'#111d2b',borderRadius:7,maxHeight:360}}>
          <rect x={x0} y={y0} width={roomW} height={roomH} stroke="#8ba2b8" strokeWidth="2" fill="none"/>
          <line x1="200" y1={y0} x2="200" y2={y0+roomH} stroke="#40566d" strokeDasharray="3 5"/>
          <line x1={x0} y1="200" x2={x0+roomW} y2="200" stroke="#40566d" strokeDasharray="3 5"/>
          {plan.satellites.map(s=><g key={s.id}>
            <line x1="200" y1="200" x2={toX(s.positionM.x)} y2={toY(s.positionM.y)}
              stroke="#5f88a7" strokeOpacity=".2" strokeDasharray="2 4"/>
            <circle cx={toX(s.positionM.x)} cy={toY(s.positionM.y)} r={s.wall==='fixed'?7:4.5}
              fill={s.wall==='fixed'?'#edaa56':'#5fc4f2'}/>
            <title>{s.id} · X={s.positionM.x.toFixed(3)}m Y={s.positionM.y.toFixed(3)}m · Az={s.azimuthDeg.toFixed(2)}°</title>
          </g>)}
          <circle cx="200" cy="200" r="5" fill="#43d6a4"/>
          <text x="200" y="18" fontSize="11" fill="#dce8f6" textAnchor="middle">FRONT</text>
          <text x="200" y="393" fontSize="11" fill="#dce8f6" textAnchor="middle">REAR</text>
        </svg>
        <div className="am-hint">
          {plan.satellites.length} Satelliten · {plan.totalRequiredOutputs} diskrete Ausgänge inkl. Subs ·
          größter Winkelabstand {plan.maxAngularGapDeg.toFixed(2)}°.
          Geometrische Delays sind KEINE gemessene Einmessung.
        </div>
        <button type="button" className="am-tg" onClick={()=>setShowTable(x=>!x)}>
          LS KOORDINATEN & DELAYS {showTable?'▴':'▾'}
        </button>
        {showTable&&<div style={{maxHeight:230,overflow:'auto',fontSize:11}}>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead><tr><th>LS</th><th>X</th><th>Y</th><th>°</th><th>m</th><th>Delay*</th></tr></thead>
            <tbody>{plan.satellites.map(sp=><tr key={sp.id}>
              <td>{sp.id}</td><td>{sp.positionM.x.toFixed(2)}</td><td>{sp.positionM.y.toFixed(2)}</td>
              <td>{sp.azimuthDeg.toFixed(1)}</td><td>{sp.distanceM.toFixed(2)}</td>
              <td>{sp.geometricDelayMs.toFixed(2)}ms</td>
            </tr>)}</tbody>
          </table>
          <div className="am-hint">*Nur theoretische Schalllaufzeit, nicht angewandt.</div>
        </div>}
        <button type="button" className="am-tg" onClick={()=>setVisualizerOpen(true)}>
          VISUALISIEREN · VIRTUELLER RAUM
        </button>
        <button type="button" className="am-tg" disabled={disabled}
          onClick={()=>onLayoutChange?.(`${prefs.satellites}.${prefs.subs}`)}>
          SPATIAL-SETUP ÜBERNEHMEN
        </button>
        <button type="button" className="am-tg" disabled title="Messmikrofon, Ausgangsrouting und Mess-Engine noch nicht verifiziert">
          EINMESSUNG STARTEN · NOCH NICHT VERFÜGBAR
        </button>
        <div className="am-hint">Sicherer Kanal-Testplan vorbereitet ({createChannelProbeSchedule(plan).length} Kanäle).
          Kein Testton, keine Session-Korrektur und keine Änderung des DJ-Stereo-Masters.</div>
      </>}
    </>}
    {visualizerOpen&&plan&&<SpatialLiveVisualizer plan={plan} frame={meterFrame}
      onClose={()=>setVisualizerOpen(false)}/>}
  </div>;
}
