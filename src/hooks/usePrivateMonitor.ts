import { useEffect, useRef, useState } from 'react';
import { PrivateMonitorTransport } from '../utils/privateMonitorTransport';
import { webRTCManager } from '../utils/WebRTCManager';
import { audioEngine } from '../utils/audioEngine';
import { rtcConfig } from '../config/webrtc';
export function usePrivateMonitor(input: { userId: string; ownerId: string; memberIds: string[] }) {
  const { userId, ownerId } = input;
  const [status, setStatus] = useState<'waiting' | 'receiving' | 'sending' | 'error'>('waiting');
  const controller = useRef<PrivateMonitorTransport | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    if (userId !== ownerId) { queueMicrotask(() => setStream(null)); return; }
    let destination: MediaStreamAudioDestinationNode | null = null;
    const capture = () => {
      if (destination) return;
      destination = audioEngine.createMasterStreamDestination();
      if (destination) setStream(destination.stream);
    };
    const initial = setTimeout(capture, 0);
    const timer = setInterval(capture, 1000);
    return () => {
      clearTimeout(initial); clearInterval(timer); queueMicrotask(() => setStream(null));
      if (destination) {
        audioEngine.disconnectMasterStreamDestination(destination);
        for (const track of destination.stream.getTracks()) track.stop();
      }
    };
  }, [userId, ownerId]);
  useEffect(() => {
    const transport = new PrivateMonitorTransport({
      sendSignal: signal => webRTCManager.sendMonitorSignal(signal),
      subscribeSignals: listener => webRTCManager.addMonitorSignalListener(listener),
      getRtcConfiguration: () => rtcConfig,
      onAudioStream: stream => { void audioEngine.setPrivateMainMonitorStream(stream).then(() => setStatus(stream ? 'receiving' : 'waiting')).catch(() => setStatus('error')); },
      onError: () => setStatus('error'),
    });
    controller.current = transport;
    return () => { controller.current = null; transport.dispose(); void audioEngine.setPrivateMainMonitorStream(null); };
  }, []);
  const members = [...new Set(input.memberIds)].sort().join('\n');
  useEffect(() => {
    controller.current?.update({ userId, ownerId, stream, memberIds: members ? members.split('\n') : [] });
  }, [userId, ownerId, stream, members]);
  return userId === ownerId ? (stream ? 'sending' : 'waiting') : status;
}
