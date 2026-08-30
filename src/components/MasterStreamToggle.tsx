import React from 'react';
import { Radio } from 'lucide-react';
import { useMasterStream } from '../hooks/useMasterStream';

/**
 * MasterStreamToggle – STREAM AN/AUS im Studio-Header.
 * SFU-Session → Master-Audio geht an die Peers; ohne SFU → lokaler Stream.
 */
export const MasterStreamToggle: React.FC = () => {
  const { status, start, stop } = useMasterStream();
  const active = status === 'live' || status === 'live-local';

  return (
    <button
      type="button"
      onClick={() => (active ? stop() : void start())}
      aria-pressed={active}
      title={active ? 'Master-Stream stoppen' : 'Master-Stream starten'}
      className={`px-3 py-2 rounded-full border text-[9px] font-bold tracking-widest flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer ${
        active
          ? 'bg-red-900/40 border-red-500/60 text-red-300 animate-pulse'
          : status === 'starting'
            ? 'bg-amber-900/30 border-amber-500/40 text-amber-300'
            : 'bg-neutral-900/80 border-neutral-800 text-neutral-400 hover:text-cyan-300 hover:border-cyan-400/50'
      }`}
    >
      <Radio className="w-3.5 h-3.5" />
      {active ? (status === 'live' ? 'STREAM LIVE' : 'STREAM LOKAL') : status === 'starting' ? 'STARTE…' : 'STREAM'}
    </button>
  );
};
