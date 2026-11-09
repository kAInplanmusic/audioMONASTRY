import {readPluginSettings,subscribeSpatialSettings} from '../../utils/pluginSettings';

export type SpatialMonitorObject={x:number;y:number;on:boolean};
type Snapshot=Readonly<Record<string,SpatialMonitorObject>>;
const EMPTY:Snapshot=Object.freeze({});
let current:Snapshot=EMPTY;
const listeners=new Set<()=>void>();
let initialized=false;

/** Accept only valid source IDs and finite coordinates from replicated session state. */
function validatedObjects(settings:unknown):Snapshot{
  if(!settings||typeof settings!=='object')return EMPTY;
  const objects=(settings as {objects?:unknown}).objects;
  if(!objects||typeof objects!=='object'||Array.isArray(objects))return EMPTY;
  const validated:Record<string,SpatialMonitorObject>={};
  for(const [key,value] of Object.entries(objects)){
    if(!/^channel[1-8]$/.test(key)||!value||typeof value!=='object'||Array.isArray(value))continue;
    const v=value as Partial<SpatialMonitorObject>;
    if(typeof v.x==='number'&&Number.isFinite(v.x)&&typeof v.y==='number'&&Number.isFinite(v.y)&&typeof v.on==='boolean')
      validated[key]={x:v.x,y:v.y,on:v.on};
  }
  return Object.keys(validated).length?validated:EMPTY;
}

function sameObjects(a:Snapshot,b:Snapshot):boolean{
  const aKeys=Object.keys(a),bKeys=Object.keys(b);
  return aKeys.length===bKeys.length&&aKeys.every(key=>{
    const x=a[key],y=b[key];
    return !!y&&x.x===y.x&&x.y===y.y&&x.on===y.on;
  });
}

export function getSpatialMonitorSnapshot():Snapshot{
  if(!initialized){
    initialized=true;
    current=validatedObjects(readPluginSettings('spatial'));
  }
  return current;
}
export function subscribeSpatialMonitor(listener:()=>void):()=>void{
  listeners.add(listener);
  return ()=>{listeners.delete(listener);};
}
export function publishSpatialMonitor(objects:Record<string,SpatialMonitorObject>):void{
  const next=validatedObjects({objects});
  if(initialized&&sameObjects(current,next))return;
  initialized=true;
  current=next;
  listeners.forEach(fn=>fn());
}

/** React subscription survives rack unmounts and session holder changes. */
subscribeSpatialSettings(settings=>{
  const next=validatedObjects(settings);
  if(initialized&&sameObjects(current,next))return;
  initialized=true;
  current=next;
  listeners.forEach(fn=>fn());
});
