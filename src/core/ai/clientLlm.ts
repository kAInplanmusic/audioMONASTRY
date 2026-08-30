/**
 * audioMONASTRY · Client-LLM-Zugriff (Server-Proxy)
 * ==================================================
 * Im Browser laufen LLM-Calls über `POST /api/ai/complete` (Keys bleiben
 * serverseitig). In Node (Server/Tests) wird der LlmRouter direkt genutzt.
 */
import { llmRouter, type LlmCompletion, type LlmRequest } from './LlmRouter';

export async function completeLlm(req: LlmRequest): Promise<LlmCompletion> {
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
