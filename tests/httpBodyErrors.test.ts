import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import {
  MAX_CAUSE_LENGTH,
  createJsonBodyErrorHandler,
  describeJsonBodyError,
  requestIdOf,
  sanitizeCause,
} from '../server/httpBodyErrors';

describe('AI-P1-005 · describeJsonBodyError (rein)', () => {
  it('erkennt entity.parse.failed als 400 "invalid JSON body"', () => {
    const info = describeJsonBodyError({ type: 'entity.parse.failed', message: 'Unexpected token i in JSON at position 1' });
    expect(info).toEqual({
      status: 400,
      error: 'invalid JSON body',
      cause: 'Unexpected token i in JSON at position 1',
    });
  });

  it('erkennt entity.too.large als 413 "payload too large"', () => {
    const info = describeJsonBodyError({ type: 'entity.too.large', message: 'request entity too large' });
    expect(info?.status).toBe(413);
    expect(info?.error).toBe('payload too large');
  });

  it('gibt fuer fremde Fehler null zurueck (keine Umdeutung)', () => {
    expect(describeJsonBodyError(new Error('boom'))).toBeNull();
    expect(describeJsonBodyError({ type: 'something.else' })).toBeNull();
    expect(describeJsonBodyError(null)).toBeNull();
    expect(describeJsonBodyError('kaputt')).toBeNull();
  });

  it('setzt fuer fehlende Ursachen einen Klartext ein', () => {
    expect(describeJsonBodyError({ type: 'entity.parse.failed' })?.cause).toBe('unbekannte Ursache');
  });
});

describe('AI-P1-005 · sanitizeCause', () => {
  it('macht mehrzeilige Ursachen einzeilig (Stack-Frames werden plattgedrueckt)', () => {
    const out = sanitizeCause('SyntaxError: kaputt\n    at JSON.parse (<anonymous>)\n    at layer');
    expect(out).not.toContain('\n');
    expect(out).toBe('SyntaxError: kaputt at JSON.parse (<anonymous>) at layer');
  });

  it('kuerzt auf MAX_CAUSE_LENGTH und markiert die Kuerzung', () => {
    const out = sanitizeCause('x'.repeat(MAX_CAUSE_LENGTH * 3));
    expect(out.length).toBe(MAX_CAUSE_LENGTH + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('AI-P1-005 · requestIdOf', () => {
  it('liest die Request-ID aus dem Header, sonst "unbekannt"', () => {
    const withId = { getHeader: (name: string) => (name === 'X-Request-Id' ? 'req-abc' : undefined) };
    const withoutId = { getHeader: () => undefined };
    expect(requestIdOf(withId as never)).toBe('req-abc');
    expect(requestIdOf(withoutId as never)).toBe('unbekannt');
  });
});

// V8-Stack-Frames: mehrzeilig-eingerueckt, "at <symbol>(" oder "<anonymous>".
// Bewusst NICHT /at \w/ - body-parser-Text wie "at position 1" ist keine Frame.
const STACK_FRAME_RE = /(\n\s*at\s)|(\s+at\s+[\w$.<>\[\]]+\s*\()|\(<anonymous>\)/;

describe('AI-P1-005 · Middleware im echten Express-Stack', () => {
  let server: Server;
  let baseUrl = '';
  const logged: string[] = [];

  beforeAll(async () => {
    const app = express();
    // Simuliert die reale Request-ID-Middleware aus server.ts (Z. 261).
    app.use((_req, res, next) => {
      res.setHeader('X-Request-Id', 'req-test-1');
      next();
    });
    app.use(express.json({ limit: '1kb' }));
    app.use(createJsonBodyErrorHandler((line) => logged.push(line)));
    app.post('/ok', (_req, res) => res.json({ ok: true }));
    // Fremder Fehler: muss unveraendert weitergereicht werden.
    app.get('/boom', (_req, _res, next) => next(new Error('boom')));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ delegated: true, message: err.message });
    });
    server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('kein Port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('ungueltiges JSON → 400, strukturierte Antwort, genau eine Log-Zeile ohne Stack', async () => {
    logged.length = 0;
    const res = await fetch(`${baseUrl}/ok`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; requestId: string; cause: string };
    expect(body.error).toBe('invalid JSON body');
    expect(body.requestId).toBe('req-test-1');
    expect(typeof body.cause).toBe('string');
    // Der Bug war der Stack-Trace im Log bzw. in der Antwort - beides muss weg sein.
    // (V8-Frames sind mehrzeilig bzw. tragen "at <symbol>(" oder "<anonymous>".)
    expect(JSON.stringify(body)).not.toMatch(STACK_FRAME_RE);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('requestId=req-test-1');
    expect(logged[0]).toContain('invalid JSON body');
    expect(logged[0]).not.toContain('\n');
    expect(logged[0]).not.toMatch(STACK_FRAME_RE);
  });

  it('zu grosser Body → 413', async () => {
    logged.length = 0;
    const res = await fetch(`${baseUrl}/ok`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: 'y'.repeat(4096) }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe('payload too large');
    expect(logged).toHaveLength(1);
  });

  it('gueltiges JSON bleibt unberuehrt', async () => {
    const res = await fetch(`${baseUrl}/ok`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'welt' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('fremde Fehler werden unveraendert an next(err) weitergereicht', async () => {
    const res = await fetch(`${baseUrl}/boom`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ delegated: true, message: 'boom' });
  });
});
