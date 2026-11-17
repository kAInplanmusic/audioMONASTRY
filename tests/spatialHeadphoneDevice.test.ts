import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {LocalHeadphoneDevice} from '../src/audio/spatial/localHeadphoneDevice';

describe('isolated spatial headphone hardware output',()=>{
 const pause=vi.fn(),play=vi.fn(async()=>undefined),setSinkId=vi.fn(async()=>undefined);
 const disconnect=vi.fn();
 const audio={autoplay:false,srcObject:null as MediaStream|null,pause,play,setSinkId};
 const stream={} as MediaStream;
 const ctx={createMediaStreamDestination:vi.fn(()=>({context:null,stream,disconnect}))} as unknown as AudioContext;
 beforeEach(()=>{
  vi.clearAllMocks();
  vi.stubGlobal('document',{createElement:vi.fn(()=>audio)});
 });
 afterEach(()=>vi.unstubAllGlobals());
 it('selects device, starts playback and releases stream',async()=>{
  const output=await LocalHeadphoneDevice.create(ctx,'headphones-1');
  expect(setSinkId).toHaveBeenCalledWith('headphones-1');
  expect(play).toHaveBeenCalledTimes(1);
  expect(audio.srcObject).toBe(stream);
  output.dispose();output.dispose();
  expect(pause).toHaveBeenCalledTimes(1);
  expect(audio.srcObject).toBeNull();
 });
 it('cleans up on device selection rejection',async()=>{
  setSinkId.mockRejectedValueOnce(new Error('NotAllowedError'));
  await expect(LocalHeadphoneDevice.create(ctx,'headphones-1')).rejects.toThrow('NotAllowedError');
  expect(pause).toHaveBeenCalledTimes(1);
  expect(audio.srcObject).toBeNull();
 });
});
