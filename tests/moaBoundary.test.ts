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
    // Ein historisches Provider-Image ist kein Einstieg der aktiven Vast-Flotte.
    for (const recipe of ['Dockerfile.base', 'Dockerfile.vast', 'Dockerfile.yue2']) {
      const image = read(`services/audiomonastry-ai-runtime/${recipe}`);
      expect(image).not.toContain('runpod_worker.py');
      expect(image).toContain('vast_start.py');
    }
    expect(read('services/audiomonastry-ai-runtime/app.py')).toContain('@app.post("/run")');
  });

  it('dokumentiert die Trennung in der AI-Architektur', () => {
    const doc = read('docs/AI_ARCHITECTURE.md');
    expect(doc).toContain('MoA-Zuständigkeiten');
    expect(doc).toContain('MoA-Planung');
    expect(doc).toContain('MoA-Ausführung');
    expect(doc).toContain('agent.orchestrate');
  });
});
