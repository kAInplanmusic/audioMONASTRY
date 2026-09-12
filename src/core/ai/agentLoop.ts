/**
 * audioMONASTRY · Agent-Loop-Einstieg (AI-P1-003 P5, Integrationsschicht)
 * ======================================================================
 * Verdrahtet den in `MoaAgent` gebauten Loop (planen → WRITE-gate → ausführen →
 * prüfen → korrigieren) mit echter Kontext-Assembly:
 *
 *   - `routing.json` (global/tracks/buses/connections) – damit der Planer weiß,
 *     welche Spuren/Busse existieren und keine toten Ziele plant,
 *   - Session-/Projektzustand (z. B. `SessionManager.getState()`).
 *
 * Der Executor ist der Default des MoaAgent (`VoiceControlService`), Locks/RBAC
 * liegen dort. Wer `runTask` aufruft (UI/Route), ist bewusst NICHT hier
 * entschieden – der Einstieg ist eine testbare Bibliotheksfunktion.
 */
import { MoaAgent, moaAgent, type MoaRunOptions, type MoaRunResult } from './MoaAgent';

export interface AgentContextInput {
  routing?: unknown;
  sessionState?: unknown;
}

interface RoutingLike {
  global?: Record<string, unknown>;
  tracks?: unknown[];
  buses?: unknown[];
  connections?: unknown[];
}

/**
 * Baut den Planungskontext als kompakten, deterministischen String.
 * Unbekannte/fehlende Felder werden ausgelassen; Obergrenze 2000 Zeichen
 * (deckungsgleich mit dem Prompt-Limit in MoaAgent.plan).
 */
export function assembleAgentContext(input: AgentContextInput): string {
  const parts: string[] = [];
  const r = input.routing as RoutingLike | undefined;
  if (r && typeof r === 'object') {
    if (r.global && typeof r.global === 'object') parts.push(`routing.global=${JSON.stringify(r.global)}`);
    if (Array.isArray(r.tracks)) parts.push(`routing.tracks=${r.tracks.length}`);
    if (Array.isArray(r.buses)) parts.push(`routing.buses=${JSON.stringify(r.buses)}`);
    if (Array.isArray(r.connections)) parts.push(`routing.connections=${r.connections.length}`);
  }
  if (input.sessionState !== undefined) parts.push(`session=${JSON.stringify(input.sessionState)}`);
  return parts.join('; ').slice(0, 2000);
}

/** Agent-Loop-Einstieg: MoaAgent.run() mit Kontext-Assembly. */
export class AiAgentLoop {
  constructor(private readonly agent: MoaAgent = moaAgent) {}

  async runTask(
    task: string,
    opts: {
      userId?: string;
      routing?: unknown;
      sessionState?: unknown;
      confirmWrite?: MoaRunOptions['confirmWrite'];
      maxCorrections?: number;
    } = {},
  ): Promise<MoaRunResult> {
    const context = assembleAgentContext({ routing: opts.routing, sessionState: opts.sessionState });
    return this.agent.run(task, {
      userId: opts.userId ?? 'localUser',
      context,
      confirmWrite: opts.confirmWrite,
      maxCorrections: opts.maxCorrections,
    });
  }
}
