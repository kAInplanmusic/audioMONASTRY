import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MJPEG_TICKET_TTL_MS,
  MAX_MJPEG_TICKET_TTL_MS,
  MAX_MJPEG_TICKETS,
  MjpegTicketStore,
} from '../server/mjpegTicket';

/**
 * AUDIT-2026-10-30-P1-006 · Einmal-Ticket statt Master-Token in der URL
 * =====================================================================
 * Der Beamer liest den MJPEG-Strom mit einem `<img>` und kann deshalb keine
 * Header setzen. Bisher stand deshalb der MASTER-Token in der Stream-URL - und
 * damit in Access-Logs, Referrern und der Browser-History. Diese Datei prueft
 * die Ersatz-Eigenschaft: ein kurzlebiges, EINMAL verwendbares, an Session/IP
 * gebundenes Ticket.
 *
 * Bewusst gegen den reinen Store getestet (ohne HTTP): TTL, Einmalverwendung
 * und Bindung sind Politik, nicht Transport.
 */

describe('AUDIT-2026-10-30-P1-006 · MJPEG-Ticket-Store', () => {
  it('gibt ein undurchsichtiges Ticket mit kleiner TTL aus', () => {
    const store = new MjpegTicketStore({ now: () => 1_000_000, ttlMs: 5_000 });
    const issued = store.issue({ ip: '10.0.0.1' });

    // 32 Zufallsbytes base64url -> 43 Zeichen; kein Master-Token, kein Muster.
    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(issued.ttlMs).toBe(5_000);
    expect(issued.expiresAt).toBe(1_005_000);
    expect(store.issue({ ip: '10.0.0.1' }).ticket).not.toBe(issued.ticket);
  });

  it('begrenzt die TTL hart nach oben (kein Dauer-Ticket per Env)', () => {
    const store = new MjpegTicketStore({ ttlMs: 60 * 60_000 });
    expect(store.ttlMs).toBe(MAX_MJPEG_TICKET_TTL_MS);
    expect(store.ttlMs).toBeLessThanOrEqual(60_000);
    // Vorgabe bleibt klein genug fuer einen Verbindungsaufbau, nicht fuer Betrieb.
    expect(DEFAULT_MJPEG_TICKET_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it('ist genau einmal verwendbar', () => {
    const store = new MjpegTicketStore();
    const ticket = store.issue({ ip: '10.0.0.1' }).ticket;

    expect(store.redeem(ticket, { ip: '10.0.0.1' })).toBe('ok');
    // Zweiter Zugriff mit demselben Ticket: abgelehnt, und zwar als Wiederverwendung.
    expect(store.redeem(ticket, { ip: '10.0.0.1' })).toBe('used');
  });

  it('lehnt abgelaufene Tickets ab', () => {
    let now = 1_000;
    const store = new MjpegTicketStore({ now: () => now, ttlMs: 2_000 });
    const ticket = store.issue({ ip: '10.0.0.1' }).ticket;

    now = 2_999;
    expect(store.redeem(ticket, { ip: '10.0.0.1' })).toBe('ok');

    const expired = store.issue({ ip: '10.0.0.1' }).ticket;
    now = 5_000;
    expect(store.redeem(expired, { ip: '10.0.0.1' })).toBe('expired');
  });

  it('bindet an Session (sonst IP) und verbraucht bei falschem Subject nichts', () => {
    const store = new MjpegTicketStore();

    const sessionTicket = store.issue({ sessionId: 'user-a', ip: '10.0.0.1' }).ticket;
    // Falsche Session: abgelehnt, aber NICHT verbraucht ...
    expect(store.redeem(sessionTicket, { sessionId: 'user-b', ip: '10.0.0.1' })).toBe('subject-mismatch');
    // ... die richtige Session kommt danach noch durch (kein DoS durch Fremdzugriff).
    expect(store.redeem(sessionTicket, { sessionId: 'user-a', ip: '10.9.9.9' })).toBe('ok');

    const ipTicket = store.issue({ ip: '10.0.0.1' }).ticket;
    expect(store.redeem(ipTicket, { ip: '10.0.0.2' })).toBe('subject-mismatch');
    expect(store.redeem(ipTicket, { ip: '10.0.0.1' })).toBe('ok');

    // Eine Session-Bindung laesst sich nicht durch Weglassen der Session knaeckten.
    const again = store.issue({ sessionId: 'user-a', ip: '10.0.0.1' }).ticket;
    expect(store.redeem(again, { ip: '10.0.0.1' })).toBe('subject-mismatch');
  });

  it('lehnt fremde, leere und ueberlange Tickets ab', () => {
    const store = new MjpegTicketStore();
    expect(store.redeem('', { ip: '10.0.0.1' })).toBe('unknown');
    expect(store.redeem('falsch', { ip: '10.0.0.1' })).toBe('unknown');
    expect(store.redeem('x'.repeat(4096), { ip: '10.0.0.1' })).toBe('unknown');
    expect(store.redeem(undefined, { ip: '10.0.0.1' })).toBe('unknown');
  });

  it('bleibt im Speicher begrenzt (kein unbegrenztes Wachstum)', () => {
    let now = 0;
    const store = new MjpegTicketStore({ now: () => now, ttlMs: 1_000 });
    for (let i = 0; i < MAX_MJPEG_TICKETS * 2; i += 1) {
      now += 1;
      store.issue({ ip: `10.0.0.${i % 250}` });
    }
    expect(store.size).toBeLessThanOrEqual(MAX_MJPEG_TICKETS);
  });
});
