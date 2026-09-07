/**
 * audioMONASTRY · AudioBackend Interface (Phase 1 Split)
 * =======================================================
 * Stand: 2026-09-07
 * Ziel: Einheitliche Schnittstelle für Audio-Rückseiten (Web Audio, WASM, etc.)
 */

/** Abstrakte Audio-Rückseite: setup, process, teardown */
export interface AudioBackend {
  /** Initialisiert die Backend (z.B. AudioContext erstellen) */
  setup(): Promise<void>;
  
  /** Verarbeitet Audio-Samples (oderbereitstellt) */
  process(input: Float32Array): Float32Array;
  
  /** Teardown: Ressourcen freigeben */
  teardown(): void;
  
  /** Prüft, ob Backend unterstützt wird */
  isSupported(): boolean;
  
  /** Latenz (in Samples), wenn bekannt */
  getLatency(): number;
}

/** Web Audio-spezifische Backend-Erweiterung */
export interface WebAudioBackend extends AudioBackend {
  /** Web Audio Context */
  context: AudioContext | null;
  
  /** Master Gain Node */
  masterGain: GainNode | null;
  
  /** Worklet-Registry */
  workletRegistry: Map<string, string>;
  
  /** Worklets registrieren (code: base64 oder blob URL) */
  registerWorklet(name: string, code: string | Blob): Promise<void>;
  
  /** Worklet-Knoten erstellen */
  createWorkletNode(name: string, numParams?: number): AudioWorkletNode | null;
}
