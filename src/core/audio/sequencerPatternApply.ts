/**
 * audioMONASTRY · Pattern-Anwendung aus Events (MONK-2026-11-06-001)
 * ===================================================================
 * Schließt den Pfad `SoundTerminal → ControlBus/Sequencer → Engine`:
 *
 *   controlBus.emit('sequencer:apply-patterns', …)   (typisiert, SoundTerminal)
 *   window.dispatchEvent('monk:apply-patterns', …)   (Legacy/Automation, Stresstest)
 *                          │
 *                          ▼
 *                SequencerPatternApplier
 *                          │  target.loadPatterns(patterns, synthNotes, bpm)
 *                          ▼
 *                    audioEngine (SequencerState)
 *
 * Es gibt bewusst KEINE zweite Pattern-Logik: der Applier normalisiert nichts,
 * er validiert nur die Nutzlast und reicht sie an genau die Engine-Methode
 * weiter, die auch Preset-/Session-Laden benutzt (`audioEngine.loadPatterns`,
 * inkl. BPM). Der Stresstest dispatcht `monk:apply-patterns` – deshalb muss der
 * Legacy-Name hier ebenso landen wie der Bus-Kanal.
 *
 * Nutzlast:
 *   { patterns, synthNotes?, bpm? }  – eine Pattern-Matrix (8 Spuren × 16/32)
 *   { slots: [patterns, …], bpm? }   – bis zu MAX_PATTERN_SLOTS Pattern-Slots
 *                                      (A–D), in Reihenfolge angewendet
 */
import { ALL_TRACKS, type TrackType } from '../../types';
import { controlBus, type ControlBus } from '../events/ControlBus';

/** Typisierter Bus-Kanal (ControlBus). */
export const APPLY_PATTERNS_EVENT = 'sequencer:apply-patterns';
/** Legacy-/Automations-Name als window-CustomEvent (Stresstest, externe Tools). */
export const LEGACY_APPLY_PATTERNS_EVENT = 'monk:apply-patterns';
/** Pattern-Slots A–D: mehr als vier werden verworfen. */
export const MAX_PATTERN_SLOTS = 4;
/** Gültige Rastergrößen des Sequencers. */
const VALID_STEP_LENGTHS = [16, 32];

export type PatternMatrix = Record<string, boolean[]>;

export interface ApplyPatternsDetail {
  patterns?: PatternMatrix;
  synthNotes?: number[];
  bpm?: number;
  slots?: PatternMatrix[];
}

/** Engine-Seite: genau die Methode, die auch Presets/Sessions benutzen. */
export interface PatternApplyTarget {
  loadPatterns(patterns: Record<string, boolean[]>, synthNotes?: number[], bpm?: number): void;
}

export interface ApplyStats {
  /** Anzahl angewendeter Pattern-Matrizen (Slots zählen einzeln). */
  applied: number;
  /** Anzahl Events, die mindestens einen Slot angewendet haben. */
  events: number;
  /** Anzahl verworfener Nutzlasten (ungültig/leer). */
  rejected: number;
  /** Zuletzt angewendete Slot-Anzahl eines Events. */
  slotsApplied: number;
  /** Zuletzt angewendetes Tempo (0 = keins mitgeschickt). */
  lastBpm: number;
  lastError: string | null;
}

/** Kopiert nur gültige Schritt-Arrays (16/32) der bekannten Spuren. */
function sanitizeMatrix(raw: unknown): PatternMatrix | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: PatternMatrix = {};
  let tracks = 0;
  for (const track of ALL_TRACKS as TrackType[]) {
    const steps = source[track];
    if (!Array.isArray(steps) || !VALID_STEP_LENGTHS.includes(steps.length)) continue;
    out[track] = steps.map((v) => Boolean(v));
    tracks += 1;
  }
  return tracks > 0 ? out : null;
}

/** Prüft/säubert synthNotes (nur 16/32 Zahlen). */
function sanitizeNotes(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || !VALID_STEP_LENGTHS.includes(raw.length)) return undefined;
  if (!raw.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return raw.slice();
}

/**
 * Nimmt Event-Nutzlasten an und schreibt sie über den Engine-Adapter in den
 * Sequencer. Rein Main-Thread, keine eigene Pattern-Logik.
 */
export class SequencerPatternApplier {
  private applied = 0;
  private events = 0;
  private rejected = 0;
  private slotsApplied = 0;
  private lastBpm = 0;
  private lastError: string | null = null;

