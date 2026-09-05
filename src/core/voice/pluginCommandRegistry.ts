/**
 * audioMONASTRY · Plugin-Kommando-Registry (Voice-/KI-/MOA-Steuerung)
 * ===================================================================
 * Verdrahtet ALLE 21 Plugins mit dem VoiceControlService:
 *   - transport/mcp/drum/mixer/spatial/instrument/fx/eq/dsp/synth/
 *     voice/library/controller haben echte Engine-Handler,
 *   - sampler/stem/recording/mastering/performance/sound/song/drop/ai haben
 *     echte Handler (Trigger/Events/Status),
 *   - zusätzlich gibt es für JEDE Plugin-ID die generischen Kommandos
 *     activate/deactivate/route (über pluginAudioRouter, P3-2).
 * masterplayerMONK ist KEIN Plugin, sondern feste View-only-Leiste.
 *
 * Die Audio-Engine/Backends werden bewusst lazy importiert, damit die
 * Core-Module ohne Tone/Web-Audio laden (Interface-Boundary-Regel).
 */
import { voiceControlService } from './VoiceControlService';
import { controlBus } from '../events/ControlBus';

/** Verbindliche 21 Plugin-IDs (P3-2: Registry muss alle abdecken). */
export const PLUGIN_COMMAND_IDS: readonly string[] = Object.freeze([
  'mixer', 'drop', 'song', 'effect', 'instrument', 'sampler', 'drum', 'mcp',
  'synthesizer', 'stem', 'voice', 'sound', 'spatial', 'library', 'eq', 'dsp',
  'mastering', 'recording', 'controller', 'performance', 'ai',
]);

