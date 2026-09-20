/**
 * audioMONASTRY · Sequencer-/Pattern-State (AUDIO-P1-002-Muster · aus `audioEngine`)
 * ==================================================================================
 * Kapselt den Step-Sequencer-Zustand: die Patterns je Track, die Synth-Noten,
 * die Mute-Flags der Stems und die Step-Listener-Verwaltung samt Normalisierung
 * auf die aktuelle Schrittanzahl.
 *
 * Fortsetzung des bestehenden Kollaborator-Musters (`MonitorRoutingState`,
 * `WorkletParamBridge`, …): die Engine hält die Pattern-Maps nicht mehr selbst,
 * sondern delegiert. Zeit-/Transportform (Step, BPM) und die V2-Spiegelung
 * bleiben in der Engine und werden als Callbacks hereingereicht, damit hier
 * kein Transport-/Sink-Zugriff entsteht.
 *
 * Verhalten 1:1 aus `audioEngine` übernommen (`patterns`, `synthNotes`,
 * `mutedStems`, `stepListeners`, `normalizeAllPatterns`, `emitStep`,
 * `ensureDemoPattern`, `loadPatterns`, `setStep`, `setPattern`) – reine
 * Struktur-Extraktion, keine Verhaltensänderung.
 */
import type { TrackType } from '../types';
import { normalizeNotes, normalizeSteps } from '../core/audio/state/sequenceUtils';

/** Alle adressierbaren Sequencer-Spuren (Reihenfolge wie in der Engine). */
export const SEQUENCER_TRACKS: TrackType[] = [
  'channel1', 'channel2', 'channel3', 'channel4', 'channel5',
  'channel6', 'channel7', 'channel8', 'channel9', 'channel10',
];

/** Spuren, die das Demo-Pattern befüllt (Sampler-Spuren bewusst ausgenommen). */
const DEMO_TRACKS: TrackType[] = ['channel1', 'channel2', 'channel3', 'channel7', 'channel8'];

function emptyPatterns(): Record<TrackType, boolean[]> {
  const out = {} as Record<TrackType, boolean[]>;
  for (const t of SEQUENCER_TRACKS) out[t] = Array(16).fill(false);
  return out;
}

function emptyMutes(): Record<TrackType, boolean> {
  const out = {} as Record<TrackType, boolean>;
  for (const t of SEQUENCER_TRACKS) out[t] = false;
  return out;
}

export interface SequencerStateDeps {
  /** Spiegelung eines einzelnen Patterns in den Live-Sink (V2). */
  setLivePattern(track: TrackType, pattern: boolean[]): void;
  /** Größe des sequenzierten Rasters (16 oder 32) – liegt in der Engine. */
  getStepCount(): number;
  /** Aktueller Step – liegt in der Engine (öffentliches Feld). */
  getCurrentStep(): number;
}

export class SequencerState {
  private patterns: Record<TrackType, boolean[]> = emptyPatterns();
  private mutedStems: Record<TrackType, boolean> = emptyMutes();
  private synthNotes: number[] = Array(16).fill(0);
  private stepListeners = new Set<(step: number) => void>();
  /** Legacy-Single-Slot-Callback (Engine-Feld `onStepUpdate`). */
  private readonly onStepUpdate: (step: number) => void;

  constructor(
    private readonly deps: SequencerStateDeps,
    onStepUpdate: (step: number) => void,
  ) {
    this.onStepUpdate = onStepUpdate;
  }

  /** Registriert einen Step-Listener; liefert eine Deregistrierungs-Funktion. */
  addStepListener(cb: (step: number) => void): () => void {
    this.stepListeners.add(cb);
    return () => { this.stepListeners.delete(cb); };
  }

  /** Verteilt einen Step an den Legacy-Callback und alle registrierten Listener. */
  emitStep(step: number): void {
    this.onStepUpdate(step);
    this.stepListeners.forEach((l) => l(step));
  }

  /** Alle Patterns (Referenz auf den Zustand; Aufrufer klont bei Bedarf). */
  allPatterns(): Record<TrackType, boolean[]> {
    return this.patterns;
  }

