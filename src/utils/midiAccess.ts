// src/utils/midiAccess.ts – Web-MIDI-Adapter (IHardwareAdapter-Anbindung)
// =============================================================================
// Kapselt die Plattform-API navigator.requestMIDIAccess, damit UI/Kernmodule
// keine direkten WebMIDI-Zugriffe enthalten (Boundary-Regel).
// =============================================================================

export interface WebMidiAccessInfo {
  inputs: number;
  outputs: number;
}

/** Web MIDI wird nur von Chromium/Edge unterstützt (nicht Safari/iOS). */
export function isWebMidiSupported(): boolean {
  return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
}

/** Fragt den MIDI-Zugriff an (SysEx-fähig) und liefert Port-Anzahlen. */
export async function requestWebMidiAccess(sysex = true): Promise<WebMidiAccessInfo> {
  if (!isWebMidiSupported()) {
    throw new Error('Web MIDI wird in diesem Browser nicht unterstützt (Chromium/Edge erforderlich).');
  }
  const access = await navigator.requestMIDIAccess({ sysex });
  return { inputs: access.inputs.size, outputs: access.outputs.size };
}
