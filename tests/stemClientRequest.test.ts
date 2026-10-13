// FLEET-P1-006: stemMONK-Client -> /api/separate-stems. Kein Schein-Ergebnis mehr:
// Fehler kommen als status 'error' mit Code/Meldung zurueck (vorher: mock_url_*).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAudioAI } from '../src/hooks/useAudioAI';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('streamStems', () => {
  it('schickt mode/targetBpm/targetKey und liefert die URL-Antwort', async () => {
    let sent: FormData | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent = init.body as FormData;
      return jsonResponse(200, { status: 'success', provider: 'rp5', mode: '5stem', stems: { vocals: '/api/media/uploads/v.wav' } });
    }));
    const res = await useAudioAI().separateStems(new File([new Uint8Array(4)], 'a.wav'), { mode: '5stem', targetBpm: 127.999, targetKey: 'Am' });
    expect(res.status).toBe('success');
    expect(res.stems?.vocals).toBe('/api/media/uploads/v.wav');
    expect(sent!.get('mode')).toBe('5stem');
    expect(sent!.get('targetBpm')).toBe('128');
    expect(sent!.get('targetKey')).toBe('Am');
  });

  it('Serverfehler bleibt ein Fehler mit Code, Meldung und Hinweis', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, { status: 'error', code: 'STEM_MODEL_UNAVAILABLE', message: 'Gewichte fehlen', hint: 'spiegeln' })));
    const res = await useAudioAI().separateStems(new File([new Uint8Array(4)], 'a.wav'));
    expect(res).toMatchObject({ status: 'error', code: 'STEM_MODEL_UNAVAILABLE', message: 'Gewichte fehlen', hint: 'spiegeln' });
    expect(res.stems).toBeUndefined();
  });

  it('Netzfehler: kein Mock-Ergebnis', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const res = await useAudioAI().separateStems(new File([new Uint8Array(4)], 'a.wav'));
    expect(res.status).toBe('error');
    expect(res.code).toBe('NETWORK');
    expect(JSON.stringify(res)).not.toContain('mock_url');
  });
});
