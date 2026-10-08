import { describe, expect, it } from 'vitest';
import {
  classifyDevice,
  deviceLayoutKey,
  isTouchDevice,
  shouldRequestFullscreen,
  shouldShowInstallHint,
  viewportContentFor,
  DESIGN_WIDTH,
  type DeviceSignals,
} from '../src/core/ui/deviceLayout';

// ---------------------------------------------------------------------------
// Formate (Betreiber 2026-10-06): Handy quer · Handy hochkant (vereinfacht) ·
// Pad quer · PC/Laptop – automatisch aus Gerät, Ausrichtung und Auflösung.
// Geprüft mit echten Geräteauflösungen (CSS-Pixel, Pixeldichte).
// ---------------------------------------------------------------------------

const touch = (w: number, h: number, dpr: number, extra: Partial<DeviceSignals> = {}): DeviceSignals => ({
  viewportWidth: w, viewportHeight: h, screenWidth: w, screenHeight: h, devicePixelRatio: dpr,
  coarsePointer: true, maxTouchPoints: 5, platform: 'iPhone', standalone: false, ...extra,
});
const desk = (w: number, h: number, dpr = 1, extra: Partial<DeviceSignals> = {}): DeviceSignals => ({
  viewportWidth: w, viewportHeight: h, screenWidth: w, screenHeight: h, devicePixelRatio: dpr,
  coarsePointer: false, maxTouchPoints: 0, platform: 'Win32', standalone: false, ...extra,
});

describe('classifyDevice – echte Geräte', () => {
  const cases: [string, DeviceSignals, string][] = [
    ['iPhone 15 hochkant', touch(393, 852, 3), 'phone-portrait'],
    ['iPhone 15 quer', touch(852, 393, 3), 'phone-landscape'],
    ['iPhone SE hochkant', touch(375, 667, 2), 'phone-portrait'],
    ['iPhone 15 Pro Max quer', touch(932, 430, 3), 'phone-landscape'],
    ['Pixel 8 hochkant', touch(412, 915, 2.625, { platform: 'Linux armv8l' }), 'phone-portrait'],
    ['Galaxy S23 quer', touch(780, 360, 3, { platform: 'Linux armv8l' }), 'phone-landscape'],
    ['iPad 10 quer', touch(1180, 820, 2, { platform: 'iPad' }), 'tablet-landscape'],
    ['iPad mini quer', touch(1133, 744, 2, { platform: 'iPad' }), 'tablet-landscape'],
    ['iPad Pro 12.9 quer', touch(1366, 1024, 2, { platform: 'iPad' }), 'tablet-landscape'],
    ['iPad 10 hochkant', touch(820, 1180, 2, { platform: 'iPad' }), 'tablet-portrait'],
    ['Galaxy Tab S9 quer', touch(1280, 800, 2, { platform: 'Linux armv8l' }), 'tablet-landscape'],
    ['MacBook Air', desk(1470, 956, 2, { platform: 'MacIntel' }), 'desktop'],
    ['Laptop 1366', desk(1366, 768), 'desktop'],
    ['PC Full HD', desk(1920, 1080), 'desktop'],
    ['PC 4K mit Skalierung', desk(2560, 1440, 1.5), 'desktop'],
  ];
  for (const [name, signals, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyDevice(signals).layout).toBe(expected);
    });
  }
});

describe('classifyDevice – Sonderfälle', () => {
  it('iPad mit Trackpad (meldet sich als Mac mit Touchpunkten) bleibt Pad', () => {
    const l = classifyDevice(touch(1180, 820, 2, { coarsePointer: false, platform: 'MacIntel' }));
    expect(l.device).toBe('tablet');
    expect(l.layout).toBe('tablet-landscape');
  });

  it('Touch-Laptop mit Maus als Hauptzeiger bleibt PC', () => {
    expect(classifyDevice(desk(1920, 1080, 1, { maxTouchPoints: 10 })).layout).toBe('desktop');
  });

  it('keine Sonderansicht für schmale Fenster: ein schmales PC-Fenster bleibt PC', () => {
    expect(classifyDevice(desk(480, 900)).layout).toBe('desktop');
  });

  it('Drehen ändert nur die Ausrichtung, nicht das Gerät', () => {
    const portrait = classifyDevice(touch(393, 852, 3));
    const landscape = classifyDevice(touch(852, 393, 3, { screenWidth: 393, screenHeight: 852 }));
    expect(portrait.device).toBe('phone');
    expect(landscape.device).toBe('phone');
    expect(landscape.layout).toBe('phone-landscape');
  });

  it('Browserleisten (kleinerer Viewport als Bildschirm) ändern das Format nicht', () => {
    expect(classifyDevice(touch(852, 340, 3, { screenWidth: 852, screenHeight: 393 })).layout).toBe('phone-landscape');
  });

  it('ungültige Werte führen zu PC statt Absturz', () => {
    const l = classifyDevice(desk(Number.NaN, 0, 0));
    expect(l.layout).toBe('desktop');
    expect(l.resolution.dpr).toBe(1);
  });
});

