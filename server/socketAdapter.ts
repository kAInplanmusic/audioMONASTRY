/**
 * audioMONASTRY · Socket.IO-Redis-Adapter (AUDIT-2026-10-30 P1-008)
 * =================================================================
 * Ohne Adapter lebt die Raumliste im Prozess: zwei App-Instanzen hinter dem
 * Loadbalancer sehen verschiedene Raeume, `socket.to(room)` erreicht nur die
 * eigenen Clients. Der Adapter legt die Raum-/Broadcast-Ebene auf Redis (Pub/Sub).
 *
 * Vertrag dieses Helfers:
 *   * KEIN `REDIS_URL` -> nichts tun, `active: false`, keine Verbindung, kein Log
 *     (Single-Instance ist der Default und bleibt unveraendert).
 *   * `REDIS_URL` mit falschem Schema -> warnen, Memory-Adapter bleibt.
 *   * Verbindung/Ping scheitern -> warnen, Memory-Adapter bleibt, Teil-Clients
 *     werden sauber geschlossen (kein halb aufgebauter Adapter).
 *   * `close()` schliesst Adapter und Clients - fuer Shutdown und Tests.
 */
import { normalizeRedisUrl, type LockRedisClient } from './lockStore';

export interface SocketAdapterOptions {
  redisUrl?: string;
  log?: (message: string) => void;
  warn?: (message: string, error?: unknown) => void;
  /** Test-Haken: Client-Fabrik statt `redis.createClient`. */
  createClient?: (url: string) => any;
  /** Test-Haken: Adapter-Fabrik statt `@socket.io/redis-adapter`. */
  createAdapter?: (pubClient: any, subClient: any) => any;
}

export interface SocketAdapterHandle {
  active: boolean;
  /** Warum kein Adapter aktiv ist (Diagnose/Ops). */
  reason?: 'no-redis' | 'invalid-url' | 'connect-failed';
  /** Verbindung fuer Session-Persistenz/Snapshots (nur wenn aktiv). */
  client?: LockRedisClient;
  close(): Promise<void>;
}

const noop = async (): Promise<void> => {};

/**
 * Schliesst einen Redis-Client, egal in welchem Zustand er ist. Fehler sind
 * hier erwartbar (doppeltes `quit` nach `adapter.close()`), sie duerfen den
 * Shutdown aber nicht aufhalten.
 */
async function closeClient(client: any, warn: (message: string, error?: unknown) => void): Promise<void> {
  if (!client) return;
  try {
    if (typeof client.isOpen === 'boolean' && !client.isOpen) return;
    if (typeof client.quit === 'function') {
      await client.quit();
      return;
    }
  } catch (error) {
    warn('[signaling] Redis-Client beim Schliessen:', error instanceof Error ? error.message : error);
  }
  try { client.disconnect?.(); } catch { /* best effort */ }
}

export async function attachRedisSocketAdapter(io: any, options: SocketAdapterOptions = {}): Promise<SocketAdapterHandle> {
  const log = options.log ?? ((message: string) => console.log(message));
  const warn = options.warn ?? ((message: string, error?: unknown) => console.warn(message, error ?? ''));
  const rawUrl = typeof options.redisUrl === 'string' ? options.redisUrl.trim() : '';

  if (!rawUrl) return { active: false, reason: 'no-redis', close: noop };

  const url = normalizeRedisUrl(rawUrl);
  if (!url) {
    warn('[signaling] REDIS_URL ungueltig (Schema) – In-Memory-Adapter aktiv.');
    return { active: false, reason: 'invalid-url', close: noop };
  }

  let pubClient: any = null;
  let subClient: any = null;
  let adapter: any = null;
  try {
    const createClient = options.createClient ?? (async (clientUrl: string) => {
      // Lazy, damit ohne REDIS_URL kein Redis-Modul geladen wird.
      const mod = (await import('redis')) as any;
      return mod.createClient({ url: clientUrl });
    });
    const adapterFactory: any = options.createAdapter
      ?? (await import('@socket.io/redis-adapter')).createAdapter;

    pubClient = await createClient(url);
    subClient = pubClient.duplicate();
    pubClient.on?.('error', (error: unknown) => warn('[signaling] Redis-Pub-Client:', error instanceof Error ? error.message : error));
    subClient.on?.('error', (error: unknown) => warn('[signaling] Redis-Sub-Client:', error instanceof Error ? error.message : error));
    await Promise.all([pubClient.connect(), subClient.connect()]);
    adapter = adapterFactory(pubClient, subClient);
    io.adapter(adapter);
    log('[signaling] Redis-Adapter aktiv – Socket.IO-Raeume gelten instanzuebergreifend.');
    return {
      active: true,
      client: pubClient as LockRedisClient,
      async close() {
        try { await adapter.close?.(); } catch (error) {
          warn('[signaling] Redis-Adapter schliessen:', error instanceof Error ? error.message : error);
        }
        await closeClient(subClient, warn);
        await closeClient(pubClient, warn);
      },
    };
  } catch (error) {
    warn('[signaling] Redis-Adapter nicht aktiv – Socket.IO bleibt prozesslokal:', error instanceof Error ? error.message : error);
    await closeClient(subClient, warn);
    await closeClient(pubClient, warn);
    return { active: false, reason: 'connect-failed', close: noop };
  }
}
