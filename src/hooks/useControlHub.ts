import { useCallback, useEffect, useState } from 'react';
import { controlHub } from '../core/hardware/ControlHub';
import type { ControlHubDeviceState } from '../core/hardware/ControlHub';
import { webMIDIAdapter, hidAdapter, oscAdapter } from '../core/adapters';
import { hotplugManager } from '../core/hardware/HotplugManager';
import type { ControlEvent } from '../core/interfaces';

/**
 * useControlHub – zentrale Control-Schicht für die UI.
 * Registriert die Referenz-Adapter (WebMIDI/HID/OSC) und exponiert
 * Verbindungsstatus + letztes ControlEvent. Kein direkter Low-Level-Zugriff
 * in der Komponente.
 */
export const useControlHub = () => {
  const [status, setStatus] = useState<ControlHubDeviceState[]>(controlHub.listStatus());
  const [lastEvent, setLastEvent] = useState<ControlEvent | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    controlHub.register(webMIDIAdapter);
    controlHub.register(hidAdapter);
    controlHub.register(oscAdapter);
    setStatus(controlHub.listStatus());

    const offEvent = controlHub.onControlEvent((ev) => setLastEvent(ev));
    const refresh = () => setStatus(controlHub.listStatus());
    const offHotplug = hotplugManager.subscribe(() => refresh());
    return () => {
      offEvent();
      offHotplug();
    };
  }, []);

  const connect = useCallback(async (adapterId: string) => {
    setBusy(adapterId);
    try {
      await controlHub.connect(adapterId);
    } finally {
      setStatus(controlHub.listStatus());
      setBusy(null);
    }
  }, []);

  const disconnect = useCallback((adapterId: string) => {
    controlHub.disconnect(adapterId);
    setStatus(controlHub.listStatus());
  }, []);

  return { status, lastEvent, busy, connect, disconnect };
};
