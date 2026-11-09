import {readPluginSettings} from '../../utils/pluginSettings';

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
