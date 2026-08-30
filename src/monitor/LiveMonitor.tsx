import {  useEffect, useRef  } from 'react';
import { webRTCManager } from '../utils/WebRTCManager';

export const LiveMonitor = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  
  useEffect(() => {
    webRTCManager.onRemoteStream = (stream, senderId) => {
        if (audioRef.current && senderId === 'MASTER_NODE') {
            audioRef.current.srcObject = stream;
            audioRef.current.play();
        }
    };
    
    // Visualization Loop can be kept for UI feedback
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;

    const draw = () => {
      requestAnimationFrame(draw);
      ctx.fillStyle = 'rgb(0, 0, 0)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgb(16, 185, 129)';
      ctx.beginPath();
      ctx.moveTo(0, canvas.height/2);
      ctx.lineTo(canvas.width, canvas.height/2);
      ctx.stroke();
    };
    draw();
  }, []);
  
  return (
      <>
        <audio ref={audioRef} autoPlay className="hidden" />
        <canvas ref={canvasRef} className="w-full h-screen bg-black" width="1920" height="1080" />
      </>
  );
};
