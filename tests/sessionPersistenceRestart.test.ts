/**
 * RT-AUDIT-P1-008 · Session-Zustand überlebt Neustarts
 * ====================================================
 * Begründung: docs/audit/AUDIT_2026-10-07_ECHTZEIT.md Abschnitt 1.8.
 * Ohne Redis lag der Zustand (Locks, Plugin-Settings, Studio-Store) nur im RAM –
 * weil auf den Geräten nichts liegen darf, war nach jedem Neustart alles weg.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionRuntime, type RedisLikeClient } from '../server/sessionRuntime';
import { FileSessionPersistence, resolveSessionStateFile } from '../server/fileSessionPersistence';
import { createMemoryKeyValueStore } from '../src/core/persistence/snapshotStore';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-session-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quiet = { log: () => {} };

/** Füllt eine Runtime mit Plugin-Settings, Studio-Store und einem Lock. */
function fill(runtime: ReturnType<typeof createSessionRuntime>): void {
  const s = runtime.session;
  expect(s.acquireLock('eq', 'user-a').ok).toBe(true);
  expect('reason' in s.setPluginSettings('eq', 'user-a', { low: -3, high: 2 })).toBe(false);
  expect(s.storeSet('audiomonastry_capture_patterns', '[{"id":"p1"}]', 'user-a').ok).toBe(true);
}

describe('RT-AUDIT-P1-008 · Datei-Persistenz', () => {
  it('Neustart mit derselben Datei: Plugin-Settings, Studio-Store und Revision identisch', async () => {
    const file = path.join(tempDir(), 'state', 'session-state.json');
    const first = createSessionRuntime(quiet);
    await first.restoreFromPersistence(new FileSessionPersistence(file));
    fill(first);
    await first.flush();
    const before = first.session.serialize();

    const second = createSessionRuntime(quiet);
    const { restored } = await second.restoreFromPersistence(new FileSessionPersistence(file));
    expect(restored).toBe(true);
    expect(second.session.serialize()).toEqual(before);
    expect(second.session.getPluginSettings('eq')?.settings).toEqual({ low: -3, high: 2 });
    first.stop(); second.stop();
  });

  it('entprellter persist() schreibt nach ~250 ms auch ohne flush', async () => {
    const file = path.join(tempDir(), 'session-state.json');
    const runtime = createSessionRuntime(quiet);
    await runtime.restoreFromPersistence(new FileSessionPersistence(file));
    fill(runtime);
    runtime.persist();
    await new Promise((r) => setTimeout(r, 400));
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.revision).toBe(runtime.session.serialize().revision);
    runtime.stop();
  });

  it('schreibt atomar: keine Temp-Datei bleibt liegen, auch bei vielen schnellen Saves', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'session-state.json');
    const p = new FileSessionPersistence(file);
    const runtime = createSessionRuntime(quiet);
    fill(runtime);
    await Promise.all(Array.from({ length: 20 }, () => p.save(runtime.session.serialize())));
    expect(readdirSync(dir)).toEqual(['session-state.json']);
    expect(JSON.parse(readFileSync(file, 'utf8')).revision).toBe(runtime.session.serialize().revision);
    runtime.stop();
  });

  it('fehlende Datei = frischer Zustand; beschädigte Datei wird beiseitegelegt, Start läuft weiter', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'session-state.json');
    const warnings: string[] = [];
    expect(await new FileSessionPersistence(file).load()).toBeNull();

    writeFileSync(file, '{kaputt');
    const runtime = createSessionRuntime(quiet);
    const { restored } = await runtime.restoreFromPersistence(new FileSessionPersistence(file, (m) => warnings.push(m)));
    expect(restored).toBe(false);
    expect(warnings.join(' ')).toMatch(/beschaedigt/);
    expect(readdirSync(dir).some((f) => f.startsWith('session-state.json.corrupt-'))).toBe(true);
    runtime.stop();
  });

  it('Pfadauflösung: Test-Umgebung aus, "off" aus, ausdrücklicher Pfad gewinnt, Produktion mit Default', () => {
    expect(resolveSessionStateFile({ NODE_ENV: 'test' })).toBeNull();
    expect(resolveSessionStateFile({ SESSION_STATE_FILE: 'off', NODE_ENV: 'production' })).toBeNull();
    expect(resolveSessionStateFile({ SESSION_STATE_FILE: '/x/y.json', NODE_ENV: 'test' })).toBe(path.resolve('/x/y.json'));
    expect(resolveSessionStateFile({ NODE_ENV: 'production' })).toBe(path.resolve('data/state/session-state.json'));
  });
});

describe('RT-AUDIT-P1-008 · Redis-Pfad (Fake-Client)', () => {
  it('Neustart über denselben Redis-Speicher stellt Settings + Store wieder her', async () => {
    const kv = new Map<string, string>();
    const client: RedisLikeClient = {
      get: async (k) => kv.get(k) ?? null,
      set: async (k, v) => { kv.set(k, v); return 'OK'; },
    };
    const first = createSessionRuntime(quiet);
    await first.restoreFromRedis(client, createMemoryKeyValueStore());
    fill(first);
    await first.flush();

    const second = createSessionRuntime(quiet);
    const { restored } = await second.restoreFromRedis(client, createMemoryKeyValueStore());
    expect(restored).toBe(true);
    expect(second.session.serialize()).toEqual(first.session.serialize());
    first.stop(); second.stop();
  });
});

describe('RT-AUDIT-P1-008 · Betriebskonfiguration', () => {
  const compose = readFileSync(path.resolve(__dirname, '../docker-compose.hetzner.yml'), 'utf8');
  const redisBlock = compose.split('\n  redis:\n')[1]?.split('\n\n')[0] ?? '';

  it('Redis ist ein Standard-Dienst (kein Profil) mit AOF', () => {
    expect(redisBlock).not.toMatch(/profiles:/);
    expect(redisBlock).toMatch(/--appendonly yes/);
  });

  it('Redis verdrängt nur Schlüssel mit TTL (volatile-lru), nie den Session-Zustand', () => {
    expect(redisBlock).toMatch(/--maxmemory-policy volatile-lru/);
    expect(compose).not.toMatch(/--maxmemory-policy allkeys-lru/);
  });

  it('die App bekommt REDIS_URL per Default und wartet auf einen gesunden Redis', () => {
    expect(compose).toMatch(/REDIS_URL: \$\{REDIS_URL:-redis:\/\/redis:6379\}/);
    expect(compose).toMatch(/depends_on:\s*\n\s*redis:\s*\n\s*condition: service_healthy/);
  });
});
