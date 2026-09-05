import { useState, useEffect, useCallback, useRef } from 'react';
import { resolveMidiProfile, MidiDeviceType } from '../config/midiDevices';
import {
  MidiStreamParser, midiEventToControlMessage,
} from '../core/hardware/midiCodec';
import type { ParsedMidiEvent } from '../core/hardware/midiCodec';
import { controlMessageToEvent } from '../core/hardware/controlEvent';
import type { ControlEvent } from '../core/interfaces';
import { hotplugManager } from '../core/hardware/HotplugManager';
import { hardwareDiagnostics } from '../core/hardware/diagnostics';
import { deviceProfileStore, buildProfileId } from '../core/hardware/deviceProfile';

export interface DetectedMidiDevice {
  id: string;
  name: string;
  manufacturer?: string;
  profile: string;
  type: MidiDeviceType;
  /** Device-Profile-ID (Fingerprint), falls ein Profil existiert. */
  deviceProfileId?: string;
}

const MAX_EVENT_BUFFER = 64;

/**
 * Purer Web-MIDI-Hook mit robustem Hotplug und vollständigem MIDI-1.0-Parsing:
 * - requestMIDIAccess bevorzugt mit SysEx, Fallback ohne
 * - MidiStreamParser je Port (Running Status, Clock, SysEx, RPN/NRPN …)
 * - onstatechange → Re-Enumeration + Handler-Rebind (Debounce 50 ms)
 * - HotplugManager + HardwareDiagnostics angebunden
 * - Device-Profile-Touch (VID/PID-frei: Namens-Fingerprint, letzte Sichtung)
 */
export const useMIDI = () => {
  const [midiAccess, setMidiAccess] = useState<MIDIAccess | null>(null);
  const [inputs, setInputs] = useState<MIDIInput[]>([]);
  const [outputs, setOutputs] = useState<MIDIOutput[]>([]);
  const [lastMessage, setLastMessage] = useState<MIDIMessageEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<DetectedMidiDevice[]>([]);
  /** Zuletzt geparste MIDI-Events (ein Batch pro onmidimessage). */
  const [parsedEvents, setParsedEvents] = useState<ParsedMidiEvent[]>([]);
  /** Ring-Puffer der letzten ControlEvents (transportagnostisch). */
  const [controlEvents, setControlEvents] = useState<ControlEvent[]>([]);
  const [lastControlEvent, setLastControlEvent] = useState<ControlEvent | null>(null);

  const accessRef = useRef<MIDIAccess | null>(null);
  const boundInputs = useRef<Set<string>>(new Set());
  const parsers = useRef<Map<string, MidiStreamParser>>(new Map());
  const stateChangeTimer = useRef<number | null>(null);
  const eventBuffer = useRef<ControlEvent[]>([]);

  const pushControlEvents = useCallback((events: ControlEvent[]) => {
    if (events.length === 0) return;
    const next = [...eventBuffer.current, ...events];
    if (next.length > MAX_EVENT_BUFFER) next.splice(0, next.length - MAX_EVENT_BUFFER);
    eventBuffer.current = next;
    setControlEvents(next);
    setLastControlEvent(events[events.length - 1]);
  }, []);

  /** Bindet onmidimessage für alle Inputs (idempotent, hotplug-sicher). */
  const bindInputs = useCallback((access: MIDIAccess) => {
    const currentIds = new Set<string>();
    Array.from(access.inputs.values()).forEach((input) => {
      currentIds.add(input.id);
      const deviceId = input.id;
      const name = input.name ?? deviceId;
      if (boundInputs.current.has(input.id)) return;
      boundInputs.current.add(input.id);
      if (!parsers.current.has(input.id)) parsers.current.set(input.id, new MidiStreamParser());
      const parser = parsers.current.get(input.id)!;
      input.onmidimessage = (message) => {
        setLastMessage(message);
        const events = parser.push(message.data as unknown as ArrayLike<number>);
        if (events.length > 0) {
          setParsedEvents(events);
          const ctrlEvents = events.map((ev) => controlMessageToEvent(midiEventToControlMessage(ev), deviceId, 'midi'));
          pushControlEvents(ctrlEvents);
        }
      };
      hotplugManager.attach(`midi:${deviceId}`, name);
      hardwareDiagnostics.log('CONNECT', name, { backend: 'webmidi', deviceId });
    });
    // Bereits entfernte Inputs austragen + Hotplug/Diagnostics melden.
    for (const id of [...boundInputs.current]) {
      if (!currentIds.has(id)) {
        boundInputs.current.delete(id);
        parsers.current.delete(id);
        hotplugManager.detach(`midi:${id}`);
        hardwareDiagnostics.log('DISCONNECT', id, { backend: 'webmidi' });
      }
    }
  }, [pushControlEvents]);

  /** Geräteliste + Auto-Erkennung aktualisieren und Handler neu binden. */
  const refreshDevices = useCallback((access: MIDIAccess) => {
    const ins = Array.from(access.inputs.values());
    const outs = Array.from(access.outputs.values());
    setInputs(ins);
    setOutputs(outs);
    bindInputs(access);

    const merged: DetectedMidiDevice[] = ins.map((i) => {
      const profile = resolveMidiProfile(i.name ?? '', i.manufacturer ?? undefined);
      const deviceProfileId = buildProfileId({ manufacturer: i.manufacturer ?? undefined, product: i.name ?? undefined });
      return {
        id: i.id,
        name: i.name ?? 'Unbekanntes MIDI-Gerät',
        manufacturer: i.manufacturer ?? undefined,
        profile: profile?.profile ?? 'UNKNOWN',
        type: profile?.type ?? 'PAD',
        deviceProfileId,
      };
    });
    setDetected(merged);

    // Device-Profile-Touch (fire-and-forget, nie blockierend).
    for (const d of merged) {
      void deviceProfileStore.find({ manufacturer: d.manufacturer, product: d.name }).then(async (existing) => {
        if (existing) {
          existing.lastSeenAt = Date.now();
          await deviceProfileStore.save(existing);
        }
      }).catch(() => { /* Profil-Persistenz optional */ });
    }
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
      // SysEx bevorzugt (Audit G9); bei Verweigerung Fallback ohne SysEx.
      let access: MIDIAccess;
      try {
        access = await navigator.requestMIDIAccess({ sysex: true });
      } catch {
        access = await navigator.requestMIDIAccess();
      }
      accessRef.current = access;
      setMidiAccess(access);
      setError(null);
      refreshDevices(access);

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
    let cancelled = false;
    // requestAccess asynchron starten: keine synchronen setState-Aufrufe im Effect-Body.
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await requestAccess();
    })();
    const boundInputsSnapshot = boundInputs.current;
    const parsersSnapshot = parsers.current;
    return () => {
      cancelled = true;
      if (stateChangeTimer.current !== null) window.clearTimeout(stateChangeTimer.current);
      const access = accessRef.current;
      if (access) {
        access.onstatechange = null;
        Array.from(access.inputs.values()).forEach((i) => { i.onmidimessage = null; });
      }
      for (const id of [...boundInputsSnapshot]) hotplugManager.detach(`midi:${id}`);
      boundInputsSnapshot.clear();
      parsersSnapshot.clear();
    };
  }, [requestAccess]);

  return {
    midiAccess, inputs, outputs, detected, lastMessage, error, rescan,
    parsedEvents, controlEvents, lastControlEvent,
  };
};
