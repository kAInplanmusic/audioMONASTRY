import {describe,it,expect} from 'vitest';
import {createSpatialPcmShared,SpatialPcmTransport} from '../src/core/spatial/v2/spatialPcmTransport';
describe('four local spatial monitor transports',()=>{
 it('keeps four simultaneous 32-channel streams isolated',()=>{
  const pairs=Array.from({length:4},()=>{const shared=createSpatialPcmShared(32,48000);
    return {source:new SpatialPcmTransport(shared),headphones:new SpatialPcmTransport(shared)};});
  for(let user=0;user<4;user++){
    const block=Array.from({length:32},(_,channel)=>new Float32Array(128)
      .fill(channel===user?0.1*(user+1):0));
    pairs[user].source.publish(block);
  }
  for(let user=0;user<4;user++){
    const frame=pairs[user].headphones.consume();
    expect(frame[user][0]).toBeCloseTo(0.1*(user+1));
    for(let other=0;other<32;other++)if(other!==user)expect(frame[other][0]).toBe(0);
  }
  pairs[0].source.publish(Array.from({length:32},()=>new Float32Array(128).fill(0.5)));
  expect(pairs[1].headphones.consume()[1][0]).toBe(0); // old packet not replayed
  expect(pairs[2].headphones.consume()[2][0]).toBe(0);
  expect(pairs[3].headphones.consume()[3][0]).toBe(0);
 });
});
