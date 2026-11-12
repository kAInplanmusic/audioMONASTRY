import {describe,expect,it,vi} from 'vitest';

const settingsEvents=vi.hoisted(()=>({listener:null as null|((settings:unknown)=>void)}));
vi.mock('../src/utils/pluginSettings',()=>({
  readPluginSettings:()=>({objects:{channel1:{x:0,y:0,on:false}}}),
  subscribeSpatialSettings:(listener:(settings:unknown)=>void)=>{
    settingsEvents.listener=listener;
    return ()=>{settingsEvents.listener=null;};
  },
}));
import {getSpatialMonitorSnapshot,publishSpatialMonitor,subscribeSpatialMonitor} from '../src/audio/spatial/spatialMonitorState';

describe('spatial local monitor state',()=>{
  it('uses saved spatial configuration before rack mount',()=>{
    expect(getSpatialMonitorSnapshot().channel1.on).toBe(false);
  });
  it('notifies subscribers only on actual changes',()=>{
    const callback=vi.fn();
    const unsubscribe=subscribeSpatialMonitor(callback);
    const objects={channel1:{x:0.25,y:-0.5,on:true}};
    publishSpatialMonitor(objects);
    expect(getSpatialMonitorSnapshot()).toEqual(objects);
    expect(callback).toHaveBeenCalledTimes(1);
    publishSpatialMonitor({...objects,channel1:{...objects.channel1}});
    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe();
    publishSpatialMonitor({channel1:{x:0,y:0,on:false}});
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('clears a stale active source when the session snapshot is empty',()=>{
    publishSpatialMonitor({channel1:{x:0,y:0,on:true}});
    settingsEvents.listener?.(null);
    expect(getSpatialMonitorSnapshot()).toEqual({});
  });
  it('ignores invalid remote positions and unknown channel IDs',()=>{
    settingsEvents.listener?.({objects:{
      channel1:{x:Number.POSITIVE_INFINITY,y:0,on:true},
      channel2:{x:0.5,y:-0.5,on:true},
      channel9:{x:0,y:0,on:true},
    }});
    expect(getSpatialMonitorSnapshot()).toEqual({channel2:{x:0.5,y:-0.5,on:true}});
  });
});
