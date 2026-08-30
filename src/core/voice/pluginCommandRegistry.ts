/**
 * audioMONASTRY · Plugin-Kommando-Registry (Voice-/KI-/MOA-Steuerung)
 * ===================================================================
 * Verdrahtet ALLE 17 Plugins mit dem VoiceControlService:
 *   - transport/sequencer/drum/mixer/spatial/instrument/fx/eq/dsp/synth/
 *     voice/library/controller haben echte Engine-Handler,
 *   - sampler/stem/recording/mastering/visualizer/performance melden
 *     ihren Status (UI-only, werden in Folgeschritten verdrahtet).
 *
 * Die Audio-Engine/Backends werden bewusst lazy importiert, damit die
 * Core-Module ohne Tone/Web-Audio laden (Interface-Boundary-Regel).
 */
import { voiceControlService } from './VoiceControlService';

let registered = false;

const sixteen = (steps: number[]): boolean[] => {
  const a = Array<boolean>(16).fill(false);
  for (const s of steps) a[s % 16] = true;
  return a;
};

const FOUR_ON_FLOOR = sixteen([0, 4, 8, 12]);
const OFFBEAT = sixteen([2, 6, 10, 14]);
const BREAK = sixteen([0, 3, 6, 8, 11, 14]);

export function registerDefaultVoiceCommands(): void {
  if (registered) return;
  registered = true;

  // --- transportMONK (global) -------------------------------------------------
  voiceControlService.registerCommand('transport', 'set_tempo', async (ctx) => {
    const bpm = Number(ctx.intent.parameters.bpm);
    if (!Number.isFinite(bpm)) return;
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.setBpm(bpm);
  });
  voiceControlService.registerCommand('transport', 'play', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    await audioEngine.play();
  });
  voiceControlService.registerCommand('transport', 'stop', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.stop();
  });

  // --- sequencerMONK ----------------------------------------------------------
  const applyPatterns = async (patterns: Record<string, boolean[]>, bpm?: number) => {
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.loadPatterns(patterns);
    if (bpm) audioEngine.setBpm(bpm);
    // UI-State-Sync: App/Sequencer hören auf dieses Event und übernehmen die Patterns sichtbar.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('monk:apply-patterns', { detail: { patterns, bpm } }));
    }
  };
  voiceControlService.registerPluginCommand('sequencer', 'pattern_four', async () => {
    await applyPatterns({ channel1: FOUR_ON_FLOOR, channel2: OFFBEAT, channel3: sixteen([4, 12]), channel4: sixteen([0, 3, 6, 9, 12, 15]) });
  }, ['four', 'floor', 'viertel']);
  voiceControlService.registerPluginCommand('sequencer', 'pattern_random', async () => {
    const { random } = await import('../../utils/random');
    const gen = () => sixteen(Array.from({ length: 8 }, () => Math.floor(random() * 16)));
    await applyPatterns({ channel1: gen(), channel2: gen(), channel3: gen(), channel4: gen() });
  }, ['random', 'zufall']);
  voiceControlService.registerPluginCommand('sequencer', 'pattern_break', async () => {
    await applyPatterns({ channel1: BREAK, channel2: sixteen([2, 5, 7, 10, 13, 15]), channel3: sixteen([4, 12]), channel4: sixteen([0, 2, 6, 9, 12, 14]) });
  }, ['break', 'drum', 'beat']);

  // --- drumMONK ---------------------------------------------------------------
  voiceControlService.registerPluginCommand('drum', 'kit', async (ctx) => {
    const { audioEngine } = await import('../../utils/audioEngine');
    const kit = String(ctx.intent.parameters.kit ?? 'tr-808');
    audioEngine.setDrumKit(kit);
  }, ['kit', 'drum']);
  voiceControlService.registerPluginCommand('drum', 'pattern_random', async () => {
    // DrumMachine hört auf dieses Event und würfelt sichtbare Patterns für das aktive Kit.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('monk:drum-pattern-random'));
    }
  }, ['random', 'zufall', 'pattern']);

  // --- mixerMONK --------------------------------------------------------------
  voiceControlService.registerPluginCommand('mixer', 'gain', async (ctx) => {
    const { audioEngine } = await import('../../utils/audioEngine');
    const db = Number(ctx.intent.parameters.gain ?? -6);
    audioEngine.setMixChannelParam('gain', Math.max(-48, Math.min(12, db)), 0.05);
  }, ['gain', 'lautstärke', 'pegel', 'volume']);

  // --- spatialMONK ------------------------------------------------------------
  voiceControlService.registerPluginCommand('spatial', 'setup', async (ctx) => {
    const { audioEngine } = await import('../../utils/audioEngine');
    const id = String(ctx.intent.parameters.setup ?? 'stereo');
    audioEngine.setSpatialSetup(id);
  }, ['setup', 'spatial', 'layout']);
  voiceControlService.registerPluginCommand('spatial', 'mode', async (ctx) => {
    const { audioEngine } = await import('../../utils/audioEngine');
    const mode = String(ctx.intent.parameters.mode ?? 'SEPARATION');
    audioEngine.setSpatialMode(mode as 'ON_TOP' | 'SEPARATION');
  }, ['mode', 'modus']);

  // --- instrumentMONK ---------------------------------------------------------
  voiceControlService.registerPluginCommand('instrument', 'program', async (ctx) => {
    const program = Number(ctx.intent.parameters.program ?? 0);
    const { instrumentBackend } = await import('../instrument/InstrumentBackend');
    instrumentBackend.handleProgramChange(program);
  }, ['program', 'instrument', 'preset']);

  // --- effectMONK / dspMONK / eqMONK -------------------------------------------
  voiceControlService.registerCommand('fx', 'automate', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.automateEffect('depth', 0.8, 0.5); // zipper-frei
  });
  voiceControlService.registerPluginCommand('fx', 'automate', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.automateEffect('depth', 0.8, 0.5);
  }, ['automat', 'filter', 'sweep']);
  voiceControlService.registerPluginCommand('dsp', 'automate', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.automateDsp('drive', 0.7, 0.5);
  }, ['automat', 'filter', 'sweep']);
  voiceControlService.registerPluginCommand('eq', 'automate', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.automateEqBandGain(2, 6, 0.5);
  }, ['automat', 'filter', 'sweep']);

  // --- synthesizerMONK --------------------------------------------------------
  voiceControlService.registerPluginCommand('synth', 'note', async (ctx) => {
    const freq = Number(ctx.intent.parameters.freq ?? 440);
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.noteOnWorklet(Math.max(20, Math.min(20000, freq)), 0.8, 'saw');
  }, ['note', 'ton', 'freq']);

  // --- voiceMONK --------------------------------------------------------------
  voiceControlService.registerPluginCommand('voice', 'speak', async (ctx) => {
    const { voiceMonkService } = await import('./VoiceMonkService');
    await voiceMonkService.speak(ctx.userId, String(ctx.intent.parameters.text ?? 'Hallo'));
  }, ['sprich', 'speak', 'sage']);
  voiceControlService.registerPluginCommand('voice', 'sing', async (ctx) => {
    const { voiceMonkService } = await import('./VoiceMonkService');
    await voiceMonkService.sing(ctx.userId, { notes: [{ lyric: String(ctx.intent.parameters.text ?? 'Hallo'), midi: 60 }], bpm: 120 });
  }, ['sing', 'singen', 'gesang']);
  voiceControlService.registerPluginCommand('voice', 'song', async (ctx) => {
    const { voiceMonkService } = await import('./VoiceMonkService');
    await voiceMonkService.generateSong(ctx.userId, String(ctx.intent.parameters.text ?? 'Dark warehouse techno'));
  }, ['song', 'lied', 'track']);

  // --- libraryMONK ------------------------------------------------------------
  voiceControlService.registerPluginCommand('library', 'sync', async () => {
    await fetch('/api/cloud/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  }, ['sync', 'cloud', 'bibliothek']);

  // --- controllerMONK ---------------------------------------------------------
  voiceControlService.registerPluginCommand('controller', 'rescan', async () => {
    const { audioDeviceManager } = await import('../../utils/audioDeviceManager');
    await audioDeviceManager.refresh();
  }, ['rescan', 'scan', 'controller', 'midi']);

  // --- samplerMONK -------------------------------------------------------------
  voiceControlService.registerPluginCommand('sampler', 'trigger', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.triggerEvent('channel5', 0.8);
  }, ['trigger', 'pad', 'sample', 'spiele']);

  // --- stemMONK ----------------------------------------------------------------
  voiceControlService.registerPluginCommand('stem', 'separate', async () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('monk:stem-pick-file'));
    }
  }, ['separate', 'stem', 'trennen', 'datei']);

  // --- recordingMONK -----------------------------------------------------------
  voiceControlService.registerPluginCommand('recording', 'start', async () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('monk:recorder-start'));
    }
  }, ['start', 'record', 'aufnahme']);
  voiceControlService.registerPluginCommand('recording', 'stop', async () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('monk:recorder-stop'));
    }
  }, ['stop', 'halt']);

  // --- masteringMONK -----------------------------------------------------------
  voiceControlService.registerPluginCommand('mastering', 'preset', async (ctx) => {
    const { MASTERING_PRESETS } = await import('../../data/masteringPresets');
    const { audioEngine } = await import('../../utils/audioEngine');
    const wanted = String(ctx.intent.parameters.preset ?? '').toLowerCase();
    const entries = Object.entries(MASTERING_PRESETS) as [string, { master_me: Record<string, number>; tone_shift: unknown }][];
    const match = entries.find(([k]) => k.toLowerCase() === wanted) ?? entries[0];
    if (match) {
      const preset = match[1];
      audioEngine.updateMasterMe(preset.master_me);
      audioEngine.updateToneShiftEQ(preset.tone_shift as never);
    }
  }, ['preset', 'master', 'mastering']);

  // --- visualizerMONK ----------------------------------------------------------
  voiceControlService.registerPluginCommand('visualizer', 'mode', async (ctx) => {
    const mode = String(ctx.intent.parameters.mode ?? 'OSCILLOSCOPE').toUpperCase();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('monk:visualizer-mode', { detail: mode }));
    }
  }, ['mode', 'visual', 'visualizer']);

  // --- performanceMONK ---------------------------------------------------------
  voiceControlService.registerPluginCommand('performance', 'reset', async () => {
    const { performanceMonitor } = await import('../../utils/PerformanceMonitor');
    performanceMonitor.stop();
    performanceMonitor.start();
  }, ['reset', 'performance', 'monitor']);

  // --- UI-only Plugins (Status-Meldung, Folgeschritte verdrahten) ---------------
  for (const id of ['stem', 'recording', 'mastering', 'visualizer', 'performance']) {
    voiceControlService.registerPluginCommand(id, 'status', async () => {
      // Zusätzlicher Status-Handler (Kommandos wie "Status").
    }, ['status', 'bereit', 'ready']);
  }
}

// Beim Import direkt registrieren (Side-Effect-Modul).
registerDefaultVoiceCommands();
