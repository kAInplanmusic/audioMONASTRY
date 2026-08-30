// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import '../src/core/voice/pluginCommandRegistry';
import { voiceControlService } from '../src/core/voice/VoiceControlService';

// Audio-Engine im jsdom-Test mocken: Tone braucht einen echten AudioContext,
// die Registry-Handler sollen aber ihre Erfolgspfade durchlaufen.
vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: {
    setBpm: () => {},
    play: async () => {},
    stop: () => {},
    loadPatterns: () => {},
    setDrumKit: () => {},
    setMixChannelParam: () => {},
    setSpatialSetup: () => {},
    setSpatialMode: () => {},
    automateItSynthParam: () => {},
    automateEffect: () => {},
    automateDsp: () => {},
    automateMastering: () => {},
    automateEqBandGain: () => {},
    noteOnWorklet: () => {},
    triggerEvent: () => {},
    updateMasterMe: () => {},
    updateToneShiftEQ: () => {},
    ingestAudioSources: () => {},
  },
}));

vi.mock('../src/core/instrument/InstrumentBackend', () => ({
  instrumentBackend: { handleProgramChange: async () => {} },
}));

function nextEvent(name: string): Promise<CustomEvent> {
  return new Promise((resolve) => {
    const handler = (e: Event) => {
      window.removeEventListener(name, handler);
      resolve(e as CustomEvent);
    };
    window.addEventListener(name, handler);
  });
}

describe('MOA Event-Handler (jsdom)', () => {
  it('stem separate feuert das Datei-Picker-Event', async () => {
    const eventPromise = nextEvent('monk:stem-pick-file');
    const res = await voiceControlService.executePluginCommand('User1', 'stem', 'separate');
    await eventPromise;
    expect(res.handled).toBe(true);
  });

  it('recording start/stop feuern die Recorder-Events', async () => {
    const startPromise = nextEvent('monk:recorder-start');
    const startRes = await voiceControlService.executePluginCommand('User1', 'recording', 'start');
    await startPromise;
    expect(startRes.handled).toBe(true);

    const stopPromise = nextEvent('monk:recorder-stop');
    const stopRes = await voiceControlService.executePluginCommand('User1', 'recording', 'stop');
    await stopPromise;
    expect(stopRes.handled).toBe(true);
  });

  it('visualizer mode überträgt den gewünschten Modus', async () => {
    const eventPromise = nextEvent('monk:visualizer-mode');
    await voiceControlService.executePluginCommand('User1', 'visualizer', 'mode', { mode: 'SPECTROGRAM' });
    const event = await eventPromise;
    expect(event.detail).toBe('SPECTROGRAM');
  });

  it('performance reset startet das Monitoring ohne Fehler neu', async () => {
    const res = await voiceControlService.executePluginCommand('User1', 'performance', 'reset');
    expect(res.handled).toBe(true);
  });

  it('sampler trigger und sequencer pattern_random sind registriert', () => {
    const commands = voiceControlService.listPluginCommands();
    expect(commands.some((c) => c.pluginId === 'sampler' && c.action === 'trigger')).toBe(true);
    expect(commands.some((c) => c.pluginId === 'sequencer' && c.action === 'pattern_random')).toBe(true);
  });

  it('alle Registry-Kommandos sind aufrufbar (Handler-Pfade)', async () => {
    const commands = voiceControlService.listPluginCommands();
    expect(commands.length).toBeGreaterThan(20);
    for (const c of commands) {
      const res = await voiceControlService.executePluginCommand('User1', c.pluginId, c.action);
      expect([true, false]).toContain(res.handled);
    }
  }, 20000);

  it('transport/fx Intent-Handler sind ausführbar', async () => {
    expect((await voiceControlService.execute('User1', 'Tempo 128')).handled).toBe(true);
    expect((await voiceControlService.execute('User1', 'Stop')).handled).toBe(true);
    expect((await voiceControlService.execute('User1', 'Play')).handled).toBe(true);
    expect((await voiceControlService.execute('User1', 'Filter automatisieren')).handled).toBe(true);
  });
});

describe('HF-Provider im Browser-Fallback (jsdom)', () => {
  it('TTS/Song/Sing werfen bei relativem Fetch (kein Key nötig)', async () => {
    const { HfTtsProvider, HfBarkSingingProvider } = await import('../src/core/voice/VoiceMonkService');
    const { HfMusicGenProvider } = await import('../src/core/voice/SongGenerator');
    const { hfVoiceRequest } = await import('../src/core/voice/hfApi');
    await expect(new HfTtsProvider().synth('Hallo', {})).rejects.toThrow();
    await expect(new HfMusicGenProvider().generate('x', {})).rejects.toThrow();
    await expect(new HfBarkSingingProvider().render('Hallo', [], 120)).rejects.toThrow();
    await expect(hfVoiceRequest('sing', { text: 'Hallo' })).rejects.toThrow();
  });

  it('completeLlm nutzt im Browser den Server-Proxy (relativer Fetch schlägt fehl)', async () => {
    const { completeLlm } = await import('../src/core/ai/clientLlm');
    await expect(completeLlm({ prompt: 'Hi', complexity: 'simple' })).rejects.toThrow();
  });
});
