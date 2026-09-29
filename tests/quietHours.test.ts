import { describe, it, expect } from 'vitest';
import {
  createHeldBuffer,
  DEFAULT_QUIET_HOURS,
  isCriticalAlert,
  isQuietHour,
  planDelivery,
  quietHoursFromEnv,
  summarizeHeld,
} from '../server/quietHours';

/**
 * OPS-P2-002 · Ruhe-Modus fuer Alarme
 * ===================================
 * Betreiber-Entscheidung: 22-07 Uhr ruhig, kritische Alarme ausgenommen.
 * Geprueft wird BEIDES: dass in der Nacht zurueckgehalten wird UND dass
 * kritische Alarme die Ruhe durchbrechen - ein Ruhe-Modus, der einen Ausfall
 * verschluckt, waere schlimmer als keiner.
 */
const atUtcHour = (hour: number, minute = 0) => Date.UTC(2026, 8, 23, hour, minute, 0);

describe('OPS-P2-002 · Ruhe-Modus', () => {
  describe('isQuietHour', () => {
    it('greift im Fenster 22-07 (auch ueber Mitternacht)', () => {
      for (const h of [22, 23, 0, 3, 6]) {
        expect(isQuietHour(h, DEFAULT_QUIET_HOURS), `Stunde ${h}`).toBe(true);
      }
    });

    it('greift NICHT ausserhalb', () => {
      for (const h of [7, 8, 12, 18, 21]) {
        expect(isQuietHour(h, DEFAULT_QUIET_HOURS), `Stunde ${h}`).toBe(false);
      }
    });

    it('funktioniert auch fuer ein Fenster ohne Mitternachtsuebergang', () => {
      const cfg = { startHour: 1, endHour: 5, disabled: false };
      expect(isQuietHour(1, cfg)).toBe(true);
      expect(isQuietHour(4, cfg)).toBe(true);
      expect(isQuietHour(5, cfg)).toBe(false);
      expect(isQuietHour(23, cfg)).toBe(false);
    });

    it('Start == Ende bedeutet KEIN Fenster (sonst waere der Modus immer an)', () => {
      const cfg = { startHour: 7, endHour: 7, disabled: false };
      for (const h of [0, 7, 12, 23]) expect(isQuietHour(h, cfg)).toBe(false);
    });

    it('disabled schaltet alles ab', () => {
      expect(isQuietHour(3, { ...DEFAULT_QUIET_HOURS, disabled: true })).toBe(false);
    });
  });

  describe('quietHoursFromEnv', () => {
    it('liefert die Betreiber-Voreinstellung 22-7', () => {
      expect(quietHoursFromEnv({})).toEqual({ startHour: 22, endHour: 7, disabled: false });
    });

    it('liest eine eigene Angabe', () => {
      expect(quietHoursFromEnv({ ALERT_QUIET_HOURS: '23-6' })).toMatchObject({ startHour: 23, endHour: 6 });
      expect(quietHoursFromEnv({ ALERT_QUIET_HOURS: ' 1 - 5 ' })).toMatchObject({ startHour: 1, endHour: 5 });
    });

    it('faellt bei Unsinn auf die Voreinstellung zurueck (kein stiller Ausfall)', () => {
      for (const bad of ['quatsch', '25-3', '7-99', '-', '22-']) {
        expect(quietHoursFromEnv({ ALERT_QUIET_HOURS: bad }), bad).toMatchObject({ startHour: 22, endHour: 7 });
      }
    });

    it('kann abgeschaltet werden', () => {
      expect(quietHoursFromEnv({ ALERT_QUIET_HOURS_OFF: '1' }).disabled).toBe(true);
    });
  });

  describe('isCriticalAlert', () => {
    it('erkennt severity critical/fatal/page', () => {
      for (const s of ['critical', 'CRITICAL', 'fatal', 'page']) {
        expect(isCriticalAlert({ labels: { severity: s } }), s).toBe(true);
      }
    });

    it('erkennt priority als Ersatzfeld', () => {
      expect(isCriticalAlert({ labels: { priority: 'critical' } })).toBe(true);
    });

    it('haelt warning/info NICHT fuer kritisch', () => {
      for (const s of ['warning', 'info', 'notice', '']) {
        expect(isCriticalAlert({ labels: { severity: s } }), `"${s}"`).toBe(false);
      }
      expect(isCriticalAlert({})).toBe(false);
      expect(isCriticalAlert(undefined)).toBe(false);
    });
  });

  describe('planDelivery', () => {
    const alerts = [
      { labels: { severity: 'warning' }, annotations: { summary: 'Warnung' } },
      { labels: { severity: 'critical' }, annotations: { summary: 'Ausfall' } },
      { labels: { severity: 'info' }, annotations: { summary: 'Info' } },
    ];
    const texts = ['Warnung', 'Ausfall', 'Info'];

    it('haelt nachts Unkritisches zurueck und laesst Kritisches durch', () => {
      const plan = planDelivery(alerts, texts, atUtcHour(2), DEFAULT_QUIET_HOURS);
      expect(plan.quiet).toBe(true);
      expect(plan.deliver).toEqual(['Ausfall']);
      expect(plan.hold).toEqual(['Warnung', 'Info']);
    });

    it('liefert tagsueber alles', () => {
      const plan = planDelivery(alerts, texts, atUtcHour(12), DEFAULT_QUIET_HOURS);
      expect(plan.quiet).toBe(false);
      expect(plan.deliver).toEqual(texts);
      expect(plan.hold).toEqual([]);
    });

    it('haelt bei abgeschaltetem Modus nie zurueck', () => {
      const plan = planDelivery(alerts, texts, atUtcHour(3), { ...DEFAULT_QUIET_HOURS, disabled: true });
      expect(plan.deliver).toEqual(texts);
      expect(plan.hold).toEqual([]);
    });

    it('Grenzstunden: 21:59 zustellen, 22:00 zurueckhalten, 07:00 zustellen', () => {
      expect(planDelivery(alerts, texts, atUtcHour(21, 59), DEFAULT_QUIET_HOURS).quiet).toBe(false);
      expect(planDelivery(alerts, texts, atUtcHour(22, 0), DEFAULT_QUIET_HOURS).quiet).toBe(true);
      expect(planDelivery(alerts, texts, atUtcHour(7, 0), DEFAULT_QUIET_HOURS).quiet).toBe(false);
    });
  });

  describe('Puffer', () => {
    it('sammelt und gibt gebuendelt heraus', () => {
      const buf = createHeldBuffer();
      buf.push('A', atUtcHour(22));
      buf.push('B', atUtcHour(23));
      expect(buf.size()).toBe(2);
      const drained = buf.drain();
      expect(drained.map((h) => h.text)).toEqual(['A', 'B']);
      expect(buf.size()).toBe(0);
      expect(buf.drain()).toEqual([]);
    });

    it('zaehlt Verworfene statt sie still zu verlieren', () => {
      const buf = createHeldBuffer(2);
      buf.push('A', 1);
      buf.push('B', 2);
      buf.push('C', 3);
      buf.push('D', 4);
      expect(buf.size()).toBe(2);
      expect(buf.droppedCount()).toBe(2);
    });
  });

  describe('summarizeHeld', () => {
    it('liefert leer fuer nichts', () => {
      expect(summarizeHeld([])).toBe('');
    });

    it('nennt Anzahl und Einzelmeldungen', () => {
      const text = summarizeHeld([
        { text: 'Warnung', heldAtMs: atUtcHour(22) },
        { text: 'Info', heldAtMs: atUtcHour(23) },
      ]);
      expect(text).toContain('2 Alarm(e)');
      expect(text).toContain('- Warnung');
      expect(text).toContain('- Info');
    });

    it('deckelt lange Listen und nennt den Rest', () => {
      const many = Array.from({ length: 15 }, (_, i) => ({ text: `A${i}`, heldAtMs: 0 }));
      const text = summarizeHeld(many, 10);
      expect(text).toContain('- A9');
      expect(text).not.toContain('- A10');
      expect(text).toContain('und 5 weitere');
    });
  });
});
