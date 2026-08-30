import { useState, useEffect, useCallback } from 'react';

/**
 * useHID – USB-Interfaces via WebHID (hotplug-fähig)
 * ---------------------------------------------------
 * - getDevices() liefert bereits gekoppelte Geräte
 * - requestDevice() koppelt neue Geräte (Browser-Picker)
 * - connect/disconnect-Events halten die Liste live
 *
 * Hinweis: Audio-Interfaces (Soundkarten) laufen NICHT über WebHID,
 * sondern über enumerateDevices()/setSinkId() – siehe audioDeviceManager.
 */
export const useHID = () => {
  const [devices, setDevices] = useState<HIDDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  const supported = typeof navigator !== 'undefined' && !!navigator.hid;

  const refresh = useCallback(async () => {
    if (!supported || !navigator.hid) {
      setError('WebHID wird von diesem Browser nicht unterstützt.');
      return;
    }
    try {
      setDevices(await navigator.hid.getDevices());
      setError(null);
    } catch (err: any) {
      setError(`WebHID-Zugriff verweigert: ${err?.message || 'Unbekannt'}`);
    }
  }, [supported]);

  useEffect(() => {
    if (!supported || !navigator.hid) return;
    refresh();
    navigator.hid.addEventListener('connect', refresh);
    navigator.hid.addEventListener('disconnect', refresh);
    return () => {
      navigator.hid?.removeEventListener('connect', refresh);
      navigator.hid?.removeEventListener('disconnect', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  /** Öffnet den Browser-Picker zum Koppeln eines USB/HID-Geräts. */
  const requestDevice = useCallback(async () => {
    if (!supported || !navigator.hid) {
      setError('WebHID wird von diesem Browser nicht unterstützt.');
      return [];
    }
    try {
      const newDevices = await navigator.hid.requestDevice({ filters: [] });
      setDevices((prev) => [...prev, ...newDevices]);
      setError(null);
      return newDevices;
    } catch (err: any) {
      // User hat den Picker abgebrochen → kein Fehler-Log nötig.
      if (err?.name !== 'AbortError' && err?.name !== 'NotAllowedError') {
        setError(`USB-Gerät nicht gekoppelt: ${err?.message || 'Unbekannt'}`);
      }
      return [];
    }
  }, [supported]);

  return { devices, error, supported, refresh, requestDevice };
};
