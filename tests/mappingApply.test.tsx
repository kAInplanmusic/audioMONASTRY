// @vitest-environment jsdom
/**
 * MIDI-P2-001: Tests für die bisher ungetestete Mapping-Anwendung
 * (`useMappingApply.applyMappedParameter`) und den Learn-Hook (`useMapping`).
 *
 * Der Dispatcher ist die einzige Stelle, die abstrakte Mapping-Targets
 * (`mixer.channel3.volume`) in echte Engine-Aufrufe übersetzt — Fehler dort
 * wirken sich direkt auf den hörbaren Pfad aus, deshalb wird hier jeder
 * unterstützte Zielpfad und die Wert-Klemmung geprüft. Die Audio-Engine wird
 * dafür gemockt (kein AudioContext im Test).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { ControlEvent } from '../src/core/interfaces';

const setChannelGain = vi.fn();
const setChannelPan = vi.fn();
const setMasterVolume = vi.fn();
const setWorkletParam = vi.fn();

vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: {
    setChannelGain: (track: string, v: number) => setChannelGain(track, v),
    setChannelPan: (track: string, v: number) => setChannelPan(track, v),
    setMasterVolume: (v: number) => setMasterVolume(v),
    setWorkletParam: (param: string, v: number) => setWorkletParam(param, v),
  },
}));

const { applyMappedParameter, SUPPORTED_MAPPING_TARGETS } = await import('../src/hooks/useMappingApply');
const { useMapping } = await import('../src/hooks/useMapping');
const { mappingStore } = await import('../src/core/mapping/MappingStore');

const ccEvent = (parameter = 21, value = 100): ControlEvent => ({
  sourceDevice: 'port-1',
  sourceProtocol: 'midi',
  channel: 1,
  parameter,
  value,
  resolution: 127,
  messageType: 'cc',
  timestamp: 0,
});

beforeEach(() => {
  setChannelGain.mockClear();
  setChannelPan.mockClear();
  setMasterVolume.mockClear();
  setWorkletParam.mockClear();
  mappingStore.engineRef.clear();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('Mapping-Anwendung (Dispatcher)', () => {
  it('setzt Kanal-Lautstärke und klemmt Werte auf 0..1', () => {
    expect(applyMappedParameter('mixer.channel3.volume', 0.4)).toBe(true);
    expect(setChannelGain).toHaveBeenCalledWith('channel3', 0.4);

    applyMappedParameter('mixer.channel1.volume', 5);
    expect(setChannelGain).toHaveBeenLastCalledWith('channel1', 1);
    applyMappedParameter('mixer.channel1.volume', -3);
    expect(setChannelGain).toHaveBeenLastCalledWith('channel1', 0);
  });

  it('rechnet Pan von 0..1 auf -1..1 um', () => {
    applyMappedParameter('mixer.channel2.pan', 0.5);
    expect(setChannelPan).toHaveBeenLastCalledWith('channel2', 0);
    applyMappedParameter('mixer.channel2.pan', 1);
    expect(setChannelPan).toHaveBeenLastCalledWith('channel2', 1);
    applyMappedParameter('mixer.channel2.pan', 0);
    expect(setChannelPan).toHaveBeenLastCalledWith('channel2', -1);
  });

  it('setzt Master-Lautstärke und generische Worklet-Parameter', () => {
    expect(applyMappedParameter('master.volume', 0.8)).toBe(true);
    expect(setMasterVolume).toHaveBeenCalledWith(0.8);
    expect(applyMappedParameter('worklet.cc_21', 0.25)).toBe(true);
    expect(setWorkletParam).toHaveBeenCalledWith('cc_21', 0.25);
  });

  it('weist unbekannte Ziele und ungültige Werte ab (kein stiller Engine-Aufruf)', () => {
    expect(applyMappedParameter('mixer.channel99.volume', 0.5)).toBe(false);
    expect(applyMappedParameter('mixer.channel1.gain', 0.5)).toBe(false);
    expect(applyMappedParameter('worklet.', 0.5)).toBe(false);
    expect(applyMappedParameter('master.volume', Number.NaN)).toBe(false);
    expect(setMasterVolume).not.toHaveBeenCalled();
    expect(setWorkletParam).not.toHaveBeenCalled();
  });

  it('dokumentiert genau die Ziele, die der Dispatcher auch annimmt', () => {
    // Jedes dokumentierte Muster muss tatsächlich funktionieren – sonst zeigt
    // die UI Ziele an, die stillschweigend nichts tun.
    for (const { pattern } of SUPPORTED_MAPPING_TARGETS) {
      expect(applyMappedParameter(pattern, 0.5), `Muster ${pattern}`).toBe(true);
    }
  });
});

describe('Learn-Hook (useMapping)', () => {
  it('lernt eine Regel aus einem ControlEvent und persistiert sie', async () => {
    const { result } = renderHook(() => useMapping());

    await act(async () => {
      result.current.setTarget('mixer.channel4.volume');
      result.current.setKind('absolute');
    });
    await act(async () => {
      await result.current.addFrom(ccEvent(21, 64));
    });

    expect(result.current.rules).toHaveLength(1);
    const rule = result.current.rules[0];
    expect(rule.parameter).toBe(21);
    expect(rule.sourceProtocol).toBe('midi');
    expect(rule.channel).toBe(1);
    expect(rule.target).toBe('mixer.channel4.volume');
    expect(rule.kind).toBe('absolute');
    expect(result.current.lastLearned?.parameter).toBe(21);
    expect(result.current.error).toBeNull();

    // Persistenz-Contract: der Store serialisiert die Regel vollständig
    // (der eigentliche Storage-Adapter ist austauschbar, daher wird hier die
    // Store-Sicht geprüft statt eines konkreten Backends).
    expect(mappingStore.exportJson()).toContain('mixer.channel4.volume');
    expect(mappingStore.engineRef.getRule(rule.id)?.target).toBe('mixer.channel4.volume');
  });

  it('mappt Events ohne sie zu lernen', async () => {
    const { result } = renderHook(() => useMapping());
    await act(async () => {
      await result.current.addFrom(ccEvent(21, 64));
    });

    const mapped = result.current.map(ccEvent(21, 127));
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped[0].target).toBe(result.current.rules[0].target);
    // Ein Event für einen nicht gelernten Parameter bleibt ohne Wirkung.
    expect(result.current.map(ccEvent(99, 127))).toEqual([]);
  });

  it('entfernt Regeln wieder', async () => {
    const { result } = renderHook(() => useMapping());
    await act(async () => {
      await result.current.addFrom(ccEvent(21, 64));
    });
    const id = result.current.rules[0].id;

    await act(async () => {
      await result.current.remove(id);
    });
    expect(result.current.rules).toHaveLength(0);
  });
});
