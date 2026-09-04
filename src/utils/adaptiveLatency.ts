/**
 * audioMONASTRY · Adaptive-Latenz-Policy (AM-E6-2)
 * =================================================
 * Zentrale Richtlinie für „Latenz vs. Durchsatz“:
 *   * Basis-Lookahead je Latenz-Profil (interactive 8 ms, balanced 12 ms,
 *     playback 15 ms) – identisch mit AudioEngine.applyLatencyProfile.
 *   * Xruns/Underruns erhöhen das Lookahead schrittweise (max. 15 ms).
 *   * Ab einer Schwelle (3 konsekutive Xruns) wird das Latenz-Profil eine
 *     Stufe hochgesetzt (interactive → balanced → playback). Ein höheres
 *     Profil bedeutet beim nächsten AudioContext-Aufbau einen größeren
 *     Puffer (latencyHint), also mehr Robustheit gegen Dropouts.
 *   * Stabile Fenster (recordStableWindow) bauen den Xrun-Zähler wieder ab,
 *     damit die Latenz nach einer Störung nicht dauerhaft hoch bleibt.
 *
 * Die Policy ist bewusst plattformfrei (keine AudioContext-API), damit sie
 * in Tests deterministisch geprüft werden kann. Die AudioEngine wendet die
 * empfohlenen Werte an (Lookahead sofort, latencyHint beim Context-Aufbau).
 */

export type LatencyProfile = 'interactive' | 'balanced' | 'playback';

export const LATENCY_PROFILE_LOOKAHEAD_MS: Record<LatencyProfile, number> = {
  interactive: 8,
  balanced: 12,
  playback: 15,
};

const PROFILE_ORDER: LatencyProfile[] = ['interactive', 'balanced', 'playback'];
const MAX_LOOKAHEAD_MS = 15;
/** Nach 3 konsekutiven Xruns wird das Latenz-Profil eine Stufe angehoben. */
const XRUN_ESCALATE_THRESHOLD = 3;

export interface AdaptiveLatencySnapshot {
  profile: LatencyProfile;
  consecutiveXruns: number;
  lookaheadMs: number;
  escalated: boolean;
}

export class AdaptiveLatencyController {
  private profile: LatencyProfile = 'playback';
  private consecutiveXruns = 0;
  private lookaheadMs = LATENCY_PROFILE_LOOKAHEAD_MS.playback;
  private escalated = false;

  constructor(initial: LatencyProfile = 'playback') {
    this.applyProfile(initial);
  }

  /** Setzt die Basis (Nutzer-Einstellung) zurück und verwirft Eskalationen. */
  applyProfile(profile: LatencyProfile): void {
    this.profile = profile;
    this.consecutiveXruns = 0;
    this.escalated = false;
    this.lookaheadMs = LATENCY_PROFILE_LOOKAHEAD_MS[profile];
  }

  /**
   * Meldet einen Xrun/Underrun und liefert das empfohlene Lookahead in ms.
   * Alle XRUN_ESCALATE_THRESHOLD konsekutiven Xruns wird das Profil eine
   * Stufe angehoben (größerer Puffer beim nächsten Context-Aufbau), maximal
   * bis `playback`.
   */
  recordXrun(): number {
    this.consecutiveXruns += 1;
    if (this.consecutiveXruns % XRUN_ESCALATE_THRESHOLD === 0) {
      const idx = PROFILE_ORDER.indexOf(this.profile);
      if (idx < PROFILE_ORDER.length - 1) {
        this.profile = PROFILE_ORDER[idx + 1];
        this.escalated = true;
      }
    }
    this.lookaheadMs = this.computeLookahead();
    return this.lookaheadMs;
  }

  /** Stabiles Audio-Fenster (z. B. Watchdog): Xrun-Zähler langsam abbauen. */
  recordStableWindow(): number {
    if (this.consecutiveXruns > 0) {
      this.consecutiveXruns -= 1;
      this.lookaheadMs = this.computeLookahead();
    }
    return this.lookaheadMs;
  }

  snapshot(): AdaptiveLatencySnapshot {
    return {
      profile: this.profile,
      consecutiveXruns: this.consecutiveXruns,
      lookaheadMs: this.lookaheadMs,
      escalated: this.escalated,
    };
  }

  private computeLookahead(): number {
    return Math.min(
      MAX_LOOKAHEAD_MS,
      LATENCY_PROFILE_LOOKAHEAD_MS[this.profile] + this.consecutiveXruns * 2,
    );
  }
}
