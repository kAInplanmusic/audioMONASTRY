/**
 * audioMONASTRY · Anbindung des vis-Agenten an die beiden Modelle der App
 * =======================================================================
 * Dünne Hülle ohne eigene Logik: `small` ruft das kleine Modell über den Pod-Aufruf
 * `gui.execute` im Format `vis_director` (qwen3-4b auf audio-brain), `large` nutzt den
 * allgemeinen Router (Brain, qwen38-27b-fp8). Beides kommt als Funktion herein, damit
 * der Agent ohne Netzwerk testbar bleibt; die Verdrahtung im Server reicht
 * `new VastProvider('brain').run` und `llmRouter.complete` hinein.
 */
import type { VisLlm, VisLlmRequest } from './visAgent';

export type PodRun = (task: string, model: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export type LlmComplete = (req: {
  prompt: string;
  complexity: 'simple' | 'moderate' | 'complex';
  maxTokens: number;
  timeoutMs: number;
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<{ text: string }>;

/** Text aus einer Worker-Antwort ({text} | {output:{text}} | String). */
export function workerText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    const output = record.output;
    if (output && typeof output === 'object' && typeof (output as Record<string, unknown>).text === 'string') {
      return (output as { text: string }).text;
    }
  }
  return '';
}

/** Zeitlimit mit echtem Abbruch des Aufrufs. */
async function withAbort<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function createVisLlm(deps: { runPod: PodRun; complete: LlmComplete; smallModel?: string }): VisLlm {
  const smallModel = deps.smallModel ?? 'qwen3-4b';
  return {
    small: (req: VisLlmRequest) =>
      withAbort(req.timeoutMs, async (signal) =>
        workerText(await deps.runPod('gui.execute', smallModel, {
          format: 'vis_director', instruction: req.prompt, maxTokens: req.maxTokens, jsonSchema: req.jsonSchema,
        }, signal))),
    large: (req: VisLlmRequest) =>
      withAbort(req.timeoutMs, async (signal) =>
        (await deps.complete({
          prompt: req.prompt, complexity: 'moderate', maxTokens: req.maxTokens, timeoutMs: req.timeoutMs, jsonSchema: req.jsonSchema, signal,
        })).text),
  };
}
