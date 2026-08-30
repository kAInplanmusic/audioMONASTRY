import React, { useState, useRef } from 'react';

type Skin = 'oscilloscope' | 'analytic' | 'galactic';

export const MasterTrackTerminal = React.memo(() => {
  const [skin, setSkin] = useState<Skin>('galactic');
  const [timeRange, setTimeRange] = useState(15);
  const [isMinimized, setIsMinimized] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  if (isMinimized) {
    return (
      <button type="button"
        className="fixed bottom-4 right-4 bg-gray-800 p-2 rounded text-xs"
        onClick={() => setIsMinimized(false)}
      >
        Show Master
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 h-48 bg-black/90 border-t border-neutral-700 p-4 z-40">
      <div className="flex justify-between mb-2">
        <div className="flex gap-2">
          {[15, 30, 60].map(t => (
            <button type="button" key={t} onClick={() => setTimeRange(t)} className={`px-2 text-[10px] ${timeRange === t ? 'text-white' : 'text-gray-500'}`}>{t}s</button>
          ))}
        </div>
        <div className="flex gap-2">
          {(['oscilloscope', 'analytic', 'galactic'] as Skin[]).map(s => (
            <button type="button" key={s} onClick={() => setSkin(s)} className={`px-2 text-[10px] uppercase ${skin === s ? 'text-white' : 'text-gray-500'}`}>{s}</button>
          ))}
          <button type="button" onClick={() => setIsMinimized(true)} className="px-2 text-[10px]">_</button>
        </div>
      </div>
      <canvas ref={canvasRef} className="w-full h-32 bg-neutral-900 rounded" />
    </div>
  );
});
