/**
 * audioMONASTRY · Wiederaufnehmbare Agent-Laeufe (AI-P1-006)
 * =====================================================================
 * `MoaAgent.run()` fuehrt den Loop planen -> ausfuehren -> pruefen aus, kennt aber
 * keinen Zustand ausserhalb des Aufrufs. Fuer "Abbruch und spaeter weitermachen"
 * braucht es einen Ort, an dem der Lauf liegt:
 *
 *   - `AgentRunStore` schreibt jeden Lauf als JSON auf Platte. Damit ueberlebt
 *     die Wiederaufnahme auch einen Neustart/Deploy - im Speicher waere sie nur
 *     solange wahr, wie der Prozess lebt.
 *   - `ResumableAgentRunner` haelt den Lauf zwischen den Schritten fest
 *     (`onStep` von `MoaAgent`), kann ihn abbrechen (kooperativ ueber
 *     `AbortSignal`) und mit `agent.runPlan(..., { startIndex, priorResults })`
 *     genau bei den offenen Schritten weitermachen.
 *
 * Bewusste Entscheidung: Beim Wiederaufnehmen wird der ORIGINALPLAN benutzt, nicht
 * neu geplant. Ein neuer Plan koennte andere Schritte in anderer Reihenfolge
 * enthalten - dann wuerde "Schritt 3" ploetzlich etwas anderes bedeuten. So bleiben
 * bereits erledigte Schritte gueltig und es entstehen keine zusaetzlichen
 * Planungskosten.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MoaAgent, MoaPlan, MoaRunCost, MoaRunOptions, MoaStepResult } from './MoaAgent';

export type AgentRunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface AgentRunRecord {
  runId: string;
  task: string;
  userId: string;
  context?: string;
  status: AgentRunStatus;
  plan?: MoaPlan;
  /** Ergebnisse der ausgefuehrten Schritte (in Reihenfolge). */
  steps: MoaStepResult[];
  /** Wie viele Schritte des Plans ausgefuehrt sind (= steps.length). */
  executedCount: number;
  corrections: number;
  /** Korrekturrunden-Obergrenze des Aufrufers (fuer fortgesetzte Laeufe). */
  maxCorrections: number;
  /**
   * Schreibfreigabe des Aufrufers. `false` (Default) heisst: Schreib-Schritte
   * werden vom WRITE-Gate abgelehnt und als Fehler protokolliert - wer den Lauf
   * startet, muss Schreibzugriffe ausdruecklich mitgeben.
   */
  allowWrite: boolean;
  cost: MoaRunCost;
  succeeded: boolean;
  error?: string;
  createdAt: number;
  updatedAt: number;
  cancelRequested: boolean;
}

export const emptyRunCost = (): MoaRunCost => ({ totalUsd: 0, planningUsd: 0, correctionsUsd: 0, estimated: true });

export function agentRunSummary(record: AgentRunRecord): {
  runId: string;
  task: string;
  status: AgentRunStatus;
  phase: string;
  steps: Array<{ index: number; pluginId: string; command: string; handled: boolean; error?: string }>;
  executedCount: number;
  corrections: number;
  cost: MoaRunCost;
  succeeded: boolean;
  /** Abbruch angefordert (der laufende Schritt darf noch zu Ende laufen). */
  cancelRequested: boolean;
  error?: string;
  updatedAt: number;
} {
  return {
    runId: record.runId,
    task: record.task,
    status: record.status,
    // Anzeige-Phase: der Lauf selbst kennt keine Phasen, sie ergeben sich aus dem
    // Zustand - damit die Oberflaeche "planen/ausfuehren/pruefen" zeigen kann.
    phase: record.status === 'running'
      ? (record.plan ? 'execute' : 'plan')
      : record.status === 'done' ? 'verify' : record.status,
    steps: record.steps.map((result, index) => ({
      index,
      pluginId: result.pluginId || result.step.pluginId,
      command: result.step.command,
      handled: result.handled,
      error: result.error,
    })),
    executedCount: record.executedCount,
    corrections: record.corrections,
    cost: record.cost,
    succeeded: record.succeeded,
    cancelRequested: record.cancelRequested,
    error: record.error,
    updatedAt: record.updatedAt,
  };
}

