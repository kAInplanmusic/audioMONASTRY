/**
 * Formate · Geräte- und Auflösungserkennung (Betreiber 2026-10-06)
 * ================================================================
 * Betreiber 2026-10-06: „Jedes Gerät gleiche Kopie, nur in klein." Alle Geräte
 * zeigen DIESELBE Oberfläche. Handy und Pad zeichnen sie in der Referenzbreite
 * (DESIGN_WIDTH) und der Browser verkleinert sie auf den Bildschirm – über die
 * Viewport-Angabe, Zoomen mit zwei Fingern bleibt möglich. Erkannt wird nur noch:
 *
 *   phone-landscape / tablet-landscape → Vollbild beim ersten Tippen
 *   phone-portrait / tablet-portrait   → gleiche Kopie, ohne Vollbild
 *   desktop                             → Browserfenster, normale Breite
 *
 * Rein (kein Zugriff auf window/document) – die Browser-Signale liefert
 * `src/hooks/useDeviceLayout.ts`. Dadurch ist die Einordnung mit echten
 * Geräteauflösungen testbar (tests/deviceLayout.test.ts).
 */

export type DeviceKind = 'phone' | 'tablet' | 'desktop';
export type LayoutKind = 'phone-landscape' | 'phone-portrait' | 'tablet-landscape' | 'tablet-portrait' | 'desktop';
export type Orientation = 'landscape' | 'portrait';

export interface DeviceSignals {
  /** Sichtbare Fläche in CSS-Pixeln (innerWidth/innerHeight). */
  viewportWidth: number;
  viewportHeight: number;
  /** Bildschirm in CSS-Pixeln (screen.width/height) – unabhängig von Browserleisten. */
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  /** `(pointer: coarse)` – Hauptzeiger ist ein Finger. */
  coarsePointer: boolean;
  /** navigator.maxTouchPoints */
  maxTouchPoints: number;
  /** navigator.platform (iPadOS meldet sich als „MacIntel"). */
  platform: string;
  /** Als Home-Bildschirm-App gestartet (display-mode: standalone/fullscreen). */
  standalone: boolean;
}

export interface DeviceLayout {
  layout: LayoutKind;
  device: DeviceKind;
  orientation: Orientation;
  /** Format will Vollbild (Handy quer, Pad quer). */
  fullscreenPreferred: boolean;
  standalone: boolean;
  /**
   * cssWidth/cssHeight: gezeichnete Fläche (bei Handy/Pad die Referenzbreite);
   * screenWidth/screenHeight: echter Bildschirm in CSS-Pixeln, zur Ausrichtung
   * gedreht; pixelWidth/pixelHeight: echter Bildschirm in Gerätepixeln.
   */
  resolution: { cssWidth: number; cssHeight: number; screenWidth: number; screenHeight: number; dpr: number; pixelWidth: number; pixelHeight: number };
  /** Kurztext für Anzeige/Diagnose, z. B. „Handy quer · 852×393 @3x". */
  label: string;
}

/** Kürzere Bildschirmseite, ab der ein Touch-Gerät als Pad gilt (CSS-Pixel). */
export const TABLET_MIN_SHORT_SIDE = 600;
/** Referenzbreite der Oberfläche: Handy und Pad zeigen genau diese Kopie, verkleinert. */
export const DESIGN_WIDTH = 1440;

const LABELS: Record<LayoutKind, string> = {
  'phone-landscape': 'Handy quer',
  'phone-portrait': 'Handy hochkant',
  'tablet-landscape': 'Pad quer',
  'tablet-portrait': 'Pad hochkant',
  desktop: 'PC/Laptop',
};

const pos = (v: number, fallback = 0): number => (Number.isFinite(v) && v > 0 ? v : fallback);

/** Touch-Gerät: Finger als Hauptzeiger, oder iPad mit Trackpad (meldet sich als Mac mit Touchpunkten). */
export function isTouchDevice(s: Pick<DeviceSignals, 'coarsePointer' | 'maxTouchPoints' | 'platform'>): boolean {
  if (s.coarsePointer) return true;
  return s.maxTouchPoints > 1 && /mac/i.test(s.platform ?? '');
}

