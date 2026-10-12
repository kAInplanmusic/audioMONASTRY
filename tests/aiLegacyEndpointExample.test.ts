/**
 * DA-2026-09-29-019 · Wächter für den abgelösten HF-Endpoint-Pfad
 * =====================================================================
 * Der Deep-Audit fand, dass `services/audiomonastry-ai-runtime/hf_endpoint.example.json`
 * im container-Block kein `image` und keinen Digest hat - so waere der Endpoint
 * nicht reproduzierbar deploybar. Die Triage (2026-10-01) hat entschieden: der
 * ganze HF-Inference-Endpoint-Weg ist seit 2026-09-20 abgeloest (GPU-Inferenz
 * laeuft auf den RunPod-Rollen), die Datei ist eine historische Vorlage ohne
 * Konsumenten. Sie wird deshalb NICHT "repariert" (kein Image erfunden), sondern
 * als abgeloest gekennzeichnet.
 *
 * Ein toter Deploypfad ist nur so lange harmlos, wie ihn niemand wieder
 * anschliesst - und genau das war hier schon der Fall: `scripts/deploy-ai.sh`
 * behauptete, das PRODUKTIONS-GPU-Deployment laufe ueber den HF-Endpoint.
 * Dieser Waechter haelt den Zustand fest:
 *   1. die Vorlage traegt den Legacy-Hinweis maschinenlesbar,
 *   2. ausser Doku (Nennung als "ueberholt"), SSOT, Audit-Rohdaten und diesem
 *      Waechter nennt sie keine Datei mehr,
 *   3. `scripts/deploy-ai.sh` nennt RunPod als Produktionsweg.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const VORLAGE = 'services/audiomonastry-ai-runtime/hf_endpoint.example.json';
const DEPLOY_SKRIPT = 'scripts/deploy-ai.sh';

/** Dateien, die den abgeloesten Pfad nennen duerfen - mit Begruendung. */
const ERLAUBT: Record<string, string> = {
  [VORLAGE]: 'Die Vorlage selbst - sie traegt den Legacy-Hinweis.',
  'MASTERTODOENDE.json': 'SSOT: Fund + Triage muessen den Pfad nennen (Vergangenes wird nicht umgeschrieben).',
  'docs/AI_DEPLOYMENT_GUIDE.md': 'Kapitel 1 ist ausdruecklich als "ueberholt" markiert (historischer Weg).',
  'docs/AI_OPERATIONS.md': 'Dienst-Tabelle fuehrt die HF-Zeile als "ueberholt".',
  'docs/audit-infra-runpod.md': 'Audit-Belegkapitel, das den Legacy-Charakter feststellt.',
  'test-results/deep-audit/findings.json': 'Rohdaten des Deep-Audits (Messergebnis, wird nicht umgeschrieben).',
  'services/audiomonastry-ai-runtime/hf_manage_endpoint.py': 'Legacy-Werkzeug genau dieser Endpunkte (delete-legacy).',
  'tests/aiLegacyEndpointExample.test.ts': 'Dieser Waechter selbst.',
};

/** Dateien mit dem Suchmuster - per `git grep` statt jede Datei in JS zu lesen. */
function dateienMitTreffer(muster: string): string[] {
  try {
    return execFileSync('git', ['grep', '-l', '-I', '-F', muster, '--', '.'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ''));
  } catch (err) {
    // git grep endet mit Exit 1, wenn es KEINEN Treffer gibt - das ist hier der Idealfall.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

interface Vorlage {
  _legacy?: { status?: string; grund?: string; nichtDeploybar?: string; stattdessen?: string };
  container?: Record<string, unknown>;
}

describe('abgeloester HF-Endpoint-Pfad (DA-2026-09-29-019)', () => {
  it('die Vorlage ist maschinenlesbar als abgeloest markiert', () => {
    const vorlage = JSON.parse(readFileSync(VORLAGE, 'utf8')) as Vorlage;
    expect(vorlage._legacy?.status).toBe('abgeloest');
    expect(vorlage._legacy?.nichtDeploybar ?? '').toMatch(/image/i);
    expect(vorlage._legacy?.stattdessen ?? '').toMatch(/runpod/i);
  });

  it('der container-Block bleibt ohne image/Digest (kein deploybarer Pfad vorgaukeln)', () => {
    const vorlage = JSON.parse(readFileSync(VORLAGE, 'utf8')) as Vorlage;
    const container = vorlage.container ?? {};
    expect(container).not.toHaveProperty('image');
    expect(container).not.toHaveProperty('digest');
  });

  it('kein Code liest die Vorlage - nur Doku, SSOT, Audit-Rohdaten und dieser Waechter', () => {
    const treffer = dateienMitTreffer(VORLAGE);
    expect(treffer.length).toBeGreaterThan(0);
    expect(treffer.filter((datei) => !(datei in ERLAUBT))).toEqual([]);
  });

  it('deploy-ai.sh nennt RunPod als Produktionsweg und nicht mehr den HF-Endpoint', () => {
    const skript = readFileSync(DEPLOY_SKRIPT, 'utf8');
    expect(skript).toMatch(/RunPod/);
    expect(skript).not.toMatch(/Produktions-GPU-Deployment läuft[\s\S]{0,60}HF-Inference-Endpoint/);
  });
});