export class AgentRunStore {
  /**
   * Zaehler fuer eindeutige Namen der temporaeren Schreibdateien (QUAL-P2-008).
   * Bewusst OHNE `process.pid`: diese Datei kann ueber einen Client-Import ins
   * Browser-Bundle geraten, wo es `process` nicht gibt - dafuer gibt es
   * `tests/browserSafeModules.test.ts`. Ein Zaehler plus Zufall reicht, weil die
   * Eindeutigkeit nur innerhalb dieses Verzeichnisses noetig ist.
   */
  private tempZaehler = 0;

  constructor(private readonly dir: string = agentRunDir()) {}

  private file(runId: string): string {
    return path.join(this.dir, `${runId.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
  }

  async save(record: AgentRunRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // ATOMAR SCHREIBEN (QUAL-P2-008, 2026-09-23).
    //
    // Vorher: `writeFile(ziel, json)` - das ist truncate + write, also ein
    // Zeitfenster, in dem die Datei LEER oder HALB geschrieben auf der Platte
    // liegt. `execute()` speichert bei JEDEM Schritt (`onStep` -> `save`), und
    // gleichzeitig kann ein zweiter Aufruf `load()` lesen (Abbruch, Statusabfrage).
    // Ein solcher Leser bekam dann einen Parse-Fehler, und weil `load()` jeden
    // Fehler als "nicht gefunden" meldete, hiess das fuer den Aufrufer
    // "unbekannter Lauf" - fuer einen Lauf, den es gab.
    //
    // Gemessen mit scripts/agentrun-race-repro.ts: von 740 Lesevorgaengen
    // waehrend laufender Speicherungen lieferten 399 (53,9 %) faelschlich null.
    // Das war kein Testproblem: GET /api/ai/agent/runs/:runId konnte 404 fuer
    // einen existierenden Lauf liefern, und der Abbruch konnte fehlschlagen.
    //
    // Jetzt: erst in eine temporaere Datei schreiben, dann umbenennen. `rename`
    // ist auf POSIX atomar - ein Leser sieht entweder die alte oder die neue
    // VOLLSTAENDIGE Datei, nie etwas dazwischen. Der temporaere Name endet auf
    // `.tmp` und wird von `list()` (filtert auf `.json`) nicht erfasst.
    const ziel = this.file(record.runId);
    const temp = `${ziel}.${(this.tempZaehler += 1)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(record), 'utf8');
      await rename(temp, ziel);
    } catch (error) {
      // Keine halbe Datei liegen lassen.
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async load(runId: string): Promise<AgentRunRecord | null> {
    // "Fehlt" und "nicht lesbar" sind NICHT dasselbe (QUAL-P2-008). Vorher
    // lieferte beides `null`, und ein voruebergehender Lesefehler wurde damit
    // stillschweigend zu "unbekannter Lauf". Seit dem atomaren Schreiben kann
    // dieser Fall nicht mehr durch eine laufende Speicherung entstehen; fuer
    // Dateien, die eine aeltere Fassung beschaedigt hinterlassen hat, wird kurz
    // erneut versucht, statt sofort aufzugeben.
    for (let versuch = 0; versuch < 3; versuch += 1) {
      try {
        return JSON.parse(await readFile(this.file(runId), 'utf8')) as AgentRunRecord;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null; // wirklich nicht da
        if (versuch === 2) return null; // bleibt unlesbar: Vertrag unveraendert (null)
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    return null;
  }

  async list(): Promise<AgentRunRecord[]> {
    try {
      const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json'));
      const out: AgentRunRecord[] = [];
      for (const file of files) {
        try {
          out.push(JSON.parse(await readFile(path.join(this.dir, file), 'utf8')) as AgentRunRecord);
        } catch { /* kaputte Datei ignorieren */ }
      }
      return out.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  async remove(runId: string): Promise<void> {
    await rm(this.file(runId), { force: true });
  }
}

export function agentRunDir(): string {
  // Kein ungeschuetzter `process`-Zugriff: diese Datei liegt unter src/ und kann
  // ueber einen Client-Import ins Browser-Bundle geraten, wo es `process` nicht
  // gibt (siehe tests/browserSafeModules.test.ts).
  let configured = '';
  try {
    if (typeof process !== 'undefined' && process?.env) configured = process.env.AI_AGENT_RUN_DIR ?? '';
  } catch { /* Browser: kein Prozess-Env */ }
  return configured.trim() || path.join(tmpdir(), 'audiomonastry-agent-runs');
}

/** `MoaAgent`-Teilmenge, die der Runner braucht (fuer Tests injizierbar). */
export interface ResumableAgent {
  run: MoaAgent['run'];
  runPlan: MoaAgent['runPlan'];
}

export interface ResumableRunnerDeps {
  agent: ResumableAgent;
  store?: AgentRunStore;
  now?: () => number;
  newId?: () => string;
  confirmWrite?: MoaRunOptions['confirmWrite'];
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export class ResumableAgentRunner {
  private readonly store: AgentRunStore;
  /**
   * Laufende Laeufe: runId -> AbortController + Abschluss-Zusage. `cancel()` bricht
   * ab und WARTET auf das Ende, damit es den wirklich abgebrochenen Zustand
   * zurueckgeben kann (sonst saehe der Aufrufer noch 'running' und wuesste nicht,
   * ob der Stopp angekommen ist).
   */
  private readonly inflight = new Map<string, { controller: AbortController; finished: Promise<void> }>();

  constructor(private readonly deps: ResumableRunnerDeps) {
    this.store = deps.store ?? new AgentRunStore();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async get(runId: string): Promise<AgentRunRecord | null> {
    return this.store.load(runId);
  }

  async list(): Promise<AgentRunRecord[]> {
    return this.store.list();
  }

  /**
   * Lauf ANLEGEN und sofort zurueckgeben - der Loop laeuft im Hintergrund weiter.
   *
   * Das ist der Weg fuer die HTTP-Route: wuerde sie den ganzen Lauf abwarten,
   * koennte der Client gar nicht abbrechen (die Antwort kaeme erst, wenn alles
   * gelaufen ist) und ein LLM-Lauf wuerde Minuten im Request haengen. Der
   * Endzustand wird ueber `get()` abgefragt.
   */
  async begin(input: {
    task: string;
    userId: string;
    context?: string;
    maxCorrections?: number;
    runId?: string;
    allowWrite?: boolean;
  }): Promise<AgentRunRecord> {
    const record = await this.createRecord(input);
    void this.execute(record, { plan: null }).catch((error: unknown) => {
      this.deps.log?.('[agent] Hintergrund-Lauf fehlgeschlagen', { runId: record.runId, error: (error as Error).message });
    });
    return record;
  }

  /** Anlegen + vollstaendig abwarten (Tests/CLI). */
  async start(input: {
    task: string;
    userId: string;
    context?: string;
    maxCorrections?: number;
    runId?: string;
    allowWrite?: boolean;
  }): Promise<AgentRunRecord> {
    const record = await this.createRecord(input);
    return this.execute(record, { plan: null });
  }

  private async createRecord(input: {
    task: string;
    userId: string;
    context?: string;
    maxCorrections?: number;
    runId?: string;
    allowWrite?: boolean;
  }): Promise<AgentRunRecord> {
    const now = this.now();
    const record: AgentRunRecord = {
      runId: input.runId ?? this.deps.newId?.() ?? `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      task: input.task,
      userId: input.userId,
      context: input.context,
      status: 'running',
      steps: [],
      executedCount: 0,
      corrections: 0,
      maxCorrections: Math.max(0, input.maxCorrections ?? 1),
      allowWrite: input.allowWrite === true,
      cost: emptyRunCost(),
      succeeded: false,
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
    };
    await this.store.save(record);
    return record;
  }

  /** Fortsetzen im Hintergrund (Route): gibt den Zustand sofort zurueck. */
  async beginResume(runId: string): Promise<AgentRunRecord> {
    const prepared = await this.prepareResume(runId);
    void this.execute(prepared, { plan: prepared.plan ?? null }).catch((error: unknown) => {
      this.deps.log?.('[agent] Hintergrund-Fortsetzung fehlgeschlagen', { runId, error: (error as Error).message });
    });
    return prepared;
  }

  /**
   * Abgebrochenen Lauf fortsetzen: der Originalplan bleibt, ausgefuehrt werden nur
   * die offenen Schritte.
   */
  async resume(runId: string): Promise<AgentRunRecord> {
    const prepared = await this.prepareResume(runId);
    return this.execute(prepared, { plan: prepared.plan ?? null });
  }

  private async prepareResume(runId: string): Promise<AgentRunRecord> {
    const record = await this.store.load(runId);
    if (!record) throw new Error(`unbekannter Lauf: ${runId}`);
    if (record.status !== 'cancelled' && record.status !== 'failed') {
      throw new Error(`Lauf ${runId} ist ${record.status} und kann nicht fortgesetzt werden`);
    }
    // Wurde der Lauf WAEHREND DER PLANUNG abgebrochen, gibt es noch keinen Plan.
    // Fortsetzen heisst dann: von vorn planen - es ist ja nichts ausgefuehrt worden
    // (statt den Lauf faelschlich als "nicht fortsetzbar" abzutun).
    if (record.plan && record.executedCount >= record.plan.steps.length) {
      throw new Error(`Lauf ${runId} ist vollstaendig ausgefuehrt`);
    }
    const resumed: AgentRunRecord = {
      ...record,
      status: 'running',
      cancelRequested: false,
      error: undefined,
      updatedAt: this.now(),
    };
    await this.store.save(resumed);
    return resumed;
  }

  /** Kooperativer Abbruch: laufender Lauf wird abgebrochen, sonst nur markiert. */
  async cancel(runId: string): Promise<AgentRunRecord> {
    const record = await this.store.load(runId);
    if (!record) throw new Error(`unbekannter Lauf: ${runId}`);
    const running = this.inflight.get(runId);
    const updated: AgentRunRecord = {
      ...record,
      cancelRequested: true,
      status: running ? record.status : 'cancelled',
      updatedAt: this.now(),
    };
    await this.store.save(updated);
    if (!running) return updated;
    running.controller.abort();
    await running.finished;
    return (await this.store.load(runId)) ?? updated;
  }

  private async execute(
    record: AgentRunRecord,
    options: { plan: MoaPlan | null },
  ): Promise<AgentRunRecord> {
    const controller = new AbortController();
    let releaseFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => { releaseFinished = resolve; });
    this.inflight.set(record.runId, { controller, finished });
    let current = record;
    try {
      const onStep: MoaRunOptions['onStep'] = async ({ result }) => {
        current = {
          ...current,
          steps: [...current.steps, result],
          executedCount: current.steps.length + 1,
          updatedAt: this.now(),
        };
        await this.store.save(current);
      };
      const runOptions: MoaRunOptions = {
        userId: record.userId,
        context: record.context,
        maxCorrections: record.maxCorrections,
        // Schreib-Schritte nur mit ausdruecklicher Freigabe des Aufrufers.
        confirmWrite: record.allowWrite ? () => true : this.deps.confirmWrite,
        signal: controller.signal,
        onStep,
        startIndex: options.plan ? record.executedCount : 0,
        priorResults: options.plan ? record.steps : undefined,
      } as MoaRunOptions;

      const result = options.plan
        ? await this.deps.agent.runPlan(options.plan, runOptions, record.userId, { ...record.cost })
        : await this.deps.agent.run(record.task, runOptions);

      current = {
        ...current,
        plan: current.plan ?? result.plan,
        steps: result.steps,
        executedCount: result.steps.length,
        corrections: current.corrections + result.corrections,
        cost: result.cost,
        succeeded: result.succeeded,
        status: result.cancelled || current.cancelRequested ? 'cancelled' : (result.succeeded ? 'done' : 'failed'),
        updatedAt: this.now(),
      };
      await this.store.save(current);
      return current;
    } catch (error) {
      const failed: AgentRunRecord = {
        ...current,
        status: 'failed',
        error: (error as Error).message,
        updatedAt: this.now(),
      };
      this.deps.log?.('[agent] Lauf abgebrochen mit Fehler', { runId: record.runId, error: failed.error });
      await this.store.save(failed);
      return failed;
    } finally {
      this.inflight.delete(record.runId);
      releaseFinished();
    }
  }
}
