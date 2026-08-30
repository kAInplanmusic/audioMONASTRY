import { useEffect, useRef, useState } from 'react';
import { rtcConfig } from '../config/webrtc';
import { SIGNALING_WS_URL } from '../config/runtime';

export function useWebRTC(userId: string | null, roomId: string | null, localStream: MediaStream | null) {
  const [peers, setPeers] = useState<Map<string, RTCPeerConnection>>(new Map());
  const [locks, setLocks] = useState<Map<string, string | null>>(new Map());
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!userId || !roomId || !SIGNALING_WS_URL) return;

    // Signaling Server
    socketRef.current = new WebSocket(SIGNALING_WS_URL);

    socketRef.current.onopen = () => {
      socketRef.current?.send(JSON.stringify({ type: 'init', sender: userId }));
    };

    socketRef.current.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      const { type, sender, payload } = data;

      if (type === 'sdp_offer') {
        handleOffer(sender, payload);
      } else if (type === 'sdp_answer') {
        handleAnswer(sender, payload);
      } else if (type === 'ice_candidate') {
        handleCandidate(sender, payload);
      } else if (type === 'lock_status') {
        const { moduleId, userId, status } = payload;
        setLocks(prev => new Map(prev).set(moduleId, status === 'locked' ? userId : null));
      }
    };

    return () => {
      socketRef.current?.close();
      peers.forEach(pc => pc.close());
    };
  }, [userId, roomId]);

  const requestLock = (moduleId: string) => {
    socketRef.current?.send(JSON.stringify({
      type: 'lock_request',
      sender: userId,
      payload: { moduleId }
    }));
  };

  const createPeerConnection = (otherUserId: string) => {
    const pc = new RTCPeerConnection(rtcConfig);
    
    // Multi-Channel Opus: Tracks hinzufügen
    localStream?.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.send(JSON.stringify({
          type: 'ice_candidate',
          sender: userId,
          recipient: otherUserId,
          payload: event.candidate
        }));
      }
    };

    setPeers(prev => new Map(prev).set(otherUserId, pc));
    return pc;
  };

  const handleOffer = async (sender: string, sdp: RTCSessionDescriptionInit) => {
    const pc = createPeerConnection(sender);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socketRef.current?.send(JSON.stringify({
      type: 'sdp_answer',
      sender: userId,
      recipient: sender,
      payload: answer
    }));
  };

  const handleAnswer = async (sender: string, sdp: RTCSessionDescriptionInit) => {
    const pc = peers.get(sender);
    await pc?.setRemoteDescription(new RTCSessionDescription(sdp));
  };

  const handleCandidate = async (sender: string, candidate: RTCIceCandidateInit) => {
    const pc = peers.get(sender);
    await pc?.addIceCandidate(new RTCIceCandidate(candidate));
  };

  return { peers, locks, requestLock };
}
