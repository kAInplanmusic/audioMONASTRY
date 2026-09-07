// Q-3/T-0015: AuditLogger-Tests (vorher 0 % Coverage).
// Deckt: Event-Struktur, Storage-Historie (max. 100 Einträge, FIFO-Slice),
// Fehler-Resilienz (Storage voll/blockiert darf nicht werfen).
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/utils/storage', () => ({
  storageGet: vi.fn(() => null),
  storageSet: vi.fn(() => {}),
  storageRemove: vi.fn(() => {}),
}));

import { logAuditEvent } from '../src/utils/AuditLogger';
import { storageGet, storageSet } from '../src/utils/storage';

const storageGetMock = storageGet as unknown as ReturnType<typeof vi.fn>;
const storageSetMock = storageSet as unknown as ReturnType<typeof vi.fn>;

describe('AuditLogger (Q-3 Coverage-Lücke)', () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    storageGetMock.mockReset().mockReturnValue(null);
    storageSetMock.mockReset();
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('loggt ein strukturiertes Event (userId, action, details, ISO-Timestamp)', async () => {
    await logAuditEvent('user-1', 'PLUGIN_LOCK', { pluginId: 'mixer' });

    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[audit]', 'PLUGIN_LOCK', 'by', 'user-1', { pluginId: 'mixer' });

    const setArg = storageSetMock.mock.calls[0]?.[1] as string;
    const list = JSON.parse(setArg);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      userId: 'user-1',
      action: 'PLUGIN_LOCK',
      details: { pluginId: 'mixer' },
    });
    expect(new Date(list[0].timestamp).toISOString()).toBe(list[0].timestamp);
  });

  it('hängt an bestehende Historie an und schneidet auf 100 Einträge (FIFO-Slice)', async () => {
    const existing = Array.from({ length: 100 }, (_, i) => ({ userId: `u${i}`, action: 'X', details: {}, timestamp: new Date().toISOString() }));
    storageGetMock.mockReturnValue(JSON.stringify(existing));

    await logAuditEvent('user-new', 'RBAC_DENIED', {});

    const setArg = storageSetMock.mock.calls[0]?.[1] as string;
    const list = JSON.parse(setArg);
    expect(list).toHaveLength(100);        // slice(-100) hält Obergrenze
    expect(list[0].userId).toBe('u1');     // ältester (u0) raus
    expect(list[99].userId).toBe('user-new'); // neuester hinten
  });

  it('Storage-Lese-/Schreibfehler brechen das Logging nicht', async () => {
    storageGetMock.mockImplementation(() => { throw new Error('Storage blockiert'); });
    storageSetMock.mockImplementation(() => { throw new Error('Quota voll'); });

    // Beide Fehler werden vom INNEREN try/catch geschluckt (Kommentar:
    // „Storage voll/blockiert – nicht kritisch") – der äußere catch (console.error)
    // wird nur bei echten Programmfehlern erreicht.
    await expect(logAuditEvent('u', 'TEST', {})).resolves.toBeUndefined();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('leere Historie (null) startet eine neue Liste', async () => {
    storageGetMock.mockReturnValue(null);
    await logAuditEvent('u', 'TEST', { a: 1 });
    const list = JSON.parse(storageSetMock.mock.calls[0]?.[1] as string);
    expect(list).toHaveLength(1);
    expect(list[0].details).toEqual({ a: 1 });
  });

  it('ungültiges JSON in der Historie → fängt neu an (inner try/catch)', async () => {
    storageGetMock.mockReturnValue('{definitely-not-json');
    await logAuditEvent('u', 'TEST', {});
    // JSON.parse wirft → inner catch → kein storageSet (Historie verworfen)
    expect(storageSetMock).not.toHaveBeenCalled();
  });
});
