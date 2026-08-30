import { TrackType, ALL_TRACKS, roleOf } from '../types';

export interface RoutingConfig {
  tracks: any[];
  buses: any[];
  connections: any[];
}

// Zuordnung: rationale Rolle -> erwartete Instrument-/DSP-Module
export const ROLE_INSTRUMENT_MAP: Record<string, string[]> = {
  kick: ['kickSynth', 'MembraneSynth', 'Drum'],
  hat: ['hatSynth', 'MetalSynth', 'HiHat'],
  clap: ['clapSynth', 'NoiseSynth', 'Clap'],
  perc: ['perc', 'Sampler', 'Percussion'],
  snare: ['snare', 'Sampler', 'Snare'],
  tom: ['tom', 'Sampler', 'Tom'],
  bass: ['bassSynth', 'MonoSynth', 'Bass'],
  lead: ['lead', 'Sampler', 'Synth', 'leadSynth'],
};

/**
 * Validierung eines Routing-Configs gegen das einheitliche Track-Role-Modell.
 * - Bus-Effekt-Sequenz: konsistente Kette ohne offensichtliche Fehler.
 * - Connections: Quellen/Ziele müssen existieren.
 * - Track-Rollen: `instrument` eines Tracks sollte zu seiner semantischen
 *   Spurrolle (channelN) passen.
 */
export function validateRouting(config: RoutingConfig): boolean { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
  // 1. Validate Bus Effects: jede Quelle in einer Kette besitzt ein valides Ziel
  for (const bus of config.buses) {
    if (bus.effects && Array.isArray(bus.effects)) {
      const effectTypes = bus.effects.map((e: any) => e.type);
      for (const t of effectTypes) {
        if (typeof t !== 'string' || t.length === 0) {
          console.error(`Invalid effect type in bus ${bus.id}:`, t);
          return false;
        }
      }
    }
  }

  // 2. Validate Connections point to valid buses/tracks
  const busIds = new Set(config.buses.map((b: any) => b.id));
  const trackIds = new Set(config.tracks.map((t: any) => t.id));

  for (const conn of config.connections) {
    if (!trackIds.has(conn.source) && !busIds.has(conn.source)) {
      console.error(`Invalid source in connection: ${conn.source}`);
      return false;
    }
    if (!busIds.has(conn.destination) && conn.destination !== 'destination') {
      console.error(`Invalid destination in connection: ${conn.destination}`);
      return false;
    }
  }

  // 3. Validate track roles vs. instruments (sofern `instrument` gesetzt)
  for (const track of config.tracks) {
    if (!track || typeof track.id !== 'string') continue;
    const trackId = track.id as string;
    if (!ALL_TRACKS.includes(trackId as TrackType)) {
      // Nicht unbedingt ein Fehler (kann auch ein benannter Bus sein), wir prüfen nur die bekannte Mapping-Spur.
      continue;
    }
    const role = roleOf(trackId as TrackType);
    if (track.instrument && typeof track.instrument === 'string') {
      const allowed = ROLE_INSTRUMENT_MAP[role] ?? [];
      const instName = String(track.instrument).toLowerCase();
      const ok = allowed.some(a => instName.includes(a.toLowerCase()) || a.toLowerCase().includes(instName));
      if (!ok) {
        console.warn(`Track ${trackId} (Rolle ${role}) nutzt Instrument '${track.instrument}' – evtl. inkonsistent.`);
        // Nicht hart fehlschlagen (Valdierung tolerant), nur Warnung.
      }
    }
  }

  return true;
}
