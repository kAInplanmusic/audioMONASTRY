/** Geometry only: NOT an HRTF convolver or a binaural audio renderer. */
export interface HeadRelativeDirection { azimuthDeg:number; distanceM:number }
export function wrapAzimuthDeg(angle:number):number {
 if(!Number.isFinite(angle))throw new RangeError('Invalid angle');
 return ((angle+180)%360+360)%360-180;
}
/** +X right, +Y rear, 0° front, +90° right, yaw positive to right. */
export function speakerHeadDirection(
 speaker:{x:number;y:number}, listener:{x:number;y:number}, headYawDeg=0
):HeadRelativeDirection {
 for(const x of [speaker.x,speaker.y,listener.x,listener.y,headYawDeg])
  if(!Number.isFinite(x))throw new RangeError('Non-finite geometry');
 const dx=speaker.x-listener.x,dy=speaker.y-listener.y;
 return {azimuthDeg:wrapAzimuthDeg(Math.atan2(dx,-dy)*180/Math.PI-headYawDeg),
   distanceM:Math.hypot(dx,dy)};
}
