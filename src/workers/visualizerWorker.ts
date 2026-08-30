// src/workers/visualizerWorker.ts

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let canvasWidth = 0;
let canvasHeight = 0;
let sharedBuffer: Float32Array | null = null;
let isPlaying = false;
let lastDrawTime = 0;
let animationId: number | null = null;
const DRAW_INTERVAL = 1000 / 60; // 60 FPS

const draw = (time: number) => {
    if (!ctx) return;

    // Check if we should actually draw
    const isSilent = sharedBuffer ? sharedBuffer.every(v => Math.abs(v) < 0.001) : true;
    
    if (!isPlaying && isSilent) {
        // Draw one last "idle" state and stop
        drawIdleState();
        animationId = null;
        return;
    }

    if (time - lastDrawTime < DRAW_INTERVAL) {
        animationId = requestAnimationFrame(draw);
        return;
    }
    lastDrawTime = time;

    const width = canvasWidth;
    const height = canvasHeight;

    // Draw subtle background grid
    ctx.fillStyle = 'rgba(15, 15, 20, 0.2)';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(38, 38, 55, 0.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i < width; i += 40) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, height);
      ctx.stroke();
    }
    for (let i = 0; i < height; i += 20) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(width, i);
      ctx.stroke();
    }

    if (sharedBuffer) {
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, '#3b82f6');
        gradient.addColorStop(0.5, '#0ea5e9');
        gradient.addColorStop(1, '#6366f1');
        
        ctx.strokeStyle = gradient;
        ctx.shadowBlur = 12;
        ctx.shadowColor = 'rgba(59, 130, 246, 0.6)';

        const sliceWidth = width / sharedBuffer.length;
        let x = 0;

        ctx.beginPath();
        ctx.lineWidth = 3;
        for (let i = 0; i < sharedBuffer.length; i++) {
          const v = sharedBuffer[i];
          const y = (v + 1) * (height / 2);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          x += sliceWidth;
        }
        ctx.lineTo(width, height / 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    animationId = requestAnimationFrame(draw);
};

const drawIdleState = () => {
    if (!ctx) return;
    const width = canvasWidth;
    const height = canvasHeight;
    
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, width, height);
    
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(74, 85, 104, 0.4)';
    ctx.lineWidth = 2;
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
};

self.onmessage = (event) => {
  const { type, canvas, sab, width, height, playing } = event.data;

  if (type === 'init') {
    const offscreen = canvas as OffscreenCanvas;
    ctx = offscreen.getContext('2d');
    canvasWidth = width;
    canvasHeight = height;
    if (sab) {
        sharedBuffer = new Float32Array(sab);
    }
    if (!animationId) animationId = requestAnimationFrame(draw);
  } else if (type === 'state') {
    isPlaying = playing;
    if (isPlaying && !animationId) {
        animationId = requestAnimationFrame(draw);
    }
  }
};
