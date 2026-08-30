/**
 * audioMONASTRY · 4.2.1/4.2.3 – KI-Backend-Routing mit Qualitätsstufen
 * =====================================================================
 * Fallback-Kette: lokal → remote → deterministisch. Drei Qualitätsstufen
 * (preview/standard/high) wählen das passende Backend.
 */
import type { AIBackendKind, IAIRuntime, AIResult } from '../core/interfaces';

export type AIQuality = 'preview' | 'standard' | 'high';

export interface AIRoute {
  kind: AIBackendKind;
  backend: IAIRuntime;
  /** Höhere Zahl = bevorzugt. */
  priority: number;
  /** Erlaubte Qualitätsstufen dieses Backends. */
  qualities: AIQuality[];
}

export class AIRouter {
  private routes: AIRoute[] = [];

  register(route: AIRoute): void {
    this.routes.push(route);
    this.routes.sort((a, b) => b.priority - a.priority);
  }

  /** Wählt das beste verfügbare Backend für Task + Qualität. */
  select(task: string, quality: AIQuality): IAIRuntime | null {
    for (const route of this.routes) {
      if (!route.qualities.includes(quality)) continue;
      if (!route.backend.canRun(route.kind, task)) continue;
      return route.backend;
    }
    return null;
  }

  /** Führt die Fallback-Kette aus (local → remote → deterministic). */
  async infer(task: string, input: unknown, quality: AIQuality = 'standard'): Promise<AIResult> {
    const preferredOrder: AIBackendKind[] = ['local', 'remote', 'deterministic'];
    let lastError: unknown = null;
    for (const kind of preferredOrder) {
      const route = this.routes.find((r) => r.kind === kind && r.qualities.includes(quality));
      if (!route || !route.backend.canRun(kind, task)) continue;
      try {
        return await route.backend.infer(task, input);
      } catch (e) {
        lastError = e;
      }
    }
    const fb = this.select(task, quality);
    if (fb) return fb.infer(task, input);
    throw lastError ?? new Error(`Kein KI-Backend für ${task} verfügbar`);
  }

  /** Aktiv registrierte Routen (Monitoring/UI). */
  list(): AIRoute[] {
    return [...this.routes];
  }
}

export const aiRouter = new AIRouter();
