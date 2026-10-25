/**
 * PianoRollTerminal – Piano-Roll-Panel (ZUK-001)
 * =============================================
 * Eigenständiges Panel: Titel "Piano Roll", Einklappen-Button, Spur-Auswahl,
 * rendert den Piano-Roll-Editor angebunden an den gemeinsamen Noten-Store
 * (`src/core/sequencer/pianoRollStore.ts`). Persistenz über
 * `pianoRollPersistence.ts` (Plugin-Settings). Der Store ist ein NEUER
 * Noten-Store – der Engine-Sequencer hält nur boolesche Step-Patterns
 * ohne Pitch/Länge/Velocity (siehe Code-Kommentar im Store).
 *
 * Mount: <PianoRollTerminal /> in StudioMastergraph (einzeilig, Parent-Agent).
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ALL_TRACKS, type TrackType } from '../../types';
import { PianoRoll, PianoRollProps } from '../piano/PianoRoll';
import { pianoRollStore } from '../../core/sequencer/pianoRollStore';
import { readPersistedPianoRoll, writePersistedPianoRoll } from '../piano/pianoRollPersistence';

interface PianoRollTerminalProps {
  /** Optional: eigener Store (Tests/Storybook). Default = globaler Singleton. */
  store?: typeof pianoRollStore;
  /** Optional: initiale Einklappung. */
  initialCollapsed?: boolean;
}

const TRACK_LABELS: Record<TrackType, string> = {
  channel1: 'Kick / Drop (CH1)',
  channel2: 'Song / Lead (CH2)',
  channel3: 'Drumsampler / Hat (CH3)',
  channel4: 'Syntisampler / Snare (CH4)',
  channel5: 'Instru / Perc (CH5)',
  channel6: 'Voice (CH6)',
  channel7: 'Sound (CH7)',
  channel8: 'Stem / Bass (CH8)',
};

/** Hook: abonniert Noten einer Spur am Store (useSyncExternalStore). */
function usePianoRollNotes(track: string, store: typeof pianoRollStore): PianoRollProps['notes'] {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return snapshot.tracks[track] ?? [];
}

/** Hook: einmalige Hydration aus Plugin-Settings (Effect, nicht Render-Phase). */
function useHydrateOnce(store: typeof pianoRollStore): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    const persisted = readPersistedPianoRoll();
    if (persisted) store.load(persisted);
    done.current = true;
  }, [store]);
}

export const PianoRollTerminal: React.FC<PianoRollTerminalProps> = React.memo(
  function PianoRollTerminal({ store = pianoRollStore, initialCollapsed = false }) {
    const [collapsed, setCollapsed] = useState(initialCollapsed);
    const [selectedTrack, setSelectedTrack] = useState<TrackType>('channel1');

    useHydrateOnce(store);
    const notes = usePianoRollNotes(selectedTrack, store);

    const handleChange = useCallback(
      (nextNotes: PianoRollProps['notes']) => {
        store.setNotes(selectedTrack, nextNotes);
        writePersistedPianoRoll(store.serialize());
      },
      [store, selectedTrack],
    );

    const handleTrackChange = (track: TrackType) => setSelectedTrack(track);

    const toggleCollapse = () => setCollapsed((c) => !c);

    // Anzahl Noten für Subtitle
    const noteCount = notes.length;

    return (
      <section
        id="rack-pianoroll"
        className="am-box am-mp"
        aria-label="Piano Roll, Noten-Editor"
        style={{ minHeight: collapsed ? 'auto' : 420, overflow: 'hidden' }}
      >
        <div
          className="am-mpt"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b>Piano Roll</b>
            <small style={{ color: '#9ca3af' }}>
              {TRACK_LABELS[selectedTrack]} · {noteCount} Note{noteCount !== 1 ? 'n' : ''}
            </small>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label htmlFor="pr-track-select" style={{ fontSize: 11, color: '#9ca3af' }}>
              Spur
            </label>
            <select
              id="pr-track-select"
              value={selectedTrack}
              onChange={(e) => handleTrackChange(e.target.value as TrackType)}
              aria-label="Piano-Roll-Spur"
              style={{
                padding: '2px 6px',
                fontSize: 11,
                background: '#111827',
                color: '#e5e7eb',
                border: '1px solid #1f2937',
                borderRadius: 4,
              }}
            >
              {ALL_TRACKS.map((t) => (
                <option key={t} value={t}>
                  {TRACK_LABELS[t]}
                </option>
              ))}
            </select>

            <button
              type="button"
              aria-expanded={!collapsed}
              aria-controls="pr-body"
              onClick={toggleCollapse}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                background: '#1f2937',
                color: '#e5e7eb',
                border: '1px solid #374151',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              {collapsed ? '▸ Ausklappen' : '▾ Einklappen'}
            </button>
          </div>
        </div>

        <div id="pr-body" style={{ display: collapsed ? 'none' : 'block' }}>
          <PianoRoll notes={notes} onChange={handleChange} />
        </div>
      </section>
    );
  },
);

PianoRollTerminal.displayName = 'PianoRollTerminal';

export default PianoRollTerminal;