import { useState, useEffect, useCallback, useRef } from 'react';
import { resolveMidiProfile, MidiDeviceType } from '../config/midiDevices';

export interface DetectedMidiDevice {
  id: string;
  name: string;
  manufacturer?: string;
  profile: string;
  type: MidiDeviceType;
}

/**
 * Purer Web-MIDI-Hook (kein WebHID, keine Abhängigkeiten) mit robustem
 * Hotplug:
 * - requestMIDIAccess (sysex: false)
 * - onstatechange → sofortige Re-Enumeration + Message-Handler-Rebind
 *   (neue Geräte bekommen ihren onmidimessage-Handler, entfernte werden
 *   vergessen). Debounce gegen doppelte statechange-Events.
 * - Cleanup beim Unmount (Handler entfernen, statechange abmelden).
 */
export const useMIDI = () => {
  const [midiAccess, setMidiAccess] = useState<MIDIAccess | null>(null);
  const [inputs, setInputs] = useState<MIDIInput[]>([]);
  const [outputs, setOutputs] = useState<MIDIOutput[]>([]);
  const [lastMessage, setLastMessage] = useState<MIDIMessageEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Auto-Erkannte, auf Profile aufgelöste Geräte (Plug-and-Play).
  const [detected, setDetected] = useState<DetectedMidiDevice[]>([]);

  const accessRef = useRef<MIDIAccess | null>(null);
  const boundInputs = useRef<Set<string>>(new Set());
  const stateChangeTimer = useRef<number | null>(null);

  /** Bindet onmidimessage für alle Inputs (idempotent, hotplug-sicher). */
  const bindInputs = useCallback((access: MIDIAccess) => {
    const currentIds = new Set<string>();
    Array.from(access.inputs.values()).forEach((input) => {
      currentIds.add(input.id);
      if (boundInputs.current.has(input.id)) return;
      boundInputs.current.add(input.id);
      input.onmidimessage = (message) => setLastMessage(message);
    });
    // Bereits entfernte Inputs aus dem gebundenen Set austragen.
    boundInputs.current = new Set([...boundInputs.current].filter((id) => currentIds.has(id)));
  }, []);

  /** Geräteliste + Auto-Erkennung aktualisieren und Handler neu binden. */
  const refreshDevices = useCallback((access: MIDIAccess) => {
    const ins = Array.from(access.inputs.values());
    const outs = Array.from(access.outputs.values());
    setInputs(ins);
    setOutputs(outs);
    bindInputs(access);

    // Auto-Erkennung: jedes Input-Gerät zum Profil auflösen.
    const merged: DetectedMidiDevice[] = ins.map((i) => {
      const profile = resolveMidiProfile(i.name ?? '', i.manufacturer ?? undefined);
      return {
        id: i.id,
        name: i.name ?? 'Unbekanntes MIDI-Gerät',
        manufacturer: i.manufacturer ?? undefined,
        profile: profile?.profile ?? 'UNKNOWN',
        type: profile?.type ?? 'PAD',
      };
    });
    setDetected(merged);
  }, [bindInputs]);

  const requestAccess = useCallback(async () => {
    if (!window.isSecureContext || !navigator.requestMIDIAccess) {
      const msg = !window.isSecureContext
        ? 'MIDI nicht verfügbar: Site ist nicht über HTTPS (oder localhost).'
        : 'MIDI wird von diesem Browser nicht unterstützt.';
      setError(msg);
      console.warn(msg);
      return;
    }

    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      accessRef.current = access;
      setMidiAccess(access);
      setError(null);
      refreshDevices(access);

      // Hotplug: bei statechange sofort neu enumerieren + Handler binden.
      // Debounce, weil manche Browser mehrere statechange-Events feuern.
      access.onstatechange = () => {
        if (stateChangeTimer.current !== null) window.clearTimeout(stateChangeTimer.current);
        stateChangeTimer.current = window.setTimeout(() => {
          stateChangeTimer.current = null;
          refreshDevices(access);
        }, 50);
      };
    } catch (err: any) {
      const msg = `MIDI Access verweigert: ${err?.message || 'Unbekannt'}`;
      setError(msg);
      console.error(msg);
    }
  }, [refreshDevices]);

  /** Manueller Rescan (z. B. Button "RESCAN USB PORTS"). */
  const rescan = useCallback(() => {
    if (accessRef.current) {
      refreshDevices(accessRef.current);
    } else {
      requestAccess();
    }
  }, [refreshDevices, requestAccess]);

  useEffect(() => {
    requestAccess();
    return () => {
      if (stateChangeTimer.current !== null) window.clearTimeout(stateChangeTimer.current);
      const access = accessRef.current;
      if (access) {
        access.onstatechange = null;
        Array.from(access.inputs.values()).forEach((i) => { i.onmidimessage = null; });
      }
      boundInputs.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { midiAccess, inputs, outputs, detected, lastMessage, error, rescan };
};
