/**
 * audioMONASTRY · MediaDevices-Adapter (Plattform-Kapsel)
 * ========================================================
 * Kapselt getUserMedia/enumerateDevices. Alle Komponenten (Recorder, Voice,
 * Settings) laufen über diesen Adapter – kein direkter navigator-Zugriff in
 * den Kernmodulen (Interface-Boundary-Regel 1.1).
 */
export function isSecureContext(): boolean {
  return typeof window !== 'undefined' && !!window.isSecureContext;
}

export async function requestUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia wird von diesem Browser nicht unterstützt.');
  }
  return globalThis.navigator.mediaDevices.getUserMedia(constraints);
}

export async function enumerateMediaDevices(): Promise<MediaDeviceInfo[]> {
  if (!globalThis.navigator?.mediaDevices?.enumerateDevices) return [];
  try {
    return await globalThis.navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
}
