import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Signaling-Origin in lokalen Laeufen.
 *
 * BEFUND 2026-11-05: `SOCKET_IO_SIGNALING_URL` fiel im Dev-/Test-Pfad auf den
 * hartkodierten Wert `http://localhost:8080` zurueck. Wer die App ueber
 * `127.0.0.1` oder eine LAN-IP oeffnet, dessen Client verbindet sich damit auf
 * einen ANDEREN Host: `localhost` loest zuerst auf `::1` auf, der Express-Server
 * lauscht auf 0.0.0.0 (IPv4-only) -> keine Socket-Verbindung -> kein Mitglied in
 * der Session -> `ensureMixerHolder` bekommt eine leere Mitgliederliste -> der
 * Mixer hat nie einen Halter und das Pult bleibt gesperrt. Die E2E-Suite zeigt
 * das als 27 Fehler, das Kopf-Icon als "mixerMONK, frei, aktiv".
 *
 * Deshalb muss der lokale Default der Origin SEIN, unter dem die Seite geladen
 * wurde - nicht ein fest verdrahtetes localhost.
 */
type FakeLocation = { hostname: string; origin: string; protocol: string; host: string };

function stubWindow(location: FakeLocation): void {
  vi.stubGlobal('window', { location });
}

async function loadRuntime(): Promise<typeof import('../src/config/runtime')> {
  vi.resetModules();
  return import('../src/config/runtime');
}

describe('Signaling-Origin im lokalen Betrieb', () => {
  beforeEach(() => { vi.unstubAllEnvs(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('127.0.0.1: Socket- und WS-Origin folgen der geladenen Seite', async () => {
    stubWindow({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:8080', protocol: 'http:', host: '127.0.0.1:8080' });
    const rt = await loadRuntime();
    expect(rt.SOCKET_IO_SIGNALING_URL).toBe('http://127.0.0.1:8080');
    expect(rt.SIGNALING_WS_URL).toBe('ws://127.0.0.1:8080');
    expect(rt.API_BASE_URL).toBe('http://127.0.0.1:8080/api');
  });

  it('localhost bleibt localhost (inkl. Port der Seite)', async () => {
    stubWindow({ hostname: 'localhost', origin: 'http://localhost:8080', protocol: 'http:', host: 'localhost:8080' });
    const rt = await loadRuntime();
    expect(rt.SOCKET_IO_SIGNALING_URL).toBe('http://localhost:8080');
    expect(rt.SIGNALING_WS_URL).toBe('ws://localhost:8080');
  });

  it('anderer lokaler Port wird uebernommen (kein festes 8080)', async () => {
    stubWindow({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:8090', protocol: 'http:', host: '127.0.0.1:8090' });
    const rt = await loadRuntime();
    expect(rt.SOCKET_IO_SIGNALING_URL).toBe('http://127.0.0.1:8090');
    expect(rt.SIGNALING_WS_URL).toBe('ws://127.0.0.1:8090');
  });

  it('echter Host: same-origin, keine absolute URL', async () => {
    stubWindow({ hostname: 'anunnakitools.de', origin: 'https://anunnakitools.de', protocol: 'https:', host: 'anunnakitools.de' });
    const rt = await loadRuntime();
    expect(rt.SOCKET_IO_SIGNALING_URL).toBe('');
    expect(rt.SIGNALING_WS_URL).toBe('');
    expect(rt.API_BASE_URL).toBe('/api');
  });

  it('explizite VITE-Variable gewinnt weiterhin', async () => {
    stubWindow({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:8080', protocol: 'http:', host: '127.0.0.1:8080' });
    vi.stubEnv('VITE_SOCKET_IO_SIGNALING_URL', 'http://10.0.0.5:9000/');
    const rt = await loadRuntime();
    expect(rt.SOCKET_IO_SIGNALING_URL).toBe('http://10.0.0.5:9000');
  });
});
