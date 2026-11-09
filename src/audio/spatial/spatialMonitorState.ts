import {readPluginSettings,subscribeSpatialSettings} from '../../utils/pluginSettings';

export type SpatialMonitorObject={x:number;y:number;on:boolean};
type Snapshot=Readonly<Record<string,SpatialMonitorObject>>;
let current:Snapshot={};
const listeners=new Set<()=>void>();
let initialized=false;

export function getSpatialMonitorSnapshot():Snapshot{
  if(!initialized){
    initialized=true;
    const stored=readPluginSettings<{objects?:Record<string,SpatialMonitorObject>}>('spatial');
    current=stored?.objects??{};
  }
  return current;
}
export function subscribeSpatialMonitor(listener:()=>void):()=>void{
  listeners.add(listener);
  return ()=>{listeners.delete(listener);};
}
export function publishSpatialMonitor(objects:Record<string,SpatialMonitorObject>):void{
  initialized=true;
  current=objects;
  listeners.forEach(fn=>fn());
}

/** Keeps the app-level monitor in sync with session snapshots and remote holder updates. */
subscribeSpatialSettings(settings=>{
  const objects=settings?.objects;
  if(objects && typeof objects==='object' && !Array.isArray(objects)){
    const validated:Record<string,SpatialMonitorObject>={};
    for(const [key,value] of Object.entries(objects)){
      if(!/^channel[1-8]$/.test(key)||!value||typeof value!=='object')continue;
      const v=value as Partial<SpatialMonitorObject>;
      if(typeof v.x==='number'&&Number.isFinite(v.x)&&typeof v.y==='number'&&Number.isFinite(v.y)&&typeof v.on==='boolean'){
        validated[key]={x:v.x,y:v.y,on:v.on};
      }
    }
    publishSpatialMonitor(validated);
  }
});
