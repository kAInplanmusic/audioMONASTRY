import {describe,it,expect} from 'vitest';
import {speakerHeadDirection,wrapAzimuthDeg} from '../src/core/spatial/v2/binauralGeometry';
describe('binaural geometry groundwork',()=>{
 const listener={x:0,y:0};
 it('defines front right rear left azimuths',()=>{
  expect(speakerHeadDirection({x:0,y:-1},listener).azimuthDeg).toBeCloseTo(0);
  expect(speakerHeadDirection({x:1,y:0},listener).azimuthDeg).toBeCloseTo(90);
  expect(Math.abs(speakerHeadDirection({x:0,y:1},listener).azimuthDeg)).toBeCloseTo(180);
  expect(speakerHeadDirection({x:-1,y:0},listener).azimuthDeg).toBeCloseTo(-90);
 });
 it('transforms with listener head yaw',()=>{
  expect(speakerHeadDirection({x:0,y:-1},listener,90).azimuthDeg).toBeCloseTo(-90);
  expect(wrapAzimuthDeg(540)).toBe(-180);
 });
 it('rejects invalid coordinates',()=>{
  expect(()=>speakerHeadDirection({x:Infinity,y:0},listener)).toThrow();
 });
});
