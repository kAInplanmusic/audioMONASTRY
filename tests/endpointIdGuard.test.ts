/**
 * INFRA-RUNPOD-007 – Wächter gegen doppelt belegte Endpoint-IDs
 * =====================================================================
 * Befund V3-1: Der Legacy-Fallback (`RP_ENDPOINT_ID`) darf alle acht Rollen auf
 * EINEN Endpoint biegen – das ist der dokumentierte Migrationspfad und muss
 * erlaubt bleiben. Zwei EXPLIZITE Rollen-IDs auf derselben ID sind dagegen eine
 * Fehlkonfiguration (doppeltes `workersMin`, doppelt gebuchte Endpoint-Kosten).
 * `auditRoleEndpointIds()` unterscheidet beide Fälle; der `ProviderRouter`
 * bricht beim Start hart ab, `fleetStatus()` berichtet nur.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditRoleEndpointIds } from '../src/core/ai/orchestrator/endpointRegistry';
import { ProviderRouter } from '../src/core/ai/orchestrator/providerRouter';
import { fleetStatus } from '../src/core/ai/orchestrator/fleetWake';

const ENDPOINT_ENV_KEYS = [
  'RP_ENDPOINT_ID',
  'RUNPOD_ENDPOINT_ID',
  'RP_ENDPOINT_ID_BRAIN',
  'RP_ENDPOINT_ID_EARS',
  'RP_ENDPOINT_ID_VOICE',
  'RP_ENDPOINT_ID_MUSIC',
  'RP_ENDPOINT_ID_IMAGE',
  'RP_ENDPOINT_ID_VIDEO_REAL',
  'RP_ENDPOINT_ID_VIDEO_ABSTRACT',
  'RP_ENDPOINT_ID_ORCHESTRATOR',
  'RUNPOD_ENDPOINT_ID_BRAIN',
  'RUNPOD_ENDPOINT_ID_EARS',
  'RUNPOD_ENDPOINT_ID_VOICE',
  'RUNPOD_ENDPOINT_ID_MUSIC',
  'RUNPOD_ENDPOINT_ID_IMAGE',
  'RUNPOD_ENDPOINT_ID_VIDEO_REAL',
  'RUNPOD_ENDPOINT_ID_VIDEO_ABSTRACT',
  'RUNPOD_ENDPOINT_ID_ORCHESTRATOR',
] as const;

/** Setzt Endpoint-Env für einen Test und stellt sie danach exakt wieder her. */
function withEndpointEnv(values: Partial<Record<string, string>>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENDPOINT_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(() => {
  for (const key of ENDPOINT_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENDPOINT_ENV_KEYS) delete process.env[key];
});

describe('Endpoint-ID-Wächter (INFRA-RUNPOD-007)', () => {
  it('meldet den gewollten Legacy-Fall laut, wirft aber nicht (alle acht Rollen auf RP_ENDPOINT_ID)', () => {
    withEndpointEnv({ RP_ENDPOINT_ID: 'legacy-ep' }, () => {
      const audit = auditRoleEndpointIds();
      expect(audit.ok).toBe(true);
      expect(audit.legacyFallback).toBe(true);
      expect(audit.collisions).toHaveLength(1);
      expect(audit.collisions[0]).toMatchObject({ endpointId: 'legacy-ep', legacy: true });
      expect(audit.collisions[0].roles).toHaveLength(8);
      expect(audit.message).toMatch(/Legacy-Modus/);

      // Der Migrationspfad darf den Provider-Router-Start nicht sprengen.
      expect(() => new ProviderRouter()).not.toThrow();
    });
  });

  it('wirft bei zwei expliziten Rollen-IDs auf derselben Endpoint-ID (ohne Legacy-Modus)', () => {
    withEndpointEnv(
      { RP_ENDPOINT_ID_IMAGE: 'same-ep', RP_ENDPOINT_ID_VIDEO_REAL: 'same-ep' },
      () => {
        // Hart: der Wächter wirft ...
        expect(() => auditRoleEndpointIds()).toThrow(/ohne Legacy-Modus/);
        // ... und der Provider-Router bricht beim Start ab.
        expect(() => new ProviderRouter()).toThrow(/Endpoint-ID-Konflikt/);

        // Der reine Bericht (fleetStatus) wirft nie, er zeigt den Konflikt.
        const audit = auditRoleEndpointIds({ strict: false });
        expect(audit.ok).toBe(false);
        expect(audit.collisions).toEqual([
          { endpointId: 'same-ep', roles: ['imageHq', 'videoReal'], legacy: false },
        ]);
        const status = fleetStatus() as { endpointAudit: { ok: boolean; collisions: unknown[] } };
        expect(status.endpointAudit.ok).toBe(false);
        expect(status.endpointAudit.collisions).toHaveLength(1);
      },
    );
  });

  it('wirft auch, wenn eine explizite Rollen-ID genau die Legacy-ID noch einmal setzt', () => {
    // Mischfall: eine Zeile Env zu viel. Der Legacy-Modus erklaert den
    // gemeinsamen Endpoint nur fuer Rollen OHNE eigene ID – eine Rolle, die
    // RP_ENDPOINT_ID ausdruecklich wiederholt, ist eine Doppelbelegung.
    withEndpointEnv({ RP_ENDPOINT_ID: 'legacy-ep', RP_ENDPOINT_ID_BRAIN: 'legacy-ep' }, () => {
      const audit = auditRoleEndpointIds({ strict: false });
      expect(audit.ok).toBe(false);
      expect(audit.collisions[0].roles).toContain('brain');
      expect(audit.collisions[0].legacy).toBe(false);
      expect(() => new ProviderRouter()).toThrow(/Endpoint-ID-Konflikt/);
    });
  });

  it('ist still, wenn jede Rolle eine eigene Endpoint-ID hat (Live-Stand)', () => {
    withEndpointEnv(
      {
        RP_ENDPOINT_ID_BRAIN: 'brain-ep',
        RP_ENDPOINT_ID_EARS: 'ears-ep',
        RP_ENDPOINT_ID_VOICE: 'voice-ep',
        RP_ENDPOINT_ID_MUSIC: 'music-ep',
        RP_ENDPOINT_ID_IMAGE: 'image-ep',
        RP_ENDPOINT_ID_VIDEO_REAL: 'video-real-ep',
        RP_ENDPOINT_ID_VIDEO_ABSTRACT: 'video-abstract-ep',
        RP_ENDPOINT_ID_ORCHESTRATOR: 'orchestrator-ep',
      },
      () => {
        const audit = auditRoleEndpointIds();
        expect(audit.ok).toBe(true);
        expect(audit.legacyFallback).toBe(false);
        expect(audit.collisions).toEqual([]);
        expect(audit.message).toBe('Jede Rolle hat eine eigene Endpoint-ID.');
        expect(() => new ProviderRouter()).not.toThrow();
        const status = fleetStatus() as { endpointAudit: { ok: boolean } };
        expect(status.endpointAudit.ok).toBe(true);
      },
    );
  });
});