let registered = false;

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

  // transport auch als Plugin-Kommando (MOA plant pluginId='transport').
  voiceControlService.registerPluginCommand('transport', 'set_tempo', async (ctx) => {
    const bpm = Number(ctx.intent.parameters.bpm);
    if (!Number.isFinite(bpm)) return;
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.setBpm(bpm);
  }, ['tempo', 'bpm']);
  voiceControlService.registerPluginCommand('transport', 'play', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    await audioEngine.play();
  }, ['play', 'start']);
  voiceControlService.registerPluginCommand('transport', 'stop', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.stop();
  }, ['stop', 'halt']);

  // --- mcpMONK ----------------------------------------------------------------
  const dispatchMcpPattern = (preset: 'four' | 'break' | 'random') => {
    controlBus.emit('monk:mcp-pattern', { preset });
  };
  voiceControlService.registerPluginCommand('mcp', 'pattern_four', async () => {
    dispatchMcpPattern('four');
  }, ['four', 'floor', 'viertel']);
  voiceControlService.registerPluginCommand('mcp', 'pattern_random', async () => {
    dispatchMcpPattern('random');
  }, ['random', 'zufall']);
  voiceControlService.registerPluginCommand('mcp', 'pattern_break', async () => {
    dispatchMcpPattern('break');
  }, ['break', 'drum', 'beat']);

  // --- drumMONK ---------------------------------------------------------------
  voiceControlService.registerPluginCommand('drum', 'kit', async (ctx) => {
    const { audioEngine } = await import('../../utils/audioEngine');
    const kit = String(ctx.intent.parameters.kit ?? 'tr-808');
    audioEngine.setDrumKit(kit);
  }, ['kit', 'drum']);
  voiceControlService.registerPluginCommand('drum', 'pattern_random', async () => {
    // DrumMachine hört auf dieses Event und würfelt sichtbare Patterns für das aktive Kit.
    controlBus.emit('monk:drum-pattern-random', undefined);
  }, ['random', 'zufall', 'pattern']);

  // --- mixerMONK --------------------------------------------------------------
  voiceControlService.registerPluginCommand('mixer', 'gain', async (ctx) => {
    const { audioEngine } = await import('../../utils/audioEngine');
    const db = Number(ctx.intent.parameters.gain ?? -6);
    audioEngine.setMasterVolumeDb(Math.max(-48, Math.min(12, db)), 0.05);
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
  const playSynthNote = async (ctx: { intent: { parameters: Record<string, number | string> } }) => {
    const freq = Number(ctx.intent.parameters.freq ?? 440);
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.noteOnWorklet(Math.max(20, Math.min(20000, freq)), 0.8, 'saw');
  };
  voiceControlService.registerPluginCommand('synthesizer', 'note', playSynthNote, ['note', 'ton', 'freq']);
  // Katalog-Alias: MOA plant pluginId='synth'.
  voiceControlService.registerPluginCommand('synth', 'note', playSynthNote, ['note', 'ton', 'freq']);

  // --- visualizer (Katalog-Alias auf performance/visualizer-mode) ------------
  voiceControlService.registerPluginCommand('visualizer', 'mode', async (ctx) => {
    const mode = String(ctx.intent.parameters.mode ?? 'OSCILLOSCOPE').toUpperCase();
    controlBus.emit('monk:visualizer-mode', mode);
  }, ['mode', 'visual', 'visualizer', 'scope']);

  // --- effectMONK (Katalog-Alias auf fx.automate) -----------------------------
  voiceControlService.registerPluginCommand('effect', 'automate', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.automateEffect('depth', 0.8, 0.5);
  }, ['automat', 'filter', 'sweep']);

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
    controlBus.emit('monk:stem-pick-file', undefined);
  }, ['separate', 'stem', 'trennen', 'datei']);

  // --- recordingMONK -----------------------------------------------------------
  voiceControlService.registerPluginCommand('recording', 'start', async () => {
    controlBus.emit('monk:recorder-start', undefined);
  }, ['start', 'record', 'aufnahme']);
  voiceControlService.registerPluginCommand('recording', 'stop', async () => {
    controlBus.emit('monk:recorder-stop', undefined);
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

  // --- performanceMONK (inkl. ehem. visualMONK-Signalmodus) ---------------------
  voiceControlService.registerPluginCommand('performance', 'mode', async (ctx) => {
    const mode = String(ctx.intent.parameters.mode ?? 'OSCILLOSCOPE').toUpperCase();
    controlBus.emit('monk:visualizer-mode', mode);
  }, ['mode', 'visual', 'visualizer', 'scope']);

  voiceControlService.registerPluginCommand('performance', 'reset', async () => {
    const { performanceMonitor } = await import('../../utils/PerformanceMonitor');
    performanceMonitor.stop();
    performanceMonitor.start();
  }, ['reset', 'performance', 'monitor']);

  // --- masterplayerMONK (Transport-Alias der festen Kopfzeile) ------------------
  voiceControlService.registerPluginCommand('masterplayer', 'play', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    await audioEngine.play();
  }, ['play', 'start']);
  voiceControlService.registerPluginCommand('masterplayer', 'stop', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.stop();
  }, ['stop', 'halt']);
  voiceControlService.registerPluginCommand('masterplayer', 'tempo', async (ctx) => {
    const bpm = Number(ctx.intent.parameters.bpm);
    if (!Number.isFinite(bpm)) return;
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.setBpm(bpm);
  }, ['tempo', 'bpm']);

  // --- soundMONK ---------------------------------------------------------------
  voiceControlService.registerPluginCommand('sound', 'trigger', async () => {
    const { audioEngine } = await import('../../utils/audioEngine');
    audioEngine.triggerEvent('channel8', 0.8);
  }, ['trigger', 'sound', 'pad', 'spiele']);

  // --- songMONK ----------------------------------------------------------------
  voiceControlService.registerPluginCommand('song', 'generate', async (ctx) => {
    const text = String(ctx.intent.parameters.text ?? ctx.intent.raw ?? '');
    if (text) controlBus.emit('monk:song-generate', { prompt: text });
  }, ['song', 'lied', 'track', 'generiere', 'mache']);

  // --- dropMONK ----------------------------------------------------------------
  voiceControlService.registerPluginCommand('drop', 'pattern', async (ctx) => {
    const preset = String(ctx.intent.parameters.preset ?? 'build');
    controlBus.emit('monk:drop-pattern', { preset });
  }, ['drop', 'pattern', 'build', 'clip']);

  // --- aiMONK ------------------------------------------------------------------
  voiceControlService.registerPluginCommand('ai', 'plan', async (ctx) => {
    const text = String(ctx.intent.parameters.text ?? ctx.intent.raw ?? '');
    if (text) controlBus.emit('monk:ai-plan', { text });
  }, ['plan', 'ki', 'ai', 'mache']);

  // --- P3-2: generische Router-Kommandos für ALLE 21 Plugin-IDs ----------------
  // Aktivierung/Routing/Parameter laufen über den PluginAudioRouter (OFF/An,
  // Ziel-Kanal, Parameter). Dadurch ist die Registry vollständig mit dem
  // Audio-Router verdrahtet – kein Plugin bleibt ohne Aktivierungs-Kommando.
  for (const id of PLUGIN_COMMAND_IDS) {
    voiceControlService.registerPluginCommand(id, 'activate', async () => {
      const { activatePlugin } = await import('../../core/pluginAudioRouter');
      activatePlugin(id, 'AUTO_AI');
    }, ['an', 'aktivieren', 'on', 'start']);
    voiceControlService.registerPluginCommand(id, 'deactivate', async () => {
      const { deactivatePlugin } = await import('../../core/pluginAudioRouter');
      deactivatePlugin(id);
    }, ['aus', 'deaktivieren', 'off', 'stop']);
    voiceControlService.registerPluginCommand(id, 'route', async () => {
      const { getPluginRoute } = await import('../../core/pluginAudioRouter');
      const route = getPluginRoute(id);
      controlBus.emit('monk:plugin-route', { pluginId: id, route });
    }, ['route', 'ziel', 'kanal']);
  }

  // --- mixerMONK: Kanal-Parameter (P3-2) ----------------------------------------
  const CHANNEL_IDS = ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8'];
  voiceControlService.registerPluginCommand('mixer', 'channel', async (ctx) => {
    const { audioEngine } = await import('../../utils/audioEngine');
    const channel = String(ctx.intent.parameters.channel ?? 'channel1');
    if (!CHANNEL_IDS.includes(channel)) return;
    const track = channel as 'channel1' | 'channel2' | 'channel3' | 'channel4' | 'channel5' | 'channel6' | 'channel7' | 'channel8';
    if (typeof ctx.intent.parameters.gain === 'number') {
      audioEngine.setChannelGain(track, Math.max(0, Math.min(1.5, Number(ctx.intent.parameters.gain))));
    }
    if (typeof ctx.intent.parameters.pan === 'number') {
      audioEngine.setChannelPan(track, Math.max(-1, Math.min(1, Number(ctx.intent.parameters.pan))));
    }
  }, ['kanal', 'channel', 'gain', 'pan', 'volume']);

  // --- UI-only Plugins (Status-Meldung, Folgeschritte verdrahten) ---------------
  for (const id of ['song', 'stem', 'recording', 'mastering', 'performance', 'sound', 'drop', 'ai']) {
    voiceControlService.registerPluginCommand(id, 'status', async () => {
      // Zusätzlicher Status-Handler (Kommandos wie "Status").
    }, ['status', 'bereit', 'ready']);
  }
}

/** Audit-Helfer: alle registrierten Plugin-Kommandos (pluginId, action). */
export function listRegisteredPluginCommands(): { pluginId: string; action: string }[] {
  return voiceControlService.listPluginCommands().map((c) => ({ pluginId: c.pluginId, action: c.action }));
}

// Beim Import direkt registrieren (Side-Effect-Modul).
registerDefaultVoiceCommands();
