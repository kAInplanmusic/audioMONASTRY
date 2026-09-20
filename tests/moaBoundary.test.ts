// @vitest-environment node
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INFRA-AI-006: „MoA" war zweimal implementiert (TS + Python) und dazu kam
 * `services/taskWorker.ts` als dritter, paralleler Pfad ohne einen einzigen
 * KI-Task-Typ. Entschieden ist:
 *
 *   * MoA-Planung   – `src/core/ai/MoaAgent.ts` (client-/appseitig)
 *   * MoA-Ausführung – `services/audiomonastry-ai-runtime/moa_orchestrator.py`
 *     (serverseitig, Rolle `orchestrator`), erreichbar NUR über das MCP-Tool
 *     `agent.orchestrate`
 *   * Der Task-Worker ist ENTFERNT (Legacy, kein Produzent/Konsument im Repo).
 *
 * Dieser Wächter hält die Rollen-Marker und die eine Kante fest, damit die
 * Trennung nicht still verwässert (z. B. durch einen zweiten Aufrufpfad oder
 * eine dritte Queue).
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}${rel}`, 'utf-8');

describe('INFRA-AI-006 · MoA-Zustaendigkeiten und ihre einzige Kante', () => {
  it('benennt beide MoA-Wege in ihren Dateikoepfen', () => {
    const ts = read('src/core/ai/MoaAgent.ts');
    expect(ts).toContain('MoA-Planung');
    expect(ts).toContain('client-/appseitig');
    expect(ts).toContain('agent.orchestrate');

    const py = read('services/audiomonastry-ai-runtime/moa_orchestrator.py');
    expect(py).toContain('MoA-Ausfuehrung');
    expect(py).toContain('agent.orchestrate');
    expect(py).toContain('src/core/ai/MoaAgent.ts');
  });

  it('haelt die Kante ueber das MCP-Tool agent.orchestrate', () => {
    // Die Brücke muss existieren UND im MCP-Runtime registriert sein.
    const mcp = read('src/core/ai/orchestrator/mcpRuntime.ts');
    expect(mcp).toContain('agent.orchestrate');
    // Und die Server-Route, ueber die der Client sie erreicht.
    const routes = read('server/routes/aiRoutes.ts');
    expect(routes).toContain('/api/ai/mcp/tools/:name');
  });

  it('kennt keinen dritten parallelen Task-Worker-Pfad mehr', () => {
    expect(existsSync(`${root}services/taskWorker.ts`), 'services/taskWorker.ts ist zurueck').toBe(false);
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(Object.values(pkg.scripts).some((cmd) => cmd.includes('taskWorker'))).toBe(false);
    // Der RunPod-Worker (services/**/runpod_worker.py) bleibt selbstverstaendlich
    // bestehen - entfernt wurde nur die Datei-Queue `TASK_QUEUE.json`.
    expect(existsSync(`${root}services/audiomonastry-ai-runtime/runpod_worker.py`)).toBe(true);
  });

  it('dokumentiert die Trennung in der AI-Architektur', () => {
    const doc = read('docs/AI_ARCHITECTURE.md');
    expect(doc).toContain('MoA-Zuständigkeiten');
    expect(doc).toContain('MoA-Planung');
    expect(doc).toContain('MoA-Ausführung');
    expect(doc).toContain('agent.orchestrate');
  });
});
