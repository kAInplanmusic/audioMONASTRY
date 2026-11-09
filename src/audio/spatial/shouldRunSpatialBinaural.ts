import type {SpatialMonitorObject} from './spatialMonitorState';

/** Session-authoritative plugin bypass plus actual spatial source enablement. */
export function shouldRunSpatialBinaural(
  moduleState:'OFF'|'AUTO_AI'|'PRO'|undefined,
  objects:Readonly<Record<string,SpatialMonitorObject>>,
):boolean{
  return moduleState!==undefined&&moduleState!=='OFF'&&
    Object.entries(objects).some(([id,o])=>/^channel[1-8]$/.test(id)&&o?.on===true);
}
