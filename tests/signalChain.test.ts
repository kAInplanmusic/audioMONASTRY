import { describe, expect, it } from 'vitest';

import { CANONICAL_PLUGIN_IDS } from '../src/plugins/adapters';
import { signalTopology } from '../src/plugins/pluginContract';
import {
  SIGNAL_CHAIN,
  SIGNAL_CHAIN_ORDER,
  signalChainPath,
  signalOrderIndex,
  signalStageOf,
} from '../src/plugins/signalChain';

describe('Signalkette (linearer Insert-Pfad)', () => {
  it('ordnet jedes kanonische Plugin genau der Stereo-Kette oder dem Kanalzug zu', () => {
    const all = [...SIGNAL_CHAIN_ORDER, ...signalTopology().channelInserts];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...CANONICAL_PLUGIN_IDS].sort());
    expect(signalStageOf('spatial')).toBeNull();
  });

  it('fuehrt Quellen -> Mixer -> Nachbearbeitung -> Recorder -> Ausgang', () => {
    expect(SIGNAL_CHAIN.map((s) => s.id)).toEqual(['sources', 'mixer', 'processing', 'recorder', 'out']);
  });

  it('haelt den Mixer in einer eigenen Stufe mit genau einem Plugin', () => {
    const mixerStage = signalStageOf('mixer');
    expect(mixerStage?.id).toBe('mixer');
    expect(mixerStage?.plugins).toEqual(['mixer']);
  });

  it('legt jede Quelle vor und jede Nachbearbeitung nach den Mixer', () => {
    const mixerIdx = signalOrderIndex('mixer');
    for (const source of ['biblio', 'drop', 'song', 'drumsampler', 'syntisampler', 'instru', 'voice', 'sound', 'stem']) {
      expect(signalStageOf(source)?.id).toBe('sources');
      expect(signalOrderIndex(source)).toBeLessThan(mixerIdx);
    }
    for (const processor of ['effect', 'eq', 'dsp', 'master']) {
      expect(signalStageOf(processor)?.id).toBe('processing');
      expect(signalOrderIndex(processor)).toBeGreaterThan(mixerIdx);
    }
  });

  it('setzt den Recorder als letzte Stufe vor den Ausgang', () => {
    expect(signalStageOf('record')?.id).toBe('recorder');
    expect(signalOrderIndex('record')).toBe(SIGNAL_CHAIN_ORDER.length - 1);
    expect(SIGNAL_CHAIN[SIGNAL_CHAIN.length - 1].id).toBe('out');
    expect(SIGNAL_CHAIN[SIGNAL_CHAIN.length - 1].plugins).toEqual([]);
  });

  it('meldet Unbekanntes als nicht im Signalweg', () => {
    expect(signalStageOf('gibtsNicht')).toBeNull();
    expect(signalOrderIndex('gibtsNicht')).toBe(-1);
    // System-Module sind bewusst keine Plugins der Kette.
    expect(signalStageOf('ai')).toBeNull();
    expect(signalStageOf('perfor')).toBeNull();
  });

  it('liefert einen stabilen Anzeige-Pfad in Signalweg-Reihenfolge', () => {
    const path = signalChainPath();
    expect(path[0]).toBe('biblio');
    expect(path[path.length - 1]).toBe('Main Out');
    expect(path).toContain('mixer');
    expect(path.indexOf('mixer')).toBeLessThan(path.indexOf('dsp'));
    expect(path.indexOf('dsp')).toBeLessThan(path.indexOf('record'));
    expect(path).toEqual(signalChainPath());
  });
});
