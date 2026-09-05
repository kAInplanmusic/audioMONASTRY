import { useState, useEffect, useCallback, useRef } from 'react';
import { hotplugManager } from '../core/hardware/HotplugManager';
import { hardwareDiagnostics } from '../core/hardware/diagnostics';
import { deviceProfileStore } from '../core/hardware/deviceProfile';

/**
 * useHID – USB-Interfaces via WebHID (hotplug-fähig)
 * ---------------------------------------------------
 * - getDevices() liefert bereits gekoppelte Geräte
 * - requestDevice() koppelt neue Geräte (Browser-Picker)
 * - connect/disconnect-Events halten die Liste live
 * - HotplugManager + HardwareDiagnostics angebunden
 * - Device-Profile-Touch mit VID/PID-Fingerprint
 *
 * Hinweis: Audio-Interfaces (Soundkarten) laufen NICHT über WebHID,
 * sondern über enumerateDevices()/setSinkId() – siehe audioDeviceManager.
 */
export const useHID = () => {
  const [devices, setDevices] = useState<HIDDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  const supported = typeof navigator !== 'undefined' && !!navigator.hid;

  const knownIds = useRef(new Set<string>());

  const touchDevices = useCallback((list: HIDDevice[]) => {
    const current = new Set<string>();
    for (const d of list) {
      const id = `hid:${d.vendorId?.toString(16) ?? '0000'}:${d.productId?.toString(16) ?? '0000'}`;
      current.add(id);
      hotplugManager.attach(id, d.productName ?? 'USB-HID-Gerät');
      hardwareDiagnostics.log('CONNECT', d.productName ?? id, {
        backend: 'webhid',
        vid: d.vendorId?.toString(16),
        pid: d.productId?.toString(16),
      });
      // Device-Profile-Touch mit VID/PID (fire-and-forget).
      const fp = { vid: d.vendorId, pid: d.productId, product: d.productName ?? undefined };
      void deviceProfileStore.find(fp).then(async (existing) => {
        if (existing) {
          existing.lastSeenAt = Date.now();
          await deviceProfileStore.save(existing);
        }
      }).catch(() => { /* Profil-Persistenz optional */ });
    }
    for (const id of [...knownIds.current]) {
      if (!current.has(id)) {
        hotplugManager.detach(id);
        hardwareDiagnostics.log('DISCONNECT', id, { backend: 'webhid' });
      }
    }
    knownIds.current = current;
  }, []);

  const refresh = useCallback(async () => {
    if (!supported || !navigator.hid) {
      setError('WebHID wird von diesem Browser nicht unterstützt.');
      return;
    }
    try {
      const list = await navigator.hid.getDevices();
      setDevices(list);
      setError(null);
      touchDevices(list);
    } catch (err: any) {
      setError(`WebHID-Zugriff verweigert: ${err?.message || 'Unbekannt'}`);
    }
  }, [supported, touchDevices]);

  useEffect(() => {
    if (!supported || !navigator.hid) return;
    // Refresh asynchron starten: keine synchronen setState-Aufrufe im Effect-Body.
    void (async () => {
      await Promise.resolve();
      await refresh();
    })();
    navigator.hid.addEventListener('connect', refresh);
    navigator.hid.addEventListener('disconnect', refresh);
    return () => {
      navigator.hid?.removeEventListener('connect', refresh);
      navigator.hid?.removeEventListener('disconnect', refresh);
    };
  }, [supported, refresh]);

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
      touchDevices(newDevices);
      return newDevices;
    } catch (err: any) {
      // User hat den Picker abgebrochen → kein Fehler-Log nötig.
      if (err?.name !== 'AbortError' && err?.name !== 'NotAllowedError') {
        setError(`USB-Gerät nicht gekoppelt: ${err?.message || 'Unbekannt'}`);
      }
      return [];
    }
  }, [supported, touchDevices]);

  return { devices, error, supported, refresh, requestDevice };
};