describe('Auflösung und Vollbild', () => {
  it('meldet CSS- und Gerätepixel', () => {
    const l = classifyDevice(touch(852, 393, 3));
    expect(l.resolution).toEqual({ cssWidth: 852, cssHeight: 393, screenWidth: 852, screenHeight: 393, dpr: 3, pixelWidth: 2556, pixelHeight: 1179 });
    expect(l.label).toBe('Handy quer · 852×393 @3x');
  });

  it('Vollbild nur für Handy quer und Pad quer', () => {
    const map = Object.fromEntries(
      [touch(852, 393, 3), touch(393, 852, 3), touch(1180, 820, 2), touch(820, 1180, 2), desk(1440, 900)]
        .map(classifyDevice)
        .map((l) => [l.layout, l.fullscreenPreferred]),
    );
    expect(map).toEqual({
      'phone-landscape': true,
      'phone-portrait': false,
      'tablet-landscape': true,
      'tablet-portrait': false,
      desktop: false,
    });
  });

  it('gleiche Kopie, nur in klein: Handy und Pad zeichnen die Referenzbreite', () => {
    expect(DESIGN_WIDTH).toBe(1440);
    expect(viewportContentFor('phone')).toBe('width=1440, viewport-fit=cover');
    expect(viewportContentFor('tablet')).toBe('width=1440, viewport-fit=cover');
    expect(viewportContentFor('desktop')).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover');
    // Mit der Referenzbreite als Viewport bleibt das Gerät ein Handy (Bildschirm entscheidet).
    const scaled = classifyDevice(touch(1440, 3121, 0.82, { screenWidth: 393, screenHeight: 852 }));
    expect(scaled.device).toBe('phone');
    expect(scaled.layout).toBe('phone-portrait');
  });

  it('fordert Vollbild einmal an – nicht als Home-Bildschirm-App, nicht ohne Browser-Unterstützung', () => {
    const l = classifyDevice(touch(852, 393, 3));
    expect(shouldRequestFullscreen(l, { supported: true, active: false, armed: true })).toBe(true);
    expect(shouldRequestFullscreen(l, { supported: true, active: false, armed: false })).toBe(false);
    expect(shouldRequestFullscreen(l, { supported: true, active: true, armed: true })).toBe(false);
    expect(shouldRequestFullscreen(l, { supported: false, active: false, armed: true })).toBe(false);
    expect(shouldRequestFullscreen({ ...l, standalone: true }, { supported: true, active: false, armed: true })).toBe(false);
    expect(shouldRequestFullscreen(classifyDevice(desk(1440, 900)), { supported: true, active: false, armed: true })).toBe(false);
  });

  it('zeigt den Home-Bildschirm-Hinweis nur, wo Vollbild fehlt (iPhone-Safari)', () => {
    const l = classifyDevice(touch(852, 393, 3));
    expect(shouldShowInstallHint(l, { supported: false, dismissed: false })).toBe(true);
    expect(shouldShowInstallHint(l, { supported: true, dismissed: false })).toBe(false);
    expect(shouldShowInstallHint(l, { supported: false, dismissed: true })).toBe(false);
    expect(shouldShowInstallHint(classifyDevice(touch(393, 852, 3)), { supported: false, dismissed: false })).toBe(false);
  });

  it('Schlüssel ändert sich bei Drehen und Größenänderung', () => {
    const a = deviceLayoutKey(classifyDevice(touch(393, 852, 3)));
    const b = deviceLayoutKey(classifyDevice(touch(852, 393, 3)));
    expect(a).not.toBe(b);
    expect(deviceLayoutKey(classifyDevice(touch(393, 852, 3)))).toBe(a);
  });

  it('erkennt Touch über Zeiger oder iPadOS-Merkmal', () => {
    expect(isTouchDevice({ coarsePointer: true, maxTouchPoints: 0, platform: '' })).toBe(true);
    expect(isTouchDevice({ coarsePointer: false, maxTouchPoints: 5, platform: 'MacIntel' })).toBe(true);
    expect(isTouchDevice({ coarsePointer: false, maxTouchPoints: 0, platform: 'MacIntel' })).toBe(false);
  });
});
