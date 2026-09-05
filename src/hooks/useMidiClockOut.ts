// src/hooks/useMidiClockOut.ts
// ============================================================================
// NEW-MONK-1 · MIDI-Out/Clock an Hardware (Web-MIDI-Anbindung)
// ----------------------------------------------------------------------------
// Bindet die reine Steuerlogik `MidiClockOut` (src/core/hardware) an einen
// Web-MIDI-Ausgabeport. Die Portauswahl bleibt beim Nutzer; ohne Auswahl wird
// der erste verfügbare Ausgang genutzt (Plug & Play).
//
// Zeitstempel: `MIDIOutput.send(data, timestamp)` erwartet die
// `performance.now()`-Zeitbasis – genau die Basis, die auch der Sequencer
// verwendet. Dadurch werden Clock-Pulse jitterarm vorgeplant, ohne den
// Audio-Pfad zu belasten.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MidiClockOut, type MidiOutSink } from '../core/hardware/midiClockOut';

export interface MidiClockOutHandle {
  /** Steuerlogik (Clock/Transport/Noten). */
  clockOut: MidiClockOut;
  /** Verfügbare Ausgabeports (id + Name). */
  ports: Array<{ id: string; name: string }>;
  /** Aktuell gewählter Port (leer = erster verfügbarer). */
  portId: string;
  selectPort: (id: string) => void;
  /** Master-Schalter „MIDI OUT". */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Ist ein Port angebunden? */
  connected: boolean;
}

/**
 * @param outputs Web-MIDI-Ausgänge (aus `useMIDI().outputs`).
 * @param options Kanal/Notenlänge der Drum-Ausgabe.
 */
export function useMidiClockOut(
  outputs: MIDIOutput[],
  options: { drumChannel?: number; noteLengthMs?: number } = {},
): MidiClockOutHandle {
  const { drumChannel, noteLengthMs } = options;
  // Lazy-Init via useState (kein ref.current-Zugriff während des Renderings,
  // vgl. eslint react-hooks/refs). Instanz wird genau einmal erzeugt.
  const [clockOut] = useState(
    () => new MidiClockOut({ drumChannel, noteLengthMs }),
  );

  const [portId, setPortId] = useState('');
  const [enabled, setEnabledState] = useState(false);

  const ports = useMemo(
    () => outputs.map((o) => ({ id: o.id, name: o.name ?? o.id })),
    [outputs],
  );

  // Zielport ableiten (statt setState im Effect, vgl. eslint
  // react-hooks/set-state-in-effect): erster verfügbarer Port als Fallback.
  const target = useMemo(
    () => outputs.find((o) => o.id === portId) ?? outputs[0] ?? null,
    [outputs, portId],
  );
  /** Ist ein Port angebunden? */
  const connected = target !== null;

  // Port anbinden bzw. bei Hotplug-Verlust wieder lösen.
  useEffect(() => {
    if (!target) {
      clockOut.setSink(null);
      return;
    }
    const sink: MidiOutSink = {
      send: (data, timestampMs) => target.send(data, timestampMs),
    };
    clockOut.setSink(sink);
    return () => { clockOut.setSink(null); };
  }, [target, clockOut]);

  const setEnabled = useCallback((on: boolean) => {
    clockOut.setEnabled(on);
    if (!on) clockOut.allNotesOff();
    setEnabledState(on);
  }, [clockOut]);

  // Beim Unmount: laufenden externen Transport sauber beenden.
  // Cleanup als expliziter Block mit lokaler Instanz-Bindung (vgl. eslint
  // react-hooks/refs: keine Methodenaufrufe auf die Hook-Instanz innerhalb
  // einer direkt zurückgegebenen Doppel-Pfeilfunktion).
  useEffect(() => {
    const instance = clockOut;
    return () => {
      instance.stop();
      instance.allNotesOff();
      instance.setSink(null);
    };
  }, [clockOut]);

  return {
    clockOut, ports, portId,
    selectPort: setPortId,
    enabled, setEnabled, connected,
  };
}
