/**
 * audioMONASTRY · Pod-Warteschlange mit Priorität (FLEET-P1-009)
 * ==============================================================
 * RP4 voice trägt TTS (live), SFX und LEGO (acestep-v15-xl-base). Der Pod
 * arbeitet seine Jobs der Reihe nach ab (`AI_POD_JOB_WORKERS`, Default 1). Damit
 * eine Sprachausgabe nicht hinter einem minutenlangen LEGO-Lauf wartet
 * (Live-Mandat, AGENTS.md 1.3), entscheidet der Server, WAS er dem Pod schickt:
 *
 *   Priorität  tts (0) > sfx (1) > sonstige (2) > lego/extract/complete (3)
 *   Slots      `AI_POD_QUEUE_SLOTS_<POD>`; Default voice = 1 (wie die Pod-
 *              Worker), alle anderen Pods unbegrenzt (keine Warteschlange,
 *              keine zusätzliche Latenz).
 *   Vorrang    Kommt TTS, während alle Slots belegt sind und einer davon ein
 *              LEGO-Job ist, wird dieser LEGO-Job unterbrochen: Abbruch mit
 *              klarer Wiederholungsmeldung (`PREEMPTED_BY_TTS`, retryable), nie
 *              stilles Verwerfen. Gebucht wird ein unterbrochener Job nicht.
 *
 * Grenze (ehrlich): Der Abbruch wirkt auf der Server-Seite sofort (Slot frei,
 * Polling beendet). Auf dem Pod selbst läuft ein bereits gestarteter
 * GPU-Schritt weiter, bis der Pod einen Abbruch-Endpunkt hat; der Provider
 * schickt dafür best effort `POST /cancel/{id}` (RunPod-Serverless kennt den
 * Pfad, der Pod-Server noch nicht → Folgearbeit FLEET-P1-009, Python).
 *
 * Kein Audio-Pfad: alles hier sind serverseitige GPU-Aufträge.
 */
import { envNumber } from '../../../config/aiInfrastructure';
import { aiLogger } from './aiLogger';
import { isLegoJob, POD_ROLE_IDS, type PodRoleId } from './podRouting';
import { AiProviderError, type AiProviderId, type AiTask } from './types';

export type PodJobClass = 'tts' | 'sfx' | 'default' | 'lego';

export const POD_JOB_PRIORITY: Readonly<Record<PodJobClass, number>> = {
  tts: 0,
  sfx: 1,
  default: 2,
  lego: 3,
};

/** Fehlercode eines zugunsten von TTS unterbrochenen LEGO-Jobs. */
export const PREEMPTED_CODE = 'PREEMPTED_BY_TTS';

export const PREEMPTED_MESSAGE =
  'LEGO-Auftrag zugunsten einer Sprachausgabe (TTS) unterbrochen. Es wurde nichts gespeichert und nichts berechnet – bitte erneut starten.';

/** Abbruchgrund, an dem der Provider eine Unterbrechung erkennt. */
export class PodPreemption extends Error {
  readonly code = PREEMPTED_CODE;
  constructor(readonly pod: PodRoleId, readonly byLabel: string) {
    super(PREEMPTED_MESSAGE);
    this.name = 'PodPreemption';
  }
}

export function isPreemptionError(error: unknown): boolean {
  return (error instanceof AiProviderError && error.code === PREEMPTED_CODE) || error instanceof PodPreemption;
}

/** Klasse eines Jobs für die Warteschlange. */
export function classifyPodJob(task: AiTask, model?: string, input?: unknown): PodJobClass {
  if (task === 'tts') return 'tts';
  if (task === 'audio.generate') return 'sfx';
  if (isLegoJob(task, model, input)) return 'lego';
  return 'default';
}

/** Slots je Pod: voice 1 (Pod arbeitet seriell), sonst unbegrenzt. */
export function podQueueSlots(pod: PodRoleId): number {
  const fallback = pod === 'voice' ? 1 : Number.POSITIVE_INFINITY;
  const raw = envNumber(`AI_POD_QUEUE_SLOTS_${pod.toUpperCase()}`, fallback);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
}

interface Waiting {
  seq: number;
  cls: PodJobClass;
  label: string;
  start: () => void;
  reject: (error: unknown) => void;
}

interface Running {
  seq: number;
  cls: PodJobClass;
  label: string;
  controller: AbortController;
  preempted: PodPreemption | null;
  /** Lehnt den Aufrufer sofort ab (Unterbrechung wartet nicht auf das Aufräumen). */
  fail: (error: unknown) => void;
  providerId: AiProviderId;
}

export interface PodQueueSnapshot {
  pod: PodRoleId;
  slots: number | 'unbegrenzt';
  running: Array<{ cls: PodJobClass; label: string }>;
  waiting: Array<{ cls: PodJobClass; label: string }>;
  preemptions: number;
}

export class PodJobQueue {
  private seq = 0;
  private readonly waiting: Waiting[] = [];
  private readonly running = new Set<Running>();
  private preemptions = 0;

  constructor(readonly pod: PodRoleId, private readonly slotsFn: () => number = () => podQueueSlots(pod)) {}

  get slots(): number {
    return this.slotsFn();
  }

