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
      aria-label={active ? (status === 'live' ? 'STREAM LIVE' : 'STREAM LOKAL') : status === 'starting' ? 'STREAM STARTET' : 'STREAM'}
      className={`am-tool ${active ? 'am-live' : status === 'starting' ? 'am-on' : ''}`}
      style={{ ['--c' as string]: '#ffb703' }}
    >
      <Radio />
      {active ? <span>LIVE</span> : null}
    </button>
  );
};
