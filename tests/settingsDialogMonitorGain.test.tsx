// @vitest-environment jsdom
/**
 * UI-2026-11-06-003 (c): Der Regler „Monitor-Kopfhörer-Pegel“ wirkt.
 *
 * Vorher: `onChange` schrieb nur `settings.monitorGain` nach localStorage —
 * kein AudioEngine-Aufruf, kein hörbarer Effekt. Außerdem hatten die Labels im
 * Dialog kein `htmlFor`/`id`, der Slider kein `aria-label`/`aria-valuetext`:
 * Screenreader lasen „Schieberegler“ ohne Namen und ohne Prozentwert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { engine } = vi.hoisted(() => ({
  engine: {
    setLocalMonitorGain: vi.fn(),
    getLocalMonitorGain: vi.fn(() => 1),
    getAudioContextConfig: vi.fn(() => ({ active: null, desired: {}, restartRequired: false })),
    applyLatencyProfile: vi.fn(),
    setSpatialSetup: vi.fn(),
    setStereoMode: vi.fn(),
    playV2TestTone: vi.fn(async () => true),
    stopV2TestTone: vi.fn(),
  },
}));

vi.mock('../src/utils/audioEngine', () => ({ audioEngine: engine }));
vi.mock('../src/core/audio/compat/nativeAudioKit', () => ({ context: { rawContext: {} } }));
vi.mock('../src/utils/mediaDevices', () => ({ enumerateMediaDevices: vi.fn(async () => []) }));
vi.mock('../src/core/spatial/roomPlanner', () => ({ isXonarU7: () => false }));
vi.mock('../src/utils/audioDeviceManager', () => ({
  audioDeviceManager: {
    getLatencySnapshot: () => ({ state: 'idle', sampleRate: 48000, baseLatencyMs: 0, outputLatencyMs: 0, roundTripMs: 0 }),
    startMonitoring: vi.fn(), stopMonitoring: vi.fn(), onDeviceChange: () => () => {},
    applyOutput: vi.fn(async () => {}), applyInput: vi.fn(async () => {}),
  },
}));
vi.mock('../src/utils/audioAggregator', () => ({
  aggregationStatus: () => ({
    os: 'linux', crossOriginIsolated: true,
    guide: { title: 'Aggregation', steps: [], command: '' },
  }),
}));
vi.mock('../src/utils/spatialMath', () => ({
  SPATIAL_SETUPS: [{ id: '2.0', label: '2.0 Stereo' }, { id: '2.1', label: '2.1' }],
}));
vi.mock('../src/core/transport/MediasoupTransport', () => ({
  sfuTransport: { connect: vi.fn(async () => {}), disconnect: vi.fn(), connected: false },
}));
vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: { userId: 'me', setSfuMode: vi.fn() } }));
vi.mock('../src/utils/midiAccess', () => ({
  isWebMidiSupported: () => false,
  requestWebMidiAccess: vi.fn(async () => ({ inputs: 0, outputs: 0 })),
}));
vi.mock('../src/components/CloudStatusBadge', () => ({ CloudStatusBadge: () => null }));
vi.mock('../src/components/MIDIControllerTerminal', () => ({ MIDIControllerTerminal: () => null }));

import { SettingsDialog } from '../src/components/SettingsDialog';
import { resetStorageForTests, storageGet, storageSet } from '../src/utils/storage';

const SETTINGS_KEY = 'audiomonastry_audio_settings';

const openDialog = () => render(<SettingsDialog open onClose={() => {}} />);

beforeEach(() => {
  // storage.ts hält Arbeitsspeicher (kein localStorage) – der Test-Reset ist nötig,
  // sonst trägt ein Test seinen gespeicherten Pegel in den nächsten.
  resetStorageForTests();
  engine.setLocalMonitorGain.mockClear();
});

afterEach(() => cleanup());

describe('SettingsDialog · Monitor-Pegel wirkt auf die Engine', () => {
  it('übernimmt den gespeicherten Pegel beim Öffnen (Init-Wert beim Start)', () => {
    storageSet(SETTINGS_KEY, JSON.stringify({ monitorGain: 0.25 }));
    openDialog();
    expect(engine.setLocalMonitorGain).toHaveBeenCalledWith(0.25);
  });

  it('schreibt jede Reglerbewegung in die Engine und persistiert sie', () => {
    openDialog();
    const slider = screen.getByLabelText(/Monitor-Kopfhörer-Pegel/i);
    fireEvent.change(slider, { target: { value: '0.35' } });
    expect(engine.setLocalMonitorGain).toHaveBeenLastCalledWith(0.35);
    expect(JSON.parse(storageGet(SETTINGS_KEY) ?? '{}').monitorGain).toBe(0.35);
    expect(screen.getByText('35%')).toBeTruthy();
  });

  it('nennt dem Screenreader den Prozentwert (aria-valuetext)', () => {
    openDialog();
    const slider = screen.getByLabelText(/Monitor-Kopfhörer-Pegel/i);
    expect(slider.getAttribute('aria-valuetext')).toBe('80 %');
    fireEvent.change(slider, { target: { value: '0.5' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('50 %');
  });
});

describe('SettingsDialog · Labels sind mit den Bedienelementen verbunden', () => {
  it.each([
    [/Ausgabe \(Soundkarte\)/i, 'settings-output-device'],
    [/Eingang \(Mikro\/Line\)/i, 'settings-input-device'],
    [/^Sample-Rate$/i, 'settings-sample-rate'],
    [/Latenz-Profil/i, 'settings-latency-profile'],
    [/Master-Ausgabe-Layout/i, 'settings-master-layout'],
    [/2\.1-Crossover/i, 'settings-stereo-mode'],
    [/Monitor-Kopfhörer-Pegel/i, 'settings-monitor-gain'],
  ])('Label %s zeigt auf genau ein Steuerelement', (label, id) => {
    openDialog();
    const control = screen.getByLabelText(label);
    expect(control.id).toBe(id);
    expect(control.tagName === 'SELECT' || control.tagName === 'INPUT').toBe(true);
  });

  it('Gruppen-Überschriften sind keine verwaisten <label>-Elemente', () => {
    const { container } = openDialog();
    const orphanLabels = [...container.querySelectorAll('label')].filter((l) => {
      const target = l.getAttribute('for');
      return !target || !container.querySelector(`#${target}`);
    });
    expect(orphanLabels.map((l) => l.textContent)).toEqual([]);
  });
});
