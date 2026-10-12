/**
 * audioMONASTRY · Client-LLM-Zugriff (Server-Proxy)
 * ==================================================
 * Im Browser laufen LLM-Calls über `POST /api/ai/complete` (Keys bleiben
 * serverseitig). In Node (Server/Tests) wird der LlmRouter direkt genutzt.
 *
 * RT-AUDIT-P1-015: Mit `stream: true` + `onToken` läuft der Aufruf über
 * `POST /api/ai/complete/stream` (Server-Sent Events). Jeder Token erreicht die
 * UI sofort; das Ergebnis ist dieselbe `LlmCompletion` wie beim Nicht-Stream-Weg.
 */
import { llmRouter, type LlmCompletion, type LlmRequest } from './LlmRouter';

/** Felder, die über das Netz gehen (keine Funktionen/Signale). */
function wireBody(req: LlmRequest): Record<string, unknown> {
  return {
    prompt: req.prompt,
    complexity: req.complexity,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    reasoningEffort: req.reasoningEffort,
  };
}

/** Ein SSE-Ereignis (`event:` + `data:`) aus dem Strom. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Zerlegt einen SSE-Puffer in vollständige Ereignisse (Trenner: Leerzeile).
 * Liefert den unvollständigen Rest zurück, damit er beim nächsten Chunk
 * weitergeführt wird. Rein funktional → ohne Netz testbar.
 */
export function splitSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/** Streaming-Aufruf im Browser über den Server-Proxy (SSE). */
export async function streamLlm(req: LlmRequest, onToken: (token: string) => void): Promise<LlmCompletion> {
  if (typeof window === 'undefined') return llmRouter.completeStream(req, onToken);
  const resp = await fetch('/api/ai/complete/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(wireBody(req)),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`AI-API HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = splitSseEvents(buffer);
    buffer = rest;
    for (const ev of events) {
      const payload = JSON.parse(ev.data) as Record<string, unknown>;
      if (ev.event === 'token') {
        const token = String(payload.token ?? '');
        text += token;
        onToken(token);
      } else if (ev.event === 'done') {
        return { ...(payload as unknown as LlmCompletion), text };
      } else if (ev.event === 'error') {
        throw new Error(String(payload.detail ?? payload.error ?? 'ai stream fehlgeschlagen'));
      }
    }
  }
  throw new Error('AI-Stream ohne Abschluss beendet');
}

export async function completeLlm(req: LlmRequest): Promise<LlmCompletion> {
  if (req.stream && req.onToken) return streamLlm(req, req.onToken);
  if (typeof window !== 'undefined') {
    const resp = await fetch('/api/ai/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`AI-API HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    return (await resp.json()) as LlmCompletion;
  }
  return llmRouter.complete(req);
}