export function classifyDevice(s: DeviceSignals): DeviceLayout {
  const vw = pos(s.viewportWidth, 1);
  const vh = pos(s.viewportHeight, 1);
  const sw = pos(s.screenWidth, vw);
  const sh = pos(s.screenHeight, vh);
  const dpr = pos(s.devicePixelRatio, 1);
  const orientation: Orientation = vw >= vh ? 'landscape' : 'portrait';
  const shortSide = Math.min(sw, sh);

  const device: DeviceKind = !isTouchDevice(s) ? 'desktop' : shortSide < TABLET_MIN_SHORT_SIDE ? 'phone' : 'tablet';

  const layout: LayoutKind =
    device === 'desktop' ? 'desktop' : (`${device}-${orientation}` as LayoutKind);

  const fullscreenPreferred = layout === 'phone-landscape' || layout === 'tablet-landscape';
  // iOS dreht screen.width/height nicht mit – an die Ausrichtung anpassen.
  const screenLong = Math.max(sw, sh);
  const screenShort = Math.min(sw, sh);
  const screenWidth = orientation === 'landscape' ? screenLong : screenShort;
  const screenHeight = orientation === 'landscape' ? screenShort : screenLong;
  const resolution = {
    cssWidth: Math.round(vw),
    cssHeight: Math.round(vh),
    screenWidth: Math.round(screenWidth),
    screenHeight: Math.round(screenHeight),
    dpr: Math.round(dpr * 100) / 100,
    pixelWidth: Math.round(screenWidth * dpr),
    pixelHeight: Math.round(screenHeight * dpr),
  };
  return {
    layout,
    device,
    orientation,
    fullscreenPreferred,
    standalone: !!s.standalone,
    resolution,
    label: `${LABELS[layout]} · ${resolution.screenWidth}×${resolution.screenHeight} @${resolution.dpr}x`,
  };
}

/**
 * Viewport-Angabe je Gerät: Handy und Pad bekommen die Referenzbreite (der
 * Browser verkleinert die gleiche Kopie auf den Bildschirm), der PC seine
 * eigene Fensterbreite.
 */
export function viewportContentFor(device: DeviceKind): string {
  return device === 'desktop'
    ? 'width=device-width, initial-scale=1.0, viewport-fit=cover'
    : `width=${DESIGN_WIDTH}, viewport-fit=cover`;
}

/** Stabiler Schlüssel: gleiche Einordnung + Auflösung = gleicher Schlüssel (für Snapshots). */
export function deviceLayoutKey(l: DeviceLayout): string {
  return `${l.layout}|${l.resolution.cssWidth}x${l.resolution.cssHeight}@${l.resolution.dpr}|${l.standalone ? 's' : 'b'}`;
}

/**
 * Vollbild beim nächsten Tippen anfordern? Nur in Vollbild-Formaten, nur wenn
 * der Browser es kann, nicht schon im Vollbild/als Home-Bildschirm-App, und nur
 * einmal pro Wechsel in ein Vollbild-Format (wer es verlässt, wird nicht bedrängt).
 */
export function shouldRequestFullscreen(
  l: Pick<DeviceLayout, 'fullscreenPreferred' | 'standalone'>,
  state: { supported: boolean; active: boolean; armed: boolean },
): boolean {
  return l.fullscreenPreferred && !l.standalone && state.supported && !state.active && state.armed;
}

/**
 * Hinweis „Teilen → Zum Home-Bildschirm" zeigen? Für Vollbild-Formate, in denen
 * der Browser kein Vollbild für Seiten erlaubt (iPhone-Safari).
 */
export function shouldShowInstallHint(
  l: Pick<DeviceLayout, 'fullscreenPreferred' | 'standalone'>,
  state: { supported: boolean; dismissed: boolean },
): boolean {
  return l.fullscreenPreferred && !l.standalone && !state.supported && !state.dismissed;
}
