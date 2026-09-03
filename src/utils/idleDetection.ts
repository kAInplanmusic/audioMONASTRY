/**
 * audioMONASTRY · AM-E6-5: Audio-Idle-Detection (Energie-Optimierung)
 * =====================================================================
 * Kleiner, plattformfreier Idle-Detektor für den Audio-Pfad:
 *   * `activity()` meldet Nutzer-/Audio-Aktivität und setzt den Timer zurück.
 *   * Nach `timeoutMs` ohne Aktivität wird `onIdle` gefeuert (z. B. AudioContext
 *     suspendieren → CPU/Strom sparen).
 *   * Die nächste Aktivität feuert `onActive` (z. B. Context resume).
 *
 * Bewusst ohne Timer-/Plattform-APIs im Kern (setTimeout ist injizierbar
 * getestet); die AudioEngine verdrahtet suspend/resume ihres Kontextes.
 */
export interface AudioIdleDetectorOptions {
  timeoutMs?: number;
  onIdle?: () => void;
  onActive?: () => void;
}

export class AudioIdleDetector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idle = false;
  private readonly timeoutMs: number;
  private readonly onIdle: (() => void) | undefined;
  private readonly onActive: (() => void) | undefined;

  constructor(options: AudioIdleDetectorOptions = {}) {
    this.timeoutMs = Math.max(1000, options.timeoutMs ?? 5 * 60 * 1000);
    this.onIdle = options.onIdle;
    this.onActive = options.onActive;
  }

  /** Aktivität melden: Idle beenden + Timer neu starten. */
  activity(): void {
    if (this.idle) {
      this.idle = false;
      try { this.onActive?.(); } catch { /* Callback darf nicht werfen */ }
    }
    this.resetTimer();
  }

  /** Timer (neu) starten, ohne einen laufenden Idle-Zustand zu beenden. */
  arm(): void {
    this.resetTimer();
  }

  /** Sofort inaktiv schalten (z. B. alle Plugins OFF). */
  idleNow(): void {
    this.clearTimer();
    if (!this.idle) {
      this.idle = true;
      try { this.onIdle?.(); } catch { /* Callback darf nicht werfen */ }
    }
  }

  isIdle(): boolean {
    return this.idle;
  }

  dispose(): void {
    this.clearTimer();
    this.idle = false;
  }

  private resetTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.idle) {
        this.idle = true;
        try { this.onIdle?.(); } catch { /* Callback darf nicht werfen */ }
      }
    }, this.timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
