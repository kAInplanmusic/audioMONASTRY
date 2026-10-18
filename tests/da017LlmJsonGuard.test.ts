/**
 * DA-2026-10-17-017 · LLM-Antworten mit Typpruefung behandeln
 * ===========================================================
 * Der Befund: `JSON.parse(...) as Record<string, unknown>` und anschliessendes
 * Spreaden. Eine Liste (`[{"chosen":"a"}]`, `["a","b"]`) wurde damit als Objekt
 * missbraucht (Keys "0", "1") bzw. lief beim Feldzugriff ins Leere.
 *
 * Geprueft wird der Guard (Unit) und die echte Route `/api/ai/generate` gegen
 * ein Brain, das eine Liste liefert.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isJsonObject, normalizeJsonObject, parseLlmJsonObject } from '../src/core/ai/llmJson';
import { parsePlanAnswer } from '../src/core/ai/orchestrator/evalGrading';

process.env.API_RATE_LIMIT_MAX = '10000';
process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '10000';
process.env.STUDIO_ACCESS_TOKEN = '';
process.env.NODE_ENV = 'test';

describe('DA-2026-10-17-017 · JSON-Guard', () => {
  it('nimmt ein normales Objekt (auch mit Code-Fence)', () => {
    expect(parseLlmJsonObject('{"chosen":"a"}')).toEqual({ chosen: 'a' });
    expect(parseLlmJsonObject('```json\n{"chosen":"a"}\n```')).toEqual({ chosen: 'a' });
  });

  it('packt ein Einelement-Array mit Objekt aus (Aggregator-Verhalten)', () => {
    expect(parseLlmJsonObject('[{"chosen":"a","reason":"x"}]')).toEqual({ chosen: 'a', reason: 'x' });
  });

  it('verwirft Listen aus Skalaren statt sie als Objekt zu lesen', () => {
    expect(parseLlmJsonObject('["a","b"]')).toBeNull();
    expect(parseLlmJsonObject('[1,2,3]')).toBeNull();
    expect(parseLlmJsonObject('[{"a":1},{"b":2}]')).toBeNull();
  });

  it('verwirft Skalare, null und kaputtes JSON', () => {
    for (const raw of ['42', '"text"', 'true', 'null', '', '{kaputt', 'kein json']) {
      expect(parseLlmJsonObject(raw), raw).toBeNull();
    }
  });

  it('erkennt Objekte nur ohne Array/Prototype-Trick', () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([1])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(normalizeJsonObject([{ a: 1 }])).toEqual({ a: 1 });
  });

  it('evalGrading liest eine Listen-Antwort nicht als Plan', () => {
    // Vorher: `["a","b"]` -> Feldzugriffe auf ein Array; jetzt sauber null.
    expect(parsePlanAnswer('["a","b"]')).toBeNull();
    expect(parsePlanAnswer('[{"pluginId":"mixer","command":"gain"}]'))
      .toEqual({ pluginId: 'mixer', command: 'gain' });
  });
});

/* --------------------------------------------------------------------------
 * Route: Brain liefert eine Liste
 * -------------------------------------------------------------------------- */
let content = '["a","b"]';
const brain = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

// Env VOR dem Server-Import setzen: der LlmRouter-Singleton entsteht beim Import
// und legt seine Provider-Verfuegbarkeit daran fest.
await new Promise<void>((resolve) => brain.listen(0, '127.0.0.1', resolve));
const brainPort = (brain.address() as AddressInfo).port;
process.env.RUNPOD_BRAIN_OPENAI_URL = `http://127.0.0.1:${brainPort}/v1`;
process.env.RUNPOD_BRAIN_OPENAI_MODEL = 'qwen3-14b';
// Der OpenAI-kompatible Brain-Pfad gilt nur mit gesetztem Key als verfuegbar.
process.env.RP_AGENT_KEY = 'rp_test';

const { startServer } = await import('../server');

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
  brain.close();
  delete process.env.RUNPOD_BRAIN_OPENAI_URL;
  delete process.env.RUNPOD_BRAIN_OPENAI_MODEL;
  delete process.env.RP_AGENT_KEY;
});

async function generate(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/ai/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'dark warehouse techno' }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('DA-2026-10-17-017 · /api/ai/generate', () => {
  it('spreadet eine Listen-Antwort nicht in die Response', async () => {
    content = '["a","b"]';
    const { status, body } = await generate();
    expect(status).toBe(200);
    // Keine Array-Indizes als Felder.
    expect(body).not.toHaveProperty('0');
    expect(body).not.toHaveProperty('1');
    // Stattdessen der deterministische lokale Fallback (echte Felder).
    expect(body).toHaveProperty('patterns');
    expect(typeof body.bpm).toBe('number');
  }, 30_000);

  it('uebernimmt ein Einelement-Array mit Objekt (Aggregator-Form)', async () => {
    content = '[{"bpm":133,"genre":"Aggregated Techno"}]';
    const { status, body } = await generate();
    expect(status).toBe(200);
    expect(body.bpm).toBe(133);
    expect(body.genre).toBe('Aggregated Techno');
    expect(body).not.toHaveProperty('0');
  }, 30_000);
});