  /**
   * Führt `fn` aus, sobald ein Slot frei ist (höhere Priorität zuerst, sonst
   * FIFO). `fn` bekommt ein Signal, das bei Abbruch des Aufrufers ODER bei einer
   * Unterbrechung zugunsten von TTS feuert.
   */
  run<T>(
    cls: PodJobClass,
    label: string,
    fn: (signal: AbortSignal) => Promise<T>,
    outer?: AbortSignal,
    providerId: AiProviderId = 'runpod',
  ): Promise<T> {
    if (outer?.aborted) return Promise.reject(new AiProviderError(providerId, 'CANCELLED', 'request cancelled', false));
    const seq = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const entry: Waiting = {
        seq,
        cls,
        label,
        reject,
        start: () => {
          const controller = new AbortController();
          const job: Running = { seq, cls, label, controller, preempted: null, fail: reject, providerId };
          this.running.add(job);
          const onOuterAbort = () => controller.abort(outer?.reason);
          outer?.addEventListener('abort', onOuterAbort, { once: true });
          fn(controller.signal).then(
            (value) => {
              if (job.preempted) reject(this.preemptionError(providerId));
              else resolve(value);
            },
            (error: unknown) => {
              reject(job.preempted ? this.preemptionError(providerId) : error);
            },
          ).finally(() => {
            outer?.removeEventListener('abort', onOuterAbort);
            this.running.delete(job);
            // Ein beendeter Auftrag zaehlt als Aktivitaet: sonst laeuft das
            // Leerlauf-Fenster ab dem Auftrags-START, und ein langer Lauf (LEGO,
            // Stems, Song) wuerde den Pod direkt nach dem Ergebnis stoppen - der
            // Folgeauftrag zahlt dann den Kaltstart. Registriert von podStartTriggers.
            finishedHook?.(this.pod);
            this.pump();
          });
        },
      };
      if (outer) {
        outer.addEventListener('abort', () => {
          const idx = this.waiting.indexOf(entry);
          if (idx >= 0) {
            this.waiting.splice(idx, 1);
            reject(new AiProviderError(providerId, 'CANCELLED', 'request cancelled', false));
          }
        }, { once: true });
      }
      this.waiting.push(entry);
      this.waiting.sort((a, b) => POD_JOB_PRIORITY[a.cls] - POD_JOB_PRIORITY[b.cls] || a.seq - b.seq);
      if (cls === 'tts') this.preemptForTts(label);
      this.pump();
    });
  }

  private preemptionError(providerId: AiProviderId): AiProviderError {
    return new AiProviderError(providerId, PREEMPTED_CODE, PREEMPTED_MESSAGE, true);
  }

  /** TTS wartet und alle Slots sind belegt → jüngsten laufenden LEGO-Job unterbrechen. */
  private preemptForTts(byLabel: string): void {
    if (this.running.size < this.slots) return;
    const lego = [...this.running].filter((r) => r.cls === 'lego' && !r.preempted).sort((a, b) => b.seq - a.seq)[0];
    if (!lego) return;
    lego.preempted = new PodPreemption(this.pod, byLabel);
    this.preemptions += 1;
    aiLogger.warn('pod queue: lego preempted by tts', { pod: this.pod, lego: lego.label, by: byLabel, code: PREEMPTED_CODE });
    lego.controller.abort(lego.preempted);
    lego.fail(this.preemptionError(lego.providerId));
    // Der Slot gilt sofort als frei: TTS muss nicht auf das Aufräumen warten.
    this.running.delete(lego);
  }

  private pump(): void {
    while (this.waiting.length > 0 && this.running.size < this.slots) {
      const next = this.waiting.shift()!;
      next.start();
    }
  }

  /** Anzahl laufender Auftraege - O(1), fuer podBusy ohne Arrays zu bauen. */
  runningCount(): number {
    return this.running.size;
  }

  /** Anzahl wartender Auftraege - O(1). */
  waitingCount(): number {
    return this.waiting.length;
  }

  snapshot(): PodQueueSnapshot {
    const slots = this.slots;
    return {
      pod: this.pod,
      slots: Number.isFinite(slots) ? slots : 'unbegrenzt',
      running: [...this.running].map((r) => ({ cls: r.cls, label: r.label })),
      waiting: this.waiting.map((w) => ({ cls: w.cls, label: w.label })),
      preemptions: this.preemptions,
    };
  }
}

let queues = new Map<PodRoleId, PodJobQueue>();

/**
 * Wird nach jedem beendeten Auftrag gerufen (mit der Pod-Rolle). `podStartTriggers`
 * registriert hier `markPodActivity`, damit das Leerlauf-Fenster ab dem Auftrags-ENDE
 * laeuft. Bewusst als Hook statt als Import: die Warteschlange soll den Flotten-Zustand
 * nicht kennen (und kein Import-Zyklus entstehen).
 */
let finishedHook: ((pod: PodRoleId) => void) | null = null;

export function setJobFinishedHook(fn: ((pod: PodRoleId) => void) | null): void {
  finishedHook = fn;
}

/** Eine Warteschlange je Pod (geteilt von allen Providern, die diesen Pod ansprechen). */
export function podQueue(pod: PodRoleId): PodJobQueue {
  let queue = queues.get(pod);
  if (!queue) {
    queue = new PodJobQueue(pod);
    queues.set(pod, queue);
  }
  return queue;
}

export function podQueueStatus(): PodQueueSnapshot[] {
  return POD_ROLE_IDS.map((pod) => podQueue(pod).snapshot());
}

/** Nur für Tests. */
export function __resetPodQueues(): void {
  queues = new Map();
}
