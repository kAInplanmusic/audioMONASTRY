import { useSyncExternalStore } from 'react';
import {
  classifyDevice,
  deviceLayoutKey,
  shouldRequestFullscreen,
  shouldShowInstallHint,
  type DeviceLayout,
  type DeviceSignals,
} from '../core/ui/deviceLayout';
import { storageGet, storageSet } from '../utils/storage';

/**
 * Formate · Browser-Anbindung der Geräteerkennung (src/core/ui/deviceLayout.ts)
 * ============================================================================
 * - liest Viewport, Bildschirm, Pixeldichte, Zeigerart und Home-Bildschirm-Modus,
 * - schreibt das Format als `data-layout`/`data-device`/`data-orientation`/
 *   `data-fullscreen` an <html> (CSS-Varianten in src/index.css) und die echte
 *   sichtbare Höhe als `--app-height` (iOS-100vh-Problem),
 * - fordert in Handy-quer/Pad-quer beim ersten Tippen Vollbild an (Browser
 *   erlauben Vollbild nur aus einer Nutzergeste heraus).
 *
 * Kein Audio-Thread, keine Netzwerkarbeit: nur Ereignisse des Fensters.
 */

interface FullscreenDoc {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
}
interface FullscreenEl {
  requestFullscreen?: (opts?: { navigationUI?: 'hide' | 'show' | 'auto' }) => Promise<void>;
  webkitRequestFullscreen?: () => void;
}

const INSTALL_HINT_KEY = 'am.formats.installHintDismissed';

const hasWindow = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined';

function media(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function readDeviceSignals(): DeviceSignals {
  const vv = window.visualViewport;
  return {
    viewportWidth: window.innerWidth || vv?.width || 0,
    viewportHeight: window.innerHeight || vv?.height || 0,
    screenWidth: window.screen?.width ?? 0,
    screenHeight: window.screen?.height ?? 0,
    devicePixelRatio: window.devicePixelRatio || 1,
    coarsePointer: media('(pointer: coarse)'),
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    platform: navigator.platform ?? '',
    // `display-mode: fullscreen` passt auch während eines Vollbilds per
    // Fullscreen-API – das ist KEINE Home-Bildschirm-App.
    standalone:
      media('(display-mode: standalone)') ||
      (media('(display-mode: fullscreen)') && !fullscreenActive()) ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
  };
}

export function fullscreenSupported(): boolean {
  if (!hasWindow()) return false;
  const d = document as unknown as FullscreenDoc;
  const el = document.documentElement as unknown as FullscreenEl;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled) && !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

export function fullscreenActive(): boolean {
  if (!hasWindow()) return false;
  const d = document as unknown as FullscreenDoc;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

/** Vollbild anfordern (nur aus einer Nutzergeste heraus wirksam). */
export function requestAppFullscreen(): void {
  if (!fullscreenSupported() || fullscreenActive()) return;
  const el = document.documentElement as unknown as FullscreenEl;
  try {
    if (el.requestFullscreen) void el.requestFullscreen({ navigationUI: 'hide' }).catch(() => { /* abgelehnt */ });
    else el.webkitRequestFullscreen?.();
  } catch { /* Browser erlaubt es nicht */ }
}

export function exitAppFullscreen(): void {
  if (!fullscreenActive()) return;
  const d = document as unknown as FullscreenDoc;
  try {
    if (d.exitFullscreen) void d.exitFullscreen().catch(() => undefined);
    else d.webkitExitFullscreen?.();
  } catch { /* ignorieren */ }
}

// ---------------------------------------------------------------- Store

export interface DeviceLayoutState extends DeviceLayout {
  fullscreen: { supported: boolean; active: boolean };
  installHint: boolean;
}

const FALLBACK: DeviceLayoutState = {
  ...classifyDevice({
    viewportWidth: 1440, viewportHeight: 900, screenWidth: 1440, screenHeight: 900, devicePixelRatio: 1,
    coarsePointer: false, maxTouchPoints: 0, platform: '', standalone: false,
  }),
  fullscreen: { supported: false, active: false },
  installHint: false,
};

let snapshot: DeviceLayoutState = FALLBACK;
let snapshotKey = '';
let armed = true;
let lastPreferred = false;
let started = false;
const listeners = new Set<() => void>();

function installHintDismissed(): boolean {
  return storageGet(INSTALL_HINT_KEY) === '1';
}

function compute(): void {
  const base = classifyDevice(readDeviceSignals());
  const supported = fullscreenSupported();
  const active = fullscreenActive();
  // Jeder Wechsel IN ein Vollbild-Format schärft die Anforderung neu.
  if (base.fullscreenPreferred && !lastPreferred) armed = true;
  lastPreferred = base.fullscreenPreferred;
  const next: DeviceLayoutState = {
    ...base,
    fullscreen: { supported, active },
    installHint: shouldShowInstallHint(base, { supported, dismissed: installHintDismissed() }),
  };
  const key = `${deviceLayoutKey(next)}|${supported}|${active}|${next.installHint}`;

  const root = document.documentElement;
  root.dataset.layout = next.layout;
  root.dataset.device = next.device;
  root.dataset.orientation = next.orientation;
  root.dataset.fullscreen = active || next.standalone ? 'true' : 'false';
  root.style.setProperty('--app-height', `${next.resolution.cssHeight}px`);

  if (key === snapshotKey) return;
  snapshotKey = key;
  snapshot = next;
  listeners.forEach((l) => l());
}

function onUserGesture(): void {
  if (shouldRequestFullscreen(snapshot, { supported: snapshot.fullscreen.supported, active: fullscreenActive(), armed })) {
    armed = false;
    requestAppFullscreen();
  }
}

/** Startet die Beobachtung einmalig (idempotent). */
export function startDeviceLayoutWatch(): void {
  if (started || !hasWindow()) return;
  started = true;
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => { frame = 0; compute(); });
  };
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  window.visualViewport?.addEventListener('resize', schedule, { passive: true });
  document.addEventListener('fullscreenchange', schedule);
  document.addEventListener('webkitfullscreenchange', schedule);
  for (const q of ['(pointer: coarse)', '(display-mode: standalone)', '(display-mode: fullscreen)']) {
    try { window.matchMedia(q).addEventListener('change', schedule); } catch { /* alter Browser */ }
  }
  // Capture-Phase: läuft vor dem Klick-Handler des Bedienelements, das Tippen
  // selbst wird nicht verändert.
  window.addEventListener('click', onUserGesture, { capture: true });
  compute();
}

export function dismissInstallHint(): void {
  storageSet(INSTALL_HINT_KEY, '1');
  if (hasWindow()) compute();
}

function subscribe(listener: () => void): () => void {
  startDeviceLayoutWatch();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): DeviceLayoutState => snapshot;
const getServerSnapshot = (): DeviceLayoutState => FALLBACK;

/** Aktuelles Format (Handy quer/hochkant, Pad quer, PC) – reagiert auf Drehen und Größenänderung. */
export function useDeviceLayout(): DeviceLayoutState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
