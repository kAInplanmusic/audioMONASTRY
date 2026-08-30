/**
 * audioMONASTRY · Raumplaner für 12/18/24-Kanal-Setups (12.0–24.2)
 * =================================================================
 * Berechnet aus den Raummaßen (Länge × Breite) für alle drei Zielfamilien
 * (12.x, 18.x, 24.x) einen vollständigen Aufstellplan:
 *  - Kanalnummer
 *  - Position (x/y in Metern relativ zum Hörplatz, Mitte = 0/0)
 *  - Aufstellwinkel (Azimut in Grad, 0° = vorne, im Uhrzeigersinn)
 *  - Abstand zum Hörplatz
 *  - LFE-Platzierung (vorne links/rechts)
 *
 * Zusätzlich: Xonar-U7-Kanalzuordnung (8 Kanäle pro Gerät) für 1/3/4 Stück.
 */
import { getSetup, SPATIAL_SETUPS, type SpatialSetup } from '../../utils/spatialMath';

export interface RoomDimensions {
  /** Raumlänge in Metern (Vorne→Hinten). */
  lengthM: number;
  /** Raumbreite in Metern (Links→Rechts). */
  widthM: number;
}

export interface SpeakerPlacement {
  channel: number;      // 1-basiert (Kanalnummer)
  name: string;         // z. B. 'CH 1' / 'LFE 1'
  kind: 'main' | 'lfe';
  x: number;            // Meter relativ zur Mitte (rechts positiv)
  y: number;            // Meter relativ zur Mitte (vorne positiv)
  angleDeg: number;     // Aufstellwinkel (Azimut, 0=vorne, Uhrzeigersinn)
  distanceM: number;    // Abstand zum Hörplatz
  /** Xonar-U7-Zuordnung (falls zutreffend). */
  xonar?: { deviceIndex: number; deviceChannel: number };
}

export interface RoomPlan {
  setupId: string;
  family: 12 | 18 | 24;
  lfe: number;
  totalChannels: number;
  room: RoomDimensions;
  speakers: SpeakerPlacement[];
}

export const ROOM_PLAN_FAMILIES = [
  { family: 12 as const, base: '12' },
  { family: 18 as const, base: '18' },
  { family: 24 as const, base: '24' },
];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const round = (v: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Ring-Winkel (Radiant) wie im Audio-Panning: 0=vorne, im Uhrzeigersinn. */
function ringAngles(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((i / n) * 2 * Math.PI);
  return out;
}

/** Berechnet einen Aufstellplan für ein Setup und Raummaße. */
export function planRoom(setupId: string, room: RoomDimensions): RoomPlan {
  const setup = getSetup(setupId);
  const family = setup.numChannels as 12 | 18 | 24;
  const lengthM = clamp(room.lengthM, 3, 60);
  const widthM = clamp(room.widthM, 3, 60);
  const rx = widthM / 2;   // Ellipsen-Halbachse links/rechts
  const ry = lengthM / 2;  // Ellipsen-Halbachse vorne/hinten

  const angles = ringAngles(setup.numChannels);
  const speakers: SpeakerPlacement[] = angles.map((az, i) => {
    const x = Math.sin(az) * rx;
    const y = Math.cos(az) * ry;
    const angleDeg = Math.round(((az * 180) / Math.PI + 360) % 360);
    return {
      channel: i + 1,
      name: `CH ${i + 1}`,
      kind: 'main' as const,
      x: round(x),
      y: round(y),
      angleDeg,
      distanceM: round(Math.sqrt(x * x + y * y)),
    };
  });

  // LFE-Platzierung: vorne links/rechts (±45°), abwechselnd.
  const lfeAngles = [-45, 45];
  for (let k = 0; k < setup.lfe; k++) {
    const az = (lfeAngles[k % 2] * Math.PI) / 180;
    const x = Math.sin(az) * rx * 0.9;
    const y = Math.cos(az) * ry * 0.9;
    speakers.push({
      channel: setup.numChannels + k + 1,
      name: `LFE ${k + 1}`,
      kind: 'lfe',
      x: round(x),
      y: round(y),
      angleDeg: Math.round(((az * 180) / Math.PI + 360) % 360),
      distanceM: round(Math.sqrt(x * x + y * y)),
    });
  }

  return {
    setupId: setup.id,
    family,
    lfe: setup.lfe,
    totalChannels: setup.numChannels + setup.lfe,
    room: { lengthM, widthM },
    speakers,
  };
}

/** Berechnet alle neun Pläne (12/18/24 × .0/.1/.2) für die Raummaße. */
export function planAllSetups(room: RoomDimensions): RoomPlan[] {
  return SPATIAL_SETUPS
    .filter((s) => [12, 18, 24].includes(s.numChannels))
    .map((s) => planRoom(s.id, room));
}

// ============================================================================
// Xonar U7 – 8-Kanal-USB-DAC (7.1). Mehrere Geräte = Kanal-Bündelung.
// ============================================================================

export const XONAR_U7_CHANNELS = 8;

export interface XonarDeviceAssignment {
  deviceIndex: number;
  deviceChannel: number; // 0..7 im U7
  channelName: string;
}

export const XONAR_U7_CHANNEL_NAMES = ['FL', 'FR', 'C', 'LFE', 'RL', 'RR', 'SL', 'SR'];

/** Ordnet die Kanäle eines Plans auf 1..n Xonar-U7-Geräte zu. */
export function assignXonarDevices(plan: RoomPlan, deviceCount = 1): SpeakerPlacement[] {
  return plan.speakers.map((sp) => {
    const ch = sp.channel - 1; // 0-basiert global
    const deviceIndex = Math.floor(ch / XONAR_U7_CHANNELS) % Math.max(1, deviceCount);
    const deviceChannel = ch % XONAR_U7_CHANNELS;
    return {
      ...sp,
      xonar: {
        deviceIndex,
        deviceChannel,
      },
    };
  });
}

/** Benötigte Xonar-U7-Geräte für ein Setup. */
export function requiredXonarDevices(plan: RoomPlan): number {
  return Math.ceil(plan.totalChannels / XONAR_U7_CHANNELS);
}

/** Ist ein Gerätename eine ASUS Xonar U7? */
export function isXonarU7(name: string): boolean {
  return /xonar|u7|asus/i.test(name);
}

export type { SpatialSetup };
