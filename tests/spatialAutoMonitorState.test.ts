import {describe,expect,it,vi} from 'vitest';

vi.mock('../src/utils/pluginSettings',()=>({
  readPluginSettings:()=>({objects:{channel1:{x:0,y:0,on:false}}}),
  subscribeSpatialSettings:()=>()=>{},
}));
import {getSpatialMonitorSnapshot,publishSpatialMonitor,subscribeSpatialMonitor} from '../src/audio/spatial/spatialMonitorState';

describe('spatial local monitor state',()=>{
  it('uses the saved spatial configuration before rack mount',()=>{
    expect(getSpatialMonitorSnapshot().channel1.on).toBe(false);
  });
  it('notifies app-lifetime subscribers when spatial objects change',()=>{
    const callback=vi.fn();
    const unsubscribe=subscribeSpatialMonitor(callback);
    const objects={channel1:{x:0.25,y:-0.5,on:true}};
    publishSpatialMonitor(objects);
    expect(getSpatialMonitorSnapshot()).toBe(objects);
    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe();
    publishSpatialMonitor({channel1:{x:0,y:0,on:false}});
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
