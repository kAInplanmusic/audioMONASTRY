/**
 * audioMONASTRY · AI Orchestrator – Strukturiertes Logging
 * ========================================================
 * JSON-Logs mit Pflichtfeldern: timestamp, level, service, sessionId, jobId,
 * model, provider, duration, error. Redactiert Secrets/Keys/Tokens.
 */
import type { AiProviderId, AiTask } from './types';

export type AiLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface AiLogRecord {
  ts: string;
  level: AiLogLevel;
  service: string;
  msg: string;
  sessionId?: string;
  jobId?: string;
  task?: AiTask;
  model?: string;
  provider?: AiProviderId;
  durationMs?: number;
  error?: string;
  [key: string]: unknown;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(sk-[A-Za-z0-9_-]{6,})/g, '[REDACTED_KEY]'],
  [/(hf_[A-Za-z0-9]{6,})/g, '[REDACTED_KEY]'],
  [/(r8_[A-Za-z0-9]{6,})/g, '[REDACTED_KEY]'],
  [/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1[REDACTED]'],
  [/(token[=:"]?\s*)[A-Za-z0-9._-]{8,}/gi, '$1[REDACTED]'],
];

/** Entfernt Secrets aus beliebigen Strings/Objekten. */
export function redactSecrets(input: unknown): unknown {
  if (typeof input === 'string') {
    let out = input;
    for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }
  if (Array.isArray(input)) return input.map(redactSecrets);
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = redactSecrets(value);
    }
    return out;
  }
  return input;
}

export class AiLogger {
  constructor(private service = 'ai-orchestrator') {}

  log(level: AiLogLevel, msg: string, fields: Omit<AiLogRecord, 'ts' | 'level' | 'service' | 'msg'> = {}): void {
    const record: AiLogRecord = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      msg,
      ...fields,
    };
    const line = JSON.stringify(redactSecrets(record));
    if (level === 'ERROR' || level === 'FATAL') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
  }

  debug(msg: string, fields?: Omit<AiLogRecord, 'ts' | 'level' | 'service' | 'msg'>): void {
    if ((process.env.AI_LOG_LEVEL ?? 'INFO').toUpperCase() === 'DEBUG') this.log('DEBUG', msg, fields);
  }

  info(msg: string, fields?: Omit<AiLogRecord, 'ts' | 'level' | 'service' | 'msg'>): void {
    this.log('INFO', msg, fields);
  }

  warn(msg: string, fields?: Omit<AiLogRecord, 'ts' | 'level' | 'service' | 'msg'>): void {
    this.log('WARN', msg, fields);
  }

  error(msg: string, fields?: Omit<AiLogRecord, 'ts' | 'level' | 'service' | 'msg'>): void {
    this.log('ERROR', msg, fields);
  }

  fatal(msg: string, fields?: Omit<AiLogRecord, 'ts' | 'level' | 'service' | 'msg'>): void {
    this.log('FATAL', msg, fields);
  }
}

export const aiLogger = new AiLogger();
