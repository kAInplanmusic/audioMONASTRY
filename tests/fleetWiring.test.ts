import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildFleetTarget,
  createFleetWiring,
  fleetNodeAddress,
  resolveFleetMapUrl,
} from '../server/fleetWiring';

/**
 * ARCH-P2-002 · Flotten-Verdrahtung
 * =====================================================================
 * Die Ziele werden beim Start aus der Flotten-Map ueberschrieben. Zwei Dinge
 * muessen dabei stimmen, sonst ist der Fehler still:
 *   1. die Ziel-Validierung (SSRF-/Injection-Werte duerfen NICHT durchkommen),
 *   2. die Verdrahtung darf keine Wertkopie sein - die Routen lesen die Ziele
 *      zur Laufzeit.
 */

const legacyMap = {
  'samplemonk-master-1': '10.0.0.5',
  'samplemonk-ai-1': '10.0.0.6:9000',
};
const newMap = {
  'audiomonastry-master-1': '10.0.1.5',
  'audiomonastry-ai-1': '10.0.1.6',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ARCH-P2-002 · Flotten-Verdrahtung', () => {
  it('akzeptiert nur https fuer die Fleet-Map (S-9)', () => {
    expect(resolveFleetMapUrl('https://portal.example/api/fleet-map')).toBe('https://portal.example/api/fleet-map');
    // http waere ein Klartext-Kanal fuer den Studio-Token -> Default bleibt.
    expect(resolveFleetMapUrl('http://portal.example/api/fleet-map')).toBe('https://anunnakitools.de/api/fleet-map');
    expect(resolveFleetMapUrl('kein-url')).toBe('https://anunnakitools.de/api/fleet-map');
  });

  it('weist unsichere Knotenwerte ab und baut gueltige Ziele', () => {
    expect(buildFleetTarget('10.0.0.5', 8000)).toBe('http://10.0.0.5:8000');
    expect(buildFleetTarget('host.example:9000', 8000)).toBe('http://host.example:9000');
    // Werte sind host[:port] OHNE Schema - ein Schema wuerde ueber die
    // Zeichenpruefung (/ und :) abgelehnt. Das ist Absicht (1:1 aus server.ts
    // uebernommen): das Ziel wird hier gebaut, nicht uebernommen.
    expect(buildFleetTarget('https://host.example', 8000)).toBe('');
    expect(buildFleetTarget('host.example', 8000)).toBe('http://host.example:8000');
    // Injection/SSRF-Versuche und Unsinn:
    for (const bad of ['', '   ', 'host with space', 'user@host', 'host/path', 'host?x=1', 'host#frag', 'host&x', '-'.repeat(300), 'host:0', 'host:99999', 'host:abc', 'host_underscore']) {
      expect(buildFleetTarget(bad, 8000)).toBe('');
    }
    expect(buildFleetTarget(null, 8000)).toBe('');
    expect(buildFleetTarget(42, 8000)).toBe('');
  });

  it('findet Knoten unter neuem UND altem Namen (NOMEN-P1-001)', () => {
    expect(fleetNodeAddress(newMap, 'audiomonastry-master-1')).toBe('10.0.1.5');
    // Bestandsflotte: die Map liefert die alten Namen -> Fallback greift.
    expect(fleetNodeAddress(legacyMap, 'audiomonastry-master-1')).toBe('10.0.0.5');
    expect(fleetNodeAddress({}, 'audiomonastry-master-1')).toBeUndefined();
  });

  it('verdrahtet master-player und die AI-Knoten aus der Map', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ fleet: newMap })));
    const wiring = createFleetWiring({ studioToken: 'token', log: () => {} });

    await wiring.wire();

    expect(wiring.targets.masterPlayer).toBe('http://10.0.1.5:8000');
    expect(wiring.targets.stemAi).toBe('http://10.0.1.6:8000');
    expect(wiring.targets.ollama).toBe('http://10.0.1.6:11434');
  });

  it('verdrahtet auch eine Altflotte (Bestandsnamen in der Map)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ fleet: legacyMap })));
    const wiring = createFleetWiring({ studioToken: 'token', log: () => {} });

    await wiring.wire();

    expect(wiring.targets.masterPlayer).toBe('http://10.0.0.5:8000');
    // Port aus der Map (9000) wird respektiert.
    expect(wiring.targets.stemAi).toBe('http://10.0.0.6:9000');
  });

  it('laesst die Ziele bei Fehlern unveraendert und ruft ohne Token gar nicht ab', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetchMock);
    const wiring = createFleetWiring({ studioToken: 'token', warn: () => {} });
    await wiring.wire();
    expect(wiring.targets).toEqual({ masterPlayer: '', ollama: '', stemAi: '' });

    const noToken = vi.fn(async () => Response.json({ fleet: newMap }));
    vi.stubGlobal('fetch', noToken);
    await createFleetWiring({ studioToken: '' }).wire();
    expect(noToken).not.toHaveBeenCalled();
  });

  it('veroeffentlicht die Ziele als Getter (keine eingefrorene Wertkopie)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ fleet: newMap })));
    const wiring = createFleetWiring({ studioToken: 'token', log: () => {} });
    const targets = wiring.targets; // so reicht server.ts sie an die Routen weiter

    await wiring.wire();

    // Die zuvor geholte Referenz sieht die neuen Werte - genau das war der
    // Fehler, den eine Wertkopie erzeugt haette.
    expect(targets.masterPlayer).toBe('http://10.0.1.5:8000');
  });
});
