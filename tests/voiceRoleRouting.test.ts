/**
 * RT-AUDIT-P1-014-F2 · Voice-Tasks ueber die Flotte statt nur ueber die URL
 * ========================================================================
 * Der Punkt des Tickets ist nicht "es gibt eine Rolle", sondern: TTS/Song/SFX
 * laufen OHNE `VOICE_AI_RUNTIME_URL` ueber die eigene Flotten-Rolle
 * (endpointRegistry: voiceGen -> tts/audio.generate, music -> song/sing).
 *
 * Diese Datei setzt `VOICE_AI_RUNTIME_URL` bewusst NICHT und auch keine
 * RunPod-Endpoint-IDs: die Rolle wird durch einen Fake-Provider im echten Router
 * vertreten (`aiOrchestrator.providers.register`), der mitschreibt und ein WAV
 * liefert. Damit ist der Rollen-Weg gegen die ECHTE Route gemessen - ohne Netz.
 *
 * Was hier NICHT behauptet wird: `sing`. Im Manifest hat kein Modell task `sing`
 * (der Worker legt `sing` auf einen Bark-Handler), also gibt es keinen
 * Rollen-Weg - der Test haelt diesen Zustand ausdruecklich fest, statt ihn
 * stillschweigend schoen zu faerben (Ticket AI-RUNPOD-SING-001).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

process.env.API_RATE_LIMIT_MAX = '10000';
process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '10000';
process.env.STUDIO_ACCESS_TOKEN = '';
process.env.NODE_ENV = 'test';
// Der Kern des Tickets: keine feste Runtime. Auch keine Rollen-Endpoint-IDs,
// damit kein echter RunPod-Aufruf entstehen kann.
delete process.env.VOICE_AI_RUNTIME_URL;
delete process.env.RP_ENDPOINT_ID_VOICE;
delete process.env.RP_ENDPOINT_ID_MUSIC;
delete process.env.SONG_AI_ACE_STEP_URL;
delete process.env.SONG_AI_DIFF_RHYTHM_URL;

const { aiOrchestrator } = await import('../src/core/ai/orchestrator/aiOrchestrator');
const { startServer } = await import('../server');

/* --------------------------------------------------------------------------
 * Fake-Rolle: verhaelt sich wie ein konfigurierter Flotten-Endpoint
 * -------------------------------------------------------------------------- */
const roleCalls: { task: string; model: string; input: Record<string, unknown> }[] = [];
const roleCanRunTask: Record<string, boolean> = { tts: true, sing: true, song: true, 'audio.generate': true };
const roleFails: Record<string, boolean> = {};
const FAKE_WAV = Buffer.alloc(44, 7);

function resetRoleState(): void {
  roleCalls.length = 0;
  roleCanRunTask.tts = true;
  roleCanRunTask.sing = true;
  roleCanRunTask.song = true;
  roleCanRunTask['audio.generate'] = true;
  for (const key of Object.keys(roleFails)) delete roleFails[key];
}

aiOrchestrator.providers.register({
  id: 'runpod-voice',
  get available() {
    return Object.values(roleCanRunTask).some(Boolean);
  },
  canRun: (task) => Boolean(roleCanRunTask[task]),
  estimateCostUsd: () => 0,
  run: async (task, model, input) => {
    roleCalls.push({ task, model, input: (input ?? {}) as Record<string, unknown> });
    if (roleFails[task]) throw new Error('Rolle absichtlich kaputt');
    return { audioBase64: FAKE_WAV.toString('base64'), sampleRate: 24000 };
  },
});

let baseUrl = '';
let httpServer: { close(cb: () => void): void } | null = null;

beforeAll(async () => {
  const started = await startServer(0);
  httpServer = started?.httpServer ?? null;
  const address = httpServer && (httpServer as unknown as { address(): AddressInfo | null }).address();
  baseUrl = `http://127.0.0.1:${address?.port ?? 0}`;
}, 60_000);

afterAll(() => {
  httpServer?.close(() => {});
});

