/**
 * audioMONASTRY · AudioEngineBackend (DI-Adapter)
 * =================================================
 * Implementiert `IAudioBackend` über die bestehende `audioEngine`-Fassade.
 * Damit können Plugin-Adapter über `context.audio` statt über den globalen
 * `audioEngine`-Singleton arbeiten → Dependency Injection für Unit-Tests.
 *
 * Alle Methoden delegieren an `audioEngine`. Fehlende Methoden auf der
 * Engine werden als No-Op ausgeführt (graceful degradation).
 */

import { audioEngine } from '../../utils/audioEngine';
import type { IAudioBackend } from '../../core/interfaces';

const AE = audioEngine as any;

export class AudioEngineBackend implements IAudioBackend {
  public readonly id = 'audio-engine-backend';

  init(): Promise<void> {
    return Promise.resolve();
  }

  play(): Promise<void> {
    return AE.play?.() ?? Promise.resolve();
  }

  stop(): void {
    AE.stop?.();
  }

  setTempo(bpm: number): void {
    AE.setBpm?.(bpm);
  }

  getTempo(): number {
    return AE.getBpm?.() ?? 120;
  }

  loadTrackSample(track: string, url: string | null): Promise<void> {
    return AE.loadTrackSample?.(track, url) ?? Promise.resolve();
  }

  triggerEvent(track: string, velocity?: number, time?: number): void {
    AE.triggerEvent?.(track, velocity ?? 0.8, time);
  }

  setChannelGain(track: string, gain01: number): void {
    AE.setChannelGain?.(track, gain01);
  }

  setChannelPan(track: string, pan: number): void {
    AE.setChannelPan?.(track, pan);
  }

  setChannelEQ(track: string, band: 'low' | 'mid' | 'high', gain: number): void {
    AE.setChannelEQ?.(track, band, gain);
  }

  setChannelPfl(track: string, pfl: boolean): void {
    AE.setChannelPfl?.(track, pfl);
  }

  setMasterVolume(gain01: number): void {
    AE.setMasterVolume?.(gain01);
  }

  setMasterVolumeDb(db: number, rampSec: number): void {
    AE.setMasterVolumeDb?.(db, rampSec);
  }

  updateMasterMe(params: Record<string, number>): void {
    AE.updateMasterMe?.(params);
  }

  updateToneShiftEQ(params: { bands: Array<{ freq: number; gain: number; q: number; type: string }> }): void {
    AE.updateToneShiftEQ?.(params);
  }

  setMasterDynamics(_enabled: boolean, _threshold: number, _ratio: number, _makeup: number): void {
    // No-Op: wird über v2LiveSink gesteuert, nicht direkt über audioEngine
  }

  setMasterFx(_wet: number, _feedback: number, _rate: number, _depth: number): void {
    // No-Op: wird über v2LiveSink gesteuert
  }

  setMasterDsp(_cutoff: number, _resonance: number, _depth: number, _drive: number): void {
    // No-Op: wird über v2LiveSink gesteuert
  }

  setMasterMastering(_threshold: number, _ratio: number, _makeup: number, _ceiling: number): void {
    // No-Op: wird über v2LiveSink gesteuert
  }

  setBpm(bpm: number): void {
    AE.setBpm?.(bpm);
  }

  getBpm(): number {
    return AE.getBpm?.() ?? 120;
  }

  getIsPlaying(): boolean {
    return AE.getIsPlaying?.() ?? false;
  }

  createMasterStreamDestination(): MediaStreamAudioDestinationNode | null {
    return AE.createMasterStreamDestination?.() ?? null;
  }

  disconnectMasterStreamDestination(dest: MediaStreamAudioDestinationNode): void {
    AE.disconnectMasterStreamDestination?.(dest);
  }

  createVisualAnalyser(fftSize?: number): AnalyserNode | null {
    return AE.createVisualAnalyser?.(fftSize ?? 2048) ?? null;
  }

  disconnectVisualAnalyser(analyser: AnalyserNode): void {
    AE.disconnectVisualAnalyser?.(analyser);
  }

  automateEqBandGain(band: number, gainDb: number, rampSec: number): void {
    AE.automateEqBandGain?.(band, gainDb, rampSec);
  }

  setOptionalSynthVoice(channel: string, type: string, freq: number, opts: Record<string, number>): void {
    AE.setOptionalSynthVoice?.(channel, type, freq, opts);
  }

  setDrumKit(kit: string): void {
    AE.setDrumKit?.(kit);
  }

  instrumentNote(note: string | number): void {
    AE.instrumentNote?.(note);
  }

  noteOnWorklet(freq: number, velocity: number, type: string): void {
    AE.noteOnWorklet?.(freq, velocity, type);
  }

  setSpatialSetup(setup: string): void {
    AE.setSpatialSetup?.(setup);
  }

  setSpatialMode(mode: 'ON_TOP' | 'SEPARATION'): void {
    AE.setSpatialMode?.(mode);
  }

  automateDsp(param: string, value: number, rampTime: number): void {
    AE.automateDsp?.(param, value, rampTime);
  }

  setDspOversampling(value: number): void {
    AE.setDspOversampling?.(value);
  }

  setDspParam(params: Record<string, number>): void {
    AE.setDspParam?.(params);
  }

  setOptionalModMatrix(params: Record<string, number | boolean>): void {
    AE.setOptionalModMatrix?.(params);
  }

  automateEffect(param: string, value: number, rampTime: number): void {
    AE.automateEffect?.(param, value, rampTime);
  }

  setEffectParams(params: Record<string, number>): void {
    AE.setEffectParams?.(params);
  }

  setEffectParam(param: Record<string, number>): void {
    AE.setEffectParam?.(param);
  }

  setOptionalReverb(params: Record<string, number | boolean>): void {
    AE.setOptionalReverb?.(params);
  }

  readMeterValues(): { peakL: number; peakR: number; peakHoldL: number; peakHoldR: number } | null {
    return AE.readMeterValues?.() ?? null;
  }

  getTrackSampleUrl(track: string): string | null {
    return AE.getTrackSampleUrl?.(track) ?? null;
  }

  async getMusicSampleChannels(url: string): Promise<{ output: Float32Array[]; sampleRate: number; durationSeconds: number } | null> {
    const result = await AE.getMusicSampleChannels?.(url);
    if (!result) return null;
    return {
      output: Array.isArray(result) ? result : (result?.output ?? []),
      sampleRate: result?.sampleRate ?? 48000,
      durationSeconds: result?.durationSeconds ?? 0,
    };
  }

  async ensureDemoPattern?(): Promise<void> {
    return AE.ensureDemoPattern?.();
  }

  onStepUpdate: (cb: (step: number) => void) => void = () => {};
}

export const audioEngineBackend = new AudioEngineBackend();
