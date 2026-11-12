import type {ClubPlan} from '../../core/spatial/v2/clubPlanner';
import type {VirtualFrame} from '../../core/spatial/v2/virtualInterface';
import {mapVirtualMeters} from '../../core/spatial/v2/virtualInterface';
import React,{useEffect,useMemo,useRef,useState} from 'react';

/** Render-only floating window. Live meter data MUST come from actual routed PCM. */
export function SpatialLiveVisualizer({plan,frame,onClose}:{
  plan:ClubPlan;frame:VirtualFrame|null;onClose:()=>void
}){
  const [position,setPosition]=useState({x:20,y:80});
  const [collapsed,setCollapsed]=useState(false);
  const drag=useRef<{x:number;y:number;startX:number;startY:number}|null>(null);
  const geometry=useMemo(()=>{
    const w=plan.room.widthM,d=plan.room.depthM;
    const scale=Math.min(300/w,230/d);
    return {w:w*scale,h:d*scale,scale};
  },[plan.room.widthM,plan.room.depthM]);
  const meters=useMemo(()=>{
    if(!frame||frame.channels.length!==plan.satellites.length)return null;
    try {
      // Plan's array order is the current logical order until explicit mapping is available.
      return mapVirtualMeters(frame,plan.satellites.map((s,i)=>({
        id:s.id,positionM:s.positionM,outputChannel:s.outputChannel??i
      })));
    }catch{return null;}
  },[frame,plan]);
  useEffect(()=>{
    const move=(e:PointerEvent)=>{
      const d=drag.current;if(!d)return;
      setPosition({x:Math.max(0,d.startX+e.clientX-d.x),y:Math.max(0,d.startY+e.clientY-d.y)});
    };
    const up=()=>{drag.current=null;};
    window.addEventListener('pointermove',move);
    window.addEventListener('pointerup',up);
    return ()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);};
  },[]);
  const sx=(x:number)=>20+(x/plan.room.widthM+0.5)*geometry.w;
  const sy=(y:number)=>20+(0.5-y/plan.room.depthM)*geometry.h;
  return <aside role="dialog" aria-label="spatialMONK Live-Visualisierung" style={{
    position:'fixed',left:position.x,top:position.y,zIndex:10000,width:Math.max(270,geometry.w+40),
    resize:'both',overflow:'auto',minWidth:260,maxWidth:'95vw',maxHeight:'85vh',
    border:'1px solid #64748b',borderRadius:10,background:'#101925',color:'#e2e8f0',
    boxShadow:'0 8px 30px #0009',padding:10
  }}>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,
      cursor:'move',touchAction:'none'}} onPointerDown={e=>{
      if((e.target as HTMLElement).closest('button'))return;
      drag.current={x:e.clientX,y:e.clientY,startX:position.x,startY:position.y};
    }}>
      <strong>spatialMONK · LIVE</strong>
      <div>
        <button type="button" aria-label={collapsed?'Aufklappen':'Einklappen'}
          onClick={()=>setCollapsed(x=>!x)}>{collapsed?'▢':'−'}</button>
        <button type="button" aria-label="Visualisierung schließen" onClick={onClose}>×</button>
      </div>
    </div>
    {!collapsed&&<>
      <div role="status" style={{fontSize:11,margin:'8px 0',color:meters?'#86efac':'#fbbf24'}}>
        {meters?'PCM-Meter · letzter empfangener Frame':'WARTET AUF PCM · keine Live-Audiodaten verbunden'}
      </div>
      <svg role="img" aria-label={`Raum ${plan.room.widthM} × ${plan.room.depthM} Meter mit ${plan.satellites.length} Lautsprechern`}
        viewBox={`0 0 ${geometry.w+40} ${geometry.h+40}`}
        style={{width:'100%',maxHeight:310,display:'block'}}>
        <rect x={20} y={20} width={geometry.w} height={geometry.h} stroke="#94a3b8" fill="#162335"/>
        {plan.satellites.map((s,i)=>{
          const m=meters?.[i];const active=m?.active??false;
          return <g key={s.id}>
            <circle cx={sx(s.positionM.x)} cy={sy(s.positionM.y)}
              r={active?7:4.5} fill={m?.clipped?'#f87171':active?'#4ade80':'#64748b'}/>
            <title>{`${s.id} · ${m?Math.round(20*Math.log10(Math.max(m.rms,1e-9)))+' dBFS':'kein PCM'}`}</title>
          </g>;
        })}
        <circle cx={sx(plan.listenerM.x)} cy={sy(plan.listenerM.y)} r="4" fill="#38bdf8"/>
      </svg>
      <div style={{fontSize:11}}>SAT {plan.satellites.length} · SUB {plan.subwoofers.length} · SIMULATION, NICHT EINGEMESSEN</div>
    </>}
  </aside>;
}
