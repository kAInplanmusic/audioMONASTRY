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
import { calculateSquarePerimeterSpeakers } from './v2/squareRoom';

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
  family: 12 | 16 | 18 | 24;
  lfe: number;
  totalChannels: number;
  room: RoomDimensions;
  speakers: SpeakerPlacement[];
}

export const ROOM_PLAN_FAMILIES = [
  { family: 12 as const, base: '12' },
  { family: 16 as const, base: '16' },
  { family: 18 as const, base: '18' },
  { family: 24 as const, base: '24' },
];

/**
 * Square reference layout — uses EXACTLY the same algorithm and speaker IDs
 * as SpatialXYRoomController. A rectangular plan is intentionally rejected
 * rather than quietly showing a physically wrong elliptical installation.
 *
 * Physical channels are STILL just a proposed mapping until a device/bridge
 * has verified ownership and clock/channel synchronization.
 */
export function planRoom(setupId: string, room: RoomDimensions): RoomPlan {
  const setup = getSetup(setupId);
  const count = setup.numChannels;
  if (![12, 16, 18, 24].includes(count)) {
    throw new RangeError('Only 12/16/18/24-satellite square reference layouts are defined');
  }
  if (!Number.isFinite(room.widthM) || !Number.isFinite(room.lengthM) ||
      Math.abs(room.widthM - room.lengthM) > 1e-6) {
    throw new RangeError('spatialMONK requires square rooms (lengthM == widthM)');
  }
  const speakers = calculateSquarePerimeterSpeakers(
    room.widthM, count as 12 | 16 | 18 | 24, setup.lfe as 0 | 1 | 2,
  ).map((speaker, i): SpeakerPlacement => {
    const x = speaker.positionM.x, y = speaker.positionM.y;
    const azimuth = Math.atan2(x, y) * 180 / Math.PI;
    return {
      channel: i + 1,
      name: speaker.role === 'subwoofer' ? 'LFE ' + (i + 1 - count) : 'CH ' + (i + 1),
      kind: speaker.role === 'subwoofer' ? 'lfe' : 'main',
      x, y,
      angleDeg: Math.round((azimuth + 360) % 360),
      distanceM: Math.round(Math.hypot(x, y) * 1000) / 1000,
    };
  });

  return {
    setupId: setup.id,
    family: count as 12 | 16 | 18 | 24,
    lfe: setup.lfe,
    totalChannels: count + setup.lfe,
    room: { lengthM: room.widthM, widthM: room.widthM },
    speakers,
  };
}

/** Calculate square plans for 12/16/18/24 with 0..2 subwoofers. */
export function planAllSetups(room: RoomDimensions): RoomPlan[] {
  return SPATIAL_SETUPS
    .filter((setup) => [12, 16, 18, 24].includes(setup.numChannels))
    .map((setup) => planRoom(setup.id, room));
}

// ============================================================================
// Xonar U7 – a channel-number PROPOSAL, not proof of synchronized devices.
// ============================================================================
export const XONAR_U7_CHANNELS = 8;
export interface XonarDeviceAssignment {
  deviceIndex: number;
  deviceChannel: number; // 0..7 in each U7
  channelName: string;
}
export const XONAR_U7_CHANNEL_NAMES = ['FL', 'FR', 'C', 'LFE', 'RL', 'RR', 'SL', 'SR'];

/** Reference mapping only. Reject insufficient device count, never wrap channels. */
export function assignXonarDevices(plan: RoomPlan, deviceCount = 1): SpeakerPlacement[] {
  if (!Number.isSafeInteger(deviceCount) || deviceCount < Math.ceil(plan.totalChannels / XONAR_U7_CHANNELS)) {
    throw new RangeError('Not enough eight-channel devices for the proposed spatial layout');
  }
  return plan.speakers.map((speaker) => {
    const offset = speaker.channel - 1;
    return { ...speaker, xonar: {
      deviceIndex: Math.floor(offset / XONAR_U7_CHANNELS),
      deviceChannel: offset % XONAR_U7_CHANNELS,
    } };
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
