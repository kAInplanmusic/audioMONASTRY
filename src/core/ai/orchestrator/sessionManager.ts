/**
 * audioMONASTRY · AI Orchestrator – Session Lifecycle
 * ====================================================
 * Zustandsmaschine: CREATED → STARTING → WAKING_GPU → LOADING_MODELS → READY
 * → ACTIVE ⇄ IDLE → SHUTTING_DOWN → CLOSED (bzw. ERROR).
 *
 * Heartbeat-Regel: Nur echte AI-Requests verlängern die Session (nicht jede
 * UI-Aktion). Bei Idle-Timeout wird Scale-to-Zero angefordert.
 */
import { aiLogger } from './aiLogger';
import type { AiSession, SessionState } from './types';

const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  CREATED: ['STARTING', 'CLOSED', 'ERROR'],
  STARTING: ['WAKING_GPU', 'ERROR'],
  WAKING_GPU: ['LOADING_MODELS', 'ERROR'],
  LOADING_MODELS: ['READY', 'ERROR'],
  READY: ['ACTIVE', 'IDLE', 'SHUTTING_DOWN', 'ERROR'],
  ACTIVE: ['IDLE', 'READY', 'SHUTTING_DOWN', 'ERROR'],
  IDLE: ['ACTIVE', 'SHUTTING_DOWN', 'CLOSED', 'ERROR'],
  SHUTTING_DOWN: ['CLOSED', 'ERROR'],
  CLOSED: [],
  ERROR: ['CLOSED'],
};

export interface SessionManagerOptions {
  idleTimeoutMs?: number;
  onScaleToZero?: (session: AiSession) => Promise<void>;
}

export class SessionManager {
  private session: AiSession;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(sessionId = `ai-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, private options: SessionManagerOptions = {}) {
    this.session = {
      sessionId,
      state: 'CREATED',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      activeJobs: 0,
      loadedModels: [],
      endpointState: 'inactive',
    };
    this.idleTimeoutMs = options.idleTimeoutMs ?? Number(process.env.AI_SESSION_IDLE_TIMEOUT ?? 20 * 60 * 1000);
  }

  private idleTimeoutMs: number;

  get(): AiSession {
    return { ...this.session };
  }

  getState(): SessionState {
    return this.session.state;
  }

  transition(next: SessionState): void {
    const current = this.session.state;
    if (!VALID_TRANSITIONS[current].includes(next)) {
      aiLogger.warn('invalid session transition ignored', { sessionId: this.session.sessionId, from: current, to: next });
      return;
    }
    this.session.state = next;
    aiLogger.info('session transition', { sessionId: this.session.sessionId, from: current, to: next });
    if (next === 'ACTIVE') this.resetIdleTimer();
    if (next === 'SHUTTING_DOWN' || next === 'CLOSED' || next === 'ERROR') this.clearIdleTimer();
  }

  /** Nur echte AI-Aktivität verlängert die Session. */
  heartbeat(): void {
    this.session.lastActivity = Date.now();
    if (this.session.state === 'IDLE') this.transition('ACTIVE');
    if (this.session.state === 'ACTIVE') this.resetIdleTimer();
  }

  jobStarted(modelId?: string): void {
    this.session.activeJobs += 1;
    this.heartbeat();
    if (modelId && !this.session.loadedModels.includes(modelId)) {
      this.session.loadedModels.push(modelId);
    }
  }

  jobFinished(modelId?: string): void {
    this.session.activeJobs = Math.max(0, this.session.activeJobs - 1);
    if (this.session.activeJobs === 0 && this.session.state === 'ACTIVE') {
      this.transition('IDLE');
    }
  }

  setEndpointState(state: AiSession['endpointState']): void {
    this.session.endpointState = state;
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      aiLogger.info('session idle timeout', { sessionId: this.session.sessionId });
      this.transition('IDLE');
      void this.requestScaleToZero();
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Kontrolliertes Herunterfahren: Jobs stoppen, Session schließen, Scale-to-Zero anfordern. */
  async shutdown(): Promise<void> {
    this.transition('SHUTTING_DOWN');
    await this.requestScaleToZero();
    this.session.activeJobs = 0;
    this.transition('CLOSED');
    aiLogger.info('session closed', { sessionId: this.session.sessionId });
  }

  private async requestScaleToZero(): Promise<void> {
    try {
      if (this.options.onScaleToZero) await this.options.onScaleToZero(this.get());
      else aiLogger.info('scale-to-zero requested (no handler)', { sessionId: this.session.sessionId });
    } catch (error) {
      aiLogger.error('scale-to-zero request failed', { sessionId: this.session.sessionId, error: (error as Error).message });
    }
  }
}