  constructor(private readonly target: PatternApplyTarget) {}

  /** Liefert true, wenn mindestens eine Matrix angewendet wurde. */
  apply(detail: unknown): boolean {
    if (!detail || typeof detail !== 'object') {
      this.reject('Nutzlast ist kein Objekt');
      return false;
    }
    const payload = detail as ApplyPatternsDetail;
    const matrices: PatternMatrix[] = [];

    if (Array.isArray(payload.slots)) {
      for (const slot of payload.slots.slice(0, MAX_PATTERN_SLOTS)) {
        const clean = sanitizeMatrix(slot);
        if (clean) matrices.push(clean);
      }
    }
    if (matrices.length === 0) {
      const single = sanitizeMatrix(payload.patterns);
      if (single) matrices.push(single);
    }
    if (matrices.length === 0) {
      this.reject('keine gültige Pattern-Matrix (16/32 Steps)');
      return false;
    }

    const bpm =
      typeof payload.bpm === 'number' && Number.isFinite(payload.bpm)
        ? Math.max(30, Math.min(300, payload.bpm))
        : undefined;
    const synthNotes = sanitizeNotes(payload.synthNotes);

    try {
      for (const matrix of matrices) {
        // Dieselbe Engine-Methode wie Preset-/Session-Laden: keine Kopie der
        // Normalisierung, keine zweite Pattern-Implementierung.
        this.target.loadPatterns(matrix, synthNotes, bpm);
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }

    this.applied += matrices.length;
    this.events += 1;
    this.slotsApplied = matrices.length;
    this.lastBpm = bpm ?? 0;
    this.lastError = null;
    return true;
  }

  private reject(reason: string): void {
    this.rejected += 1;
    this.lastError = reason;
  }

  snapshot(): ApplyStats {
    return {
      applied: this.applied,
      events: this.events,
      rejected: this.rejected,
      slotsApplied: this.slotsApplied,
      lastBpm: this.lastBpm,
      lastError: this.lastError,
    };
  }
}

export interface InstallOptions {
  /** Engine-Adapter (im Betrieb `audioEngine`). */
  target: PatternApplyTarget;
  /** Bus, dessen Kanal `sequencer:apply-patterns` abonniert wird. */
  bus?: ControlBus;
  /** Fenster für den Legacy-Namen `monk:apply-patterns` (Default: global). */
  win?: Window;
  /** Vorgefertigter Applier (Tests/Diagnose); sonst neu erzeugt. */
  applier?: SequencerPatternApplier;
  /** Globaler Messhaken für E2E (Default an): `window.__monkPatternApplyStats()`. */
  exposeStats?: boolean;
}

export interface InstallHandle {
  applier: SequencerPatternApplier;
  uninstall(): void;
}

/** Einmalige Installation (StrictMode/Doppelaufruf darf nicht doppelt hören). */
let installed: InstallHandle | null = null;

/**
 * Verbindet Bus-Kanal + Legacy-window-Event mit der Engine. Idempotent:
 * ein zweiter Aufruf liefert die bestehende Installation.
 */
export function installSequencerPatternApply(options: InstallOptions): InstallHandle {
  if (installed) return installed;

  const bus = options.bus ?? controlBus;
  const win = options.win ?? (typeof window !== 'undefined' ? window : undefined);
  const applier = options.applier ?? new SequencerPatternApplier(options.target);

  const offBus = bus.on<ApplyPatternsDetail>(APPLY_PATTERNS_EVENT, (detail) => {
    applier.apply(detail);
  });

  const onLegacy = (event: Event) => {
    applier.apply((event as CustomEvent<ApplyPatternsDetail>).detail);
  };
  win?.addEventListener(LEGACY_APPLY_PATTERNS_EVENT, onLegacy);

  if (options.exposeStats !== false && win) {
    (win as unknown as { __monkPatternApplyStats?: () => ApplyStats }).__monkPatternApplyStats =
      () => applier.snapshot();
  }

  const handle: InstallHandle = {
    applier,
    uninstall() {
      offBus();
      win?.removeEventListener(LEGACY_APPLY_PATTERNS_EVENT, onLegacy);
      if (win) {
        delete (win as unknown as { __monkPatternApplyStats?: () => ApplyStats }).__monkPatternApplyStats;
      }
      if (installed === handle) installed = null;
    },
  };
  installed = handle;
  return handle;
}
