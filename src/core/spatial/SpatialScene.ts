/**
 * audioMONASTRY · 5.1.1 – Objektbasiertes Spatial-Scene-Modell
 * =============================================================
 * Formatunabhängige Spatial-Szene: Quellen mit Position/Gain/Spread/Rotation/
 * Distance. Dieselbe Szene rendert auf Stereo/Binaural/Multichannel/Ambisonics.
 */
import type { SpatialSource } from '../interfaces';
import type { ISpatialRenderer } from '../interfaces';

export interface SceneSource extends SpatialSource {
  rotation?: number; // Grad
  distance?: number; // 0..1 (Nähe)
}

export type CoordinateSystem = 'cartesian' | 'polar' | 'ambisonic';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Room {
  id: string;
  width: number;
  depth: number;
  height: number;
  absorption: { x: number; y: number; z: number };
}

export interface Listener {
  id: string;
  position: Vec3;
  orientation: { forward: Vec3; up: Vec3 };
  coordinateSystem: CoordinateSystem;
}

export interface AudioObjectAutomation {
  position: { time: number; value: Vec3 }[];
  gain: { time: number; value: number }[];
}

/** Vom Track entkoppeltes, räumliches Audio-Objekt (Phase 3). */
export interface AudioObject {
  id: string;
  name: string;
  position: Vec3;
  velocity: Vec3;
  gain: number;
  sourceRef: string;
  automation: AudioObjectAutomation;
}

export interface SpatialSceneSnapshot {
  room: Room;
  listener: Listener;
  objects: AudioObject[];
  outputLayout: string;
  mode: 'stereo' | 'spatial';
}

const DEFAULT_ROOM: Room = {
  id: 'default',
  width: 12,
  depth: 10,
  height: 3,
  absorption: { x: 0.3, y: 0.3, z: 0.4 },
};

const DEFAULT_LISTENER: Listener = {
  id: 'listener',
  position: { x: 0, y: 0, z: 1.2 },
  orientation: { forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } },
  coordinateSystem: 'cartesian',
};

export class SpatialScene {
  private sources = new Map<string, SceneSource>();
  private audioObjects = new Map<string, AudioObject>();

  constructor(
    public room: Room = { ...DEFAULT_ROOM, absorption: { ...DEFAULT_ROOM.absorption } },
    public listener: Listener = {
      ...DEFAULT_LISTENER,
      position: { ...DEFAULT_LISTENER.position },
      orientation: {
        forward: { ...DEFAULT_LISTENER.orientation.forward },
        up: { ...DEFAULT_LISTENER.orientation.up },
      },
    },
    public outputLayout = 'stereo',
    public mode: 'stereo' | 'spatial' = 'stereo',
  ) {}

  // --- Phase 3: AudioObject-API (vom Track entkoppelt) ---

  addAudioObject(obj: AudioObject): void {
    if (this.audioObjects.has(obj.id)) throw new Error(`AudioObject existiert bereits: ${obj.id}`);
    this.audioObjects.set(obj.id, obj);
  }

  removeAudioObject(id: string): boolean {
    return this.audioObjects.delete(id);
  }

  getAudioObject(id: string): AudioObject | undefined {
    return this.audioObjects.get(id);
  }

  listAudioObjects(): AudioObject[] {
    return [...this.audioObjects.values()].map((o) => ({ ...o, position: { ...o.position }, velocity: { ...o.velocity } }));
  }

  setAudioObjectPosition(id: string, position: Vec3, time = 0): void {
    const obj = this.audioObjects.get(id);
    if (!obj) return;
    obj.position = { ...position };
    if (time >= 0) obj.automation.position.push({ time, value: { ...position } });
  }

  setAudioObjectGain(id: string, gain: number, time = 0): void {
    const obj = this.audioObjects.get(id);
    if (!obj) return;
    obj.gain = Math.max(0, gain);
    if (time >= 0) obj.automation.gain.push({ time, value: obj.gain });
  }

  setListener(listener: Listener): void {
    this.listener = listener;
  }

  setOutputLayout(layoutId: string): void {
    this.outputLayout = layoutId;
  }

  setMode(mode: 'stereo' | 'spatial'): void {
    this.mode = mode;
  }

  snapshot(): SpatialSceneSnapshot {
    return {
      room: { ...this.room, absorption: { ...this.room.absorption } },
      listener: {
        ...this.listener,
        position: { ...this.listener.position },
        orientation: {
          forward: { ...this.listener.orientation.forward },
          up: { ...this.listener.orientation.up },
        },
      },
      objects: this.listAudioObjects().map((o) => ({
        ...o,
        position: { ...o.position },
        velocity: { ...o.velocity },
        automation: {
          position: o.automation.position.map((p) => ({ time: p.time, value: { ...p.value } })),
          gain: o.automation.gain.map((g) => ({ ...g })),
        },
      })),
      outputLayout: this.outputLayout,
      mode: this.mode,
    };
  }

  // --- Legacy: SceneSource-API (bleibt für bestehende Renderer erhalten) ---

  setSource(src: SceneSource): void {
    this.sources.set(src.id, src);
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  getSource(id: string): SceneSource | undefined {
    return this.sources.get(id);
  }

  listSources(): SceneSource[] {
    return [...this.sources.values()].map((s) => ({ ...s }));
  }

  /** Rendert die komplette Szene (Summe aller Quellen) auf einen Renderer. */
  renderAll(
    renderer: ISpatialRenderer,
    signal: { channelData: Float32Array[]; sampleRate: number },
  ): { channelData: Float32Array[]; sampleRate: number } {
    const len = signal.channelData[0]?.length ?? 0;
    const acc: Float32Array[] = [];
    let rendered = 0;
    for (const src of this.sources.values()) {
      const out = renderer.render(signal, src);
      for (let c = 0; c < out.channelData.length; c++) {
        acc[c] = acc[c] ?? new Float32Array(len);
        for (let i = 0; i < len; i++) acc[c][i] += out.channelData[c][i] ?? 0;
      }
      rendered++;
    }
    if (rendered === 0) return { channelData: signal.channelData, sampleRate: signal.sampleRate };
    return { channelData: acc, sampleRate: signal.sampleRate };
  }

  /** Entfernungs-/Rotations-Gain einer Quelle (Produktions-Näherung). */
  static gainFor(source: SceneSource): number {
    const distanceGain = 1 / (1 + (source.distance ?? 0) * 3);
    const rotationGain = 1 - Math.min(0.5, Math.abs(source.rotation ?? 0) / 360);
    return Math.max(0, Math.min(1, (source.gain ?? 1) * distanceGain * rotationGain));
  }
}

export const spatialScene = new SpatialScene();
