import type {
  IAudioBackend,
  IAIRuntime,
  IComputeBackend,
  IHardwareAdapter,
  ISpatialRenderer,
  ITransport,
} from '../core/interfaces';
import type { PluginState } from './types';

/**
 * audioMONASTRY · Canonical Plugin Runtime Contract (TypeScript)
 * ==============================================================
 * Browser-Runtime-Spiegelung des sprachübergreifenden Vertrags
 * `/plugin_interface.py`. Diese Schnittstelle ist die EINZIGE
 * Runtime-Schnittstelle der 16 kanonischen Plugin-Adapter.
 */

export type CanonicalPluginId =
  | 'mixer'
  | 'drop'
  | 'song'
  | 'effect'
  | 'syntisampler'
  | 'drumsampler'
  | 'instru'
  | 'biblio'
  | 'voice'
  | 'sound'
  | 'stem'
  | 'spatial'
  | 'eq'
  | 'dsp'
  | 'master'
  | 'record';

type PluginCapability =
  | 'audio-source'
  | 'audio-processor'
  | 'audio-mixer'
  | 'audio-router'
  | 'ai'
  | 'compute'
  | 'spatial'
  | 'hardware'
  | 'library'
  | 'analysis'
  | 'recording';

export interface PluginAudioBlock {
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  readonly timestamp: number;
  readonly frameCount: number;
}

export interface PluginManifest {
  readonly id: CanonicalPluginId;
  readonly name: string;
  readonly version: string;
  readonly kind: PluginCapability;
  readonly capabilities: readonly PluginCapability[];
  readonly latencySamples: number;
  readonly tailSamples: number;
}

export interface PluginRuntimeContext {
  readonly audio: IAudioBackend;
  readonly ai?: IAIRuntime;
  readonly compute?: IComputeBackend;
  readonly spatial?: ISpatialRenderer;
  readonly hardware?: IHardwareAdapter;
  readonly transport?: ITransport;
  readonly userId: string;
  readonly requestLock: (pluginId: CanonicalPluginId) => boolean;
  readonly releaseLock: (pluginId: CanonicalPluginId) => void;
  readonly isLockedByOther: (pluginId: CanonicalPluginId) => boolean;
  readonly log: (event: string, payload?: Record<string, unknown>) => void;
}

export interface PluginParameterValue {
  readonly name: string;
  readonly value: number | string | boolean;
}

export interface PluginCommand {
  readonly name: string;
  readonly payload?: Record<string, unknown>;
}

export interface PluginSnapshot {
  readonly pluginId: CanonicalPluginId;
  readonly state: PluginState;
  readonly parameters: Record<string, number | string | boolean>;
  readonly data?: Record<string, unknown>;
}

export interface PluginInterface {
  readonly manifest: PluginManifest;
  readonly state: PluginState;

  initialize(context: PluginRuntimeContext): Promise<void>;
  setState(next: PluginState): void;
  setParameter(parameter: PluginParameterValue): void;

  /**
   * Synchroner Echtzeitpfad.
   * Keine Promises, kein fetch(), kein Storage und kein React-State hier.
   */
  process(block: PluginAudioBlock): PluginAudioBlock;

  /**
   * Asynchrone UI-/AI-/Netzwerk-/Analyseaktionen.
   */
  handleCommand(command: PluginCommand): Promise<unknown>;

  snapshot(): PluginSnapshot;
  restore(snapshot: PluginSnapshot): void;
  dispose(): Promise<void>;
}