  /** Pattern einer Spur (liegt nach `ensure`/Konstruktion immer vor). */
  pattern(track: TrackType): boolean[] {
    return this.patterns[track];
  }

  /** Synth-Noten der aktuellen Sequenz. */
  getSynthNotes(): number[] {
    return this.synthNotes;
  }

  /** Mute-Flag eines Stems. */
  isMuted(track: TrackType): boolean {
    return Boolean(this.mutedStems[track]);
  }

  /**
   * Bringt alle Patterns + synthNotes auf die aktuelle Schrittanzahl.
   * `stepCount` wird hereingereicht (liegt als öffentliches Feld in der Engine).
   */
  normalizeAll(stepCount: number): void {
    for (const t of SEQUENCER_TRACKS) {
      this.patterns[t] = normalizeSteps(this.patterns[t] ?? [], stepCount);
    }
    this.synthNotes = normalizeNotes(this.synthNotes, stepCount);
  }

  /**
   * Stellt sicher, dass ein hörbares Standard-Drum-Pattern vorliegt. Liefert
   * `true`, wenn neu befüllt wurde (die Engine emittiert dann den Step).
   */
  ensureDemoPattern(): boolean {
    const hasContent = DEMO_TRACKS.some((t) => this.patterns[t].some(Boolean));
    if (hasContent) return false;

    // klassischer Industrieller 4-on-the-Floor-Beat (16tel)
    this.patterns.channel1 = [true,false,false,false,true,false,false,false,true,false,false,false,true,false,false,false];          // kick
    this.patterns.channel2 = [false,false,true,false,false,false,true,false,false,false,true,false,false,false,true,false];          // hat (offbeat)
    this.patterns.channel3 = [false,false,false,false,true,false,false,false,false,false,false,false,true,false,false,false];       // clap (backbeat)
    this.patterns.channel7 = [true,false,true,false,false,true,false,true,true,false,false,true,false,true,false,true];          // bass-Groove
    this.patterns.channel8 = [true,false,false,false,false,false,true,false,true,false,false,false,false,false,true,false];          // lead (nur falls Sample)
    this.synthNotes = [0,4,0,7, 3,7,0,5, 0,3,0,7, 4,0,3,7];
    this.normalizeAll(this.deps.getStepCount());
    return true;
  }

  /** Setzt einen einzelnen Drum-Step (rastergebunden an den Sequencer-StepCount). */
  setStep(track: TrackType, step: number, on: boolean): void {
    if (step < 0 || step >= this.deps.getStepCount()) return;
    this.patterns[track][step] = on;
    this.deps.setLivePattern(track, this.patterns[track]);
  }

  /** Setzt das Muster eines Kanals (16 oder 32 Steps, normalisiert). */
  setPattern(track: TrackType, steps: boolean[]): void {
    if (!steps || (steps.length !== 16 && steps.length !== 32)) return;
    this.patterns[track] = normalizeSteps(steps, this.deps.getStepCount());
    this.deps.setLivePattern(track, this.patterns[track]);
  }

  /**
   * Übernimmt Patterns + synthNotes aus der Sequenzer-/Preset-Logik (defensiv:
   * ungültige Längen werden ignoriert). Liefert die übernommene Pattern-Map.
   */
  applyLoadedPatterns(patterns: Record<string, boolean[]>, synthNotes?: number[]): void {
    const stepCount = this.deps.getStepCount();
    for (const k of SEQUENCER_TRACKS) {
      const arr = patterns?.[k];
      if (arr && Array.isArray(arr) && (arr.length === 16 || arr.length === 32)) {
        this.patterns[k] = normalizeSteps(arr, stepCount);
      }
    }
    if (synthNotes && Array.isArray(synthNotes) && (synthNotes.length === 16 || synthNotes.length === 32)) {
      this.synthNotes = normalizeNotes(synthNotes, stepCount);
    }
  }

  /** Setzt ein Pattern aus einer externen (rohen) Step-Liste (routing.json/Import). */
  applyRawPattern(track: TrackType, steps: boolean[]): void {
    this.patterns[track] = normalizeSteps(steps, this.deps.getStepCount());
  }
}