/** Audio-Route aufrufen und die Antwort roh zurueckgeben. */
async function postJson(path: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('RT-AUDIT-P1-014-F2 · Rollen-Weg ohne VOICE_AI_RUNTIME_URL', () => {
  it('tts laeuft ueber die Rolle voiceGen (qwen3-tts-17b), ohne Runtime-URL', async () => {
    resetRoleState();
    const res = await postJson('/api/voice/tts', { text: 'Hallo Welt' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/wav');
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0].task).toBe('tts');
    expect(roleCalls[0].model).toBe('qwen3-tts-17b');
    // Der Rollen-Worker liest genau diese Schluessel (handlers.qwen3_tts).
    expect(roleCalls[0].input).toMatchObject({ language: 'German', speaker: 'Ryan' });
    expect(String(roleCalls[0].input.text)).toContain('Hallo');
  });

  it('song laeuft ueber die Rolle music (acestep-v15-xl-sft, Betreiber 2026-10-12) und schickt durationSeconds', async () => {
    resetRoleState();
    const res = await postJson('/api/voice/song', { prompt: 'ruhiger Techno', durationSeconds: 12 });
    expect(res.status).toBe(200);
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0].task).toBe('song');
    expect(roleCalls[0].model).toBe('acestep-v15-xl-sft');
    // ACE-Step liest `durationSeconds`; `maxDuration` gehoert zur MusicGen-Strecke.
    expect(roleCalls[0].input.durationSeconds).toBeCloseTo(12, 5);
    expect(roleCalls[0].input).not.toHaveProperty('maxDuration');
  });

  it('soundMONK laeuft ueber die Rolle voiceGen (audio.generate -> stable-audio-open-1.0)', async () => {
    resetRoleState();
    const res = await postJson('/api/sound/generate', { kind: 'oneshot', prompt: 'clave', durationSeconds: 3 });
    expect(res.status).toBe(200);
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0].task).toBe('audio.generate');
    expect(roleCalls[0].model).toBe('stable-audio-open-1.0');
  });

  it('feste Runtime bleibt der Rueckfall: ohne Rolle meldet die Route 503', async () => {
    resetRoleState();
    roleCanRunTask.tts = false;
    roleCanRunTask.sing = false;
    roleCanRunTask.song = false;
    roleCanRunTask['audio.generate'] = false;
    for (const path of ['/api/voice/tts', '/api/voice/sing', '/api/voice/song', '/api/sound/generate']) {
      const res = await postJson(path, { text: 'x', prompt: 'x' });
      expect(res.status, path).toBe(503);
    }
    expect(roleCalls).toHaveLength(0);
  });

  it('eine kaputte Rolle endet nicht in einem stillen Erfolg, sondern als Fehler', async () => {
    resetRoleState();
    roleFails.tts = true;
    const res = await postJson('/api/voice/tts', { text: 'Hallo Welt' });
    // Rolle versucht (gemeldet), Runtime-URL fehlt -> 502 mit Detail, kein 200.
    expect(roleCalls).toHaveLength(1);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string; detail?: string };
    expect(body.error).toBe('tts fehlgeschlagen');
    expect(String(body.detail)).toContain('VOICE_AI_RUNTIME_URL');
  });

  it('sing laeuft ueber die Rolle music (bark-small) und schickt den Noten-Prompt', async () => {
    resetRoleState();
    const res = await postJson('/api/voice/sing', { text: 'la la la' });
    expect(res.status).toBe(200);
    expect(roleCalls).toHaveLength(1);
    // AI-RUNPOD-SING-001: bis 2026-10-11 hatte kein Manifest-Modell task `sing` -
    // der Rollen-Weg war unbedienbar. Jetzt bedient bark-small ihn.
    expect(roleCalls[0].task).toBe('sing');
    expect(roleCalls[0].model).toBe('bark-small');
    // Bark singt am zuverlaessigsten mit dem Noten-Prompt (handlers.hf_bark_sing).
    expect(String(roleCalls[0].input.text)).toMatch(/^\u266a .* \u266a$/);
  });
});
