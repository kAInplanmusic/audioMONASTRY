/**
 * TURN-Konfigurationen: Produktions-Härtung und Beweis-Konfiguration
 * =====================================================================
 * Beim Live-Beweis (COLLAB-P0-003) fiel auf, dass der lokale Relay nur mit
 * erlaubten Loopback-Peers funktioniert - die Produktionsvorlage verbietet sie
 * bewusst. Damit niemand die Produktionskonfiguration "passend" aufweicht (oder
 * die Beweis-Konfiguration versehentlich ausrollt), hält dieser Test beide
 * auseinander.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const prod = readFileSync('services/turn/turnserver.conf', 'utf8');
const proof = readFileSync('services/turn/turnserver.local-proof.conf', 'utf8');

describe('TURN-Konfigurationen', () => {
  it('nutzt in beiden das coturn-REST-Verfahren', () => {
    for (const conf of [prod, proof]) {
      expect(conf).toContain('use-auth-secret');
      expect(conf).toContain('static-auth-secret=');
      expect(conf).toContain('fingerprint');
    }
  });

  it('haelt die Produktionsvorlage gehaertet (keine Loopback-/Privat-Peers)', () => {
    expect(prod).toContain('no-loopback-peers');
    expect(prod).toContain('denied-peer-ip=10.0.0.0-10.255.255.255');
    expect(prod).toContain('denied-peer-ip=127.0.0.0-127.255.255.255');
    expect(prod).not.toContain('allow-loopback-peers');
    // Das Secret wird nicht eingecheckt - nur ein Platzhalter fuer deploy-turn.sh.
    expect(prod).toContain('static-auth-secret=__TURN_STATIC_AUTH_SECRET__');
  });

  it('erlaubt Loopback-Peers nur in der Beweis-Konfiguration', () => {
    expect(proof).toContain('allow-loopback-peers');
    expect(proof.toUpperCase()).toContain('NICHT FUER DEN PRODUKTIVBETRIEB');
    expect(proof).not.toContain('__TURN_STATIC_AUTH_SECRET__');
  });
});
