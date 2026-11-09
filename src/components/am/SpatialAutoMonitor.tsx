import {useEffect,useRef,useState} from 'react';
import {audioEngine} from '../../utils/audioEngine';
import {planClubSpeakers} from '../../core/spatial/v2/clubPlanner';
import {LocalV2SpatialMonitorController} from '../../audio/spatial/localV2SpatialMonitorController';

type SpatialObject={x:number;y:number;on:boolean};
type Props={active:boolean;positions:Record<string,SpatialObject>};

/**
 * Purely local monitor routing. The OS/browser owns the output device.
 * Spatial sources active => binaural stereo; otherwise existing dry stereo.
 * Never enumerates devices, changes sinkId or changes the shared MAIN.
 */
export function SpatialAutoMonitor({active,positions}:Props){
  const monitor=useRef<LocalV2SpatialMonitorController|null>(null);
  if(!monitor.current)monitor.current=new LocalV2SpatialMonitorController(audioEngine.v2LiveSink);
  const [mode,setMode]=useState<'stereo'|'binaural'|'starting'>('stereo');
  const positionsRef=useRef(positions);
  positionsRef.current=positions;
  useEffect(()=>{
    let cancelled=false;
    let starting=false;
    let attempt=0;
    let previousPositions='';
    let currentContext:AudioContext|null=null;
    let currentRevision=-1;
    let retryAfter=0;
    const controller=monitor.current!;
    const supported=()=>typeof SharedArrayBuffer!=='undefined'&&
      typeof crossOriginIsolated!=='undefined'&&crossOriginIsolated;
    const reconcile=async()=>{
      const sink=audioEngine.v2LiveSink;
      const ctx=sink.getAudioContext();
      const ready=active&&supported()&&sink.isConnected&&!!ctx&&ctx.state==='running';
      if(!ready){
        // Cancel even a pending async start before it can install a wet path.
        if(starting||controller.isActive||currentContext){++attempt;controller.stop();}
        currentContext=null;
        currentRevision=-1;
        if(!cancelled)setMode('stereo');
        return;
      }
      if(controller.isActive&&currentContext===ctx&&currentRevision===sink.getSpatialSinkRevision()){
        const positionsKey=JSON.stringify(positionsRef.current);
        if(positionsKey!==previousPositions){
          previousPositions=positionsKey;
          for(const [track,pos] of Object.entries(positionsRef.current)){
            if(/^channel[1-8]$/.test(track))sink.setSpatialTrackPosition(track as import('../../core/audio/V2StudioGraph').V2Channel,{x:pos.on?pos.x*3.5:0,y:pos.on?pos.y*3.5:0});
          }
        }
        return;
      }
      if(starting||Date.now()<retryAfter)return;
      starting=true;
      const thisAttempt=++attempt;
      if(!cancelled)setMode('starting');
      const revision=sink.getSpatialSinkRevision();
      try{
        await controller.start(planClubSpeakers({widthM:8,depthM:8,satellites:16}));
        if(cancelled||thisAttempt!==attempt||sink.getAudioContext()!==ctx||sink.getSpatialSinkRevision()!==revision){
          if(thisAttempt===attempt)controller.stop();
          return;
        }
        currentContext=ctx;
        currentRevision=revision;
        previousPositions=JSON.stringify(positionsRef.current);
        for(const [track,pos] of Object.entries(positionsRef.current)){
          if(/^channel[1-8]$/.test(track))
            sink.setSpatialTrackPosition(track as import('../../core/audio/V2StudioGraph').V2Channel,{x:pos.on?pos.x*3.5:0,y:pos.on?pos.y*3.5:0});
        }
        retryAfter=0;
        setMode('binaural');
      }catch{
        if(thisAttempt!==attempt)return;
        retryAfter=Date.now()+5000;
        controller.stop();
        currentContext=null;
        currentRevision=-1;
        if(!cancelled)setMode('stereo');
      }finally{starting=false;}
    };
    void reconcile();
    // AudioContext and sink lifecycle are owned by the engine, not the rack.
    // Polling is only a compatibility fallback until the sink exposes lifecycle events.
    const timer=window.setInterval(()=>{void reconcile();},1000);
    return ()=>{
      cancelled=true;
      window.clearInterval(timer);
      ++attempt;
      controller.stop();
    };
  },[active]);
  return <p className="am-hint" role="status" aria-live="polite" data-testid="spatial-auto-monitor">
    User Monitor: {mode==='binaural'?'Binaural 2.0':mode==='starting'?'Spatial wird verbunden':'Stereo 2.0'}
  </p>;
}
