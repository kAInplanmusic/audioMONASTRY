/**
 * Browser headphone output selection for a local spatial monitor.
 * The output is a MediaStreamAudioDestinationNode, played by an HTMLAudioElement
 * whose sinkId is explicitly selected. Does not change the shared AudioContext
 * output device or global MAIN. Browser autoplay/permission policies apply.
 */
export class LocalHeadphoneDevice {
  readonly destination:MediaStreamAudioDestinationNode;
  private readonly audio:HTMLAudioElement;
  private disposed=false;
  private constructor(ctx:AudioContext,audio:HTMLAudioElement){
    this.destination=ctx.createMediaStreamDestination();
    this.audio=audio;
    this.audio.autoplay=false;
    this.audio.srcObject=this.destination.stream;
  }
  static async create(ctx:AudioContext,deviceId:string):Promise<LocalHeadphoneDevice>{
    if(!deviceId||typeof deviceId!=='string')throw new RangeError('Headphone device ID required');
    if(typeof document==='undefined')throw new Error('Headphone device selection requires browser');
    const audio=document.createElement('audio');
    const setSinkId=(audio as HTMLAudioElement&{setSinkId?:(id:string)=>Promise<void>}).setSinkId;
    if(typeof setSinkId!=='function')throw new Error('Browser does not support audio output selection');
    const device=new LocalHeadphoneDevice(ctx,audio);
    try{
      await setSinkId.call(audio,deviceId);
      // Must be called from a user-initiated interaction in browsers with autoplay restrictions.
      await audio.play();
      return device;
    }catch(error){
      device.dispose();
      throw error;
    }
  }
  dispose():void{
    if(this.disposed)return;
    this.disposed=true;
    this.audio.pause();
    this.audio.srcObject=null;
    try{this.destination.disconnect();}catch{/* disconnected */}
  }
}
