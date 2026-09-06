/**
 * audioMONASTRY · AI Orchestrator – Gemeinsame Typen
 * ===================================================
 * Zentrale Typen für Job-System, Session-Lifecycle, Model Registry/Manager,
 * MCP-Runtime, Cost-Tracking und Provider-Routing.
 */

/** AI-Task-Klassen (Provider-Routing). */
export type AiTask =
  | 'llm'
  | 'tts'
  | 'sing'
  | 'song'
  | 'stem.separate'
  | 'audio.classify'
  | 'audio.transcribe'
  | 'audio.embed'
  | 'audio.analyze'
  | 'audio.generate'
  | 'multimodal'
  | 'nlu';

/** Provider-IDs des Orchestrators. */
export type AiProviderId = 'hf-standard-endpoint' | 'hf-endpoint' | 'hf-serverless' | 'replicate' | 'local' | 'deterministic' | 'cerebras';

/** Modell-Ladeklassen (Multi-Model Loading). */
export type ModelLoadClass = 'CORE' | 'FREQUENT' | 'ON_DEMAND' | 'RARE';

/** Job-Status. */
export type JobStatus =
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMEOUT';

/** Session-Zustände (Lifecycle). */
export type SessionState =
  | 'CREATED'
  | 'STARTING'
  | 'WAKING_GPU'
  | 'LOADING_MODELS'
  | 'READY'
  | 'ACTIVE'
  | 'IDLE'
  | 'SHUTTING_DOWN'
  | 'CLOSED'
  | 'ERROR';

/** MCP-Permissions (Stufe 1..4). */
export type McpPermission = 'READ' | 'WRITE' | 'EXECUTION' | 'DESTRUCTIVE';

export const MCP_PERMISSION_LEVEL: Record<McpPermission, number> = {
  READ: 1,
  WRITE: 2,
  EXECUTION: 3,
  DESTRUCTIVE: 4,
};

/** ModelDefinition (Spiegel von model_manifest.json – Revision-Pinning). */
export interface ModelDefinition {
  id: string;
  repository: string;
  /** Fester Commit/Tag – niemals `latest` in Production. */
  revision: string;
  task: AiTask;
  framework: string;
  estimatedVRAM: number;
  estimatedRAM: number;
  loadPriority: number;
  preload: boolean;
  loadClass: ModelLoadClass;
  quantization: string;
  dependencies: string[];
  inputFormats: string[];
  outputFormats: string[];
  maxDuration: number;
  concurrency: number;
  timeout: number;
  license: string;
}

/** Ein AI-Job. */
export interface AiJob {
  jobId: string;
  sessionId: string;
  userId: string;
  task: AiTask;
  model: string;
  provider: AiProviderId;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: string | null;
  dedupeKey: string | null;
  result?: unknown;
}

/** Eine AI-Session. */
export interface AiSession {
  sessionId: string;
  state: SessionState;
  createdAt: number;
  lastActivity: number;
  activeJobs: number;
  loadedModels: string[];
  endpointState: 'inactive' | 'waking' | 'ready' | 'error';
}

/** Provider-Interface: austauschbare AI-Provider. */
export interface IAiProvider {
  readonly id: AiProviderId;
  /** Ist der Provider aktuell verfügbar (Keys/Endpoint konfiguriert)? */
  readonly available: boolean;
  /** Kann dieser Provider den Task mit dem Modell ausführen? */
  canRun(task: AiTask, model?: string): boolean;
  /** Schätzung der Kosten (USD) für einen Task. */
  estimateCostUsd(task: AiTask, model?: string): number;
  /** Führt den Task aus. Wirft AiProviderError bei Provider-Fehlern. */
  run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Normalisierter Provider-Fehler. */
export class AiProviderError extends Error {
  constructor(
    public readonly provider: AiProviderId,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
