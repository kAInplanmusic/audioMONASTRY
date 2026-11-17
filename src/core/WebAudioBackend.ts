/**
 * audioMONASTRY · Referenz: WebAudioBackend (1.1.1)
 * ------------------------------------------------
 * Kapselt die bestehende AudioEngine/Tone.js-Kette hinter das `IAudioBackend`
 * Interface. Die 16 Module sollen künftig nur noch dieses Interface nutzen.
 */
import { audioEngine } from '../utils/audioEngine';
import { TrackType, TRACK_ROLE_MAP } from '../types';
import { IAudioBackend } from './interfaces';
import * as Tone from '../core/audio/compat/nativeAudioKit';

const LEGAL: TrackType[] = [
  'channel1', 'channel2', 'channel3', 'channel4',
  'channel5', 'channel6', 'channel7', 'channel8',
];

export class WebAudioBackend implements IAudioBackend {
  readonly id = 'webaudio';

  public async init(): Promise<void> {
    await audioEngine.init?.();
  }

  public async play(): Promise<void> {
    await audioEngine.init();
    await audioEngine.play();
  }

  public stop(): void {
    audioEngine.stop();
  }

  public setTempo(bpm: number): void {
    if (Number.isFinite(bpm) && bpm > 20 && bpm < 300) {
      Tone.Transport.bpm.value = bpm;
    }
  }

  public getTempo(): number {
    return Tone.Transport.bpm.value;
  }

  public async loadTrackSample(track: string, url: string | null): Promise<void> {
    if (!LEGAL.includes(track as TrackType)) return;
    await audioEngine.loadTrackSample(track as TrackType, url);
  }

  public triggerEvent(track: string, velocity = 1, _time?: number): void {
    if (!LEGAL.includes(track as TrackType)) return;
    audioEngine.triggerEvent(track as TrackType, velocity);
  }

  public setChannelGain(track: string, gain01: number): void {
    if (!LEGAL.includes(track as TrackType)) return;
    audioEngine.setChannelGain(track as TrackType, gain01);
  }

  public setChannelPan(track: string, pan: number): void {
    if (!LEGAL.includes(track as TrackType)) return;
    audioEngine.setChannelPan(track as TrackType, pan);
  }

  public setChannelEQ(track: string, band: 'low' | 'mid' | 'high', gain: number): void {
    if (!LEGAL.includes(track as TrackType)) return;
    audioEngine.setChannelEQ(track as TrackType, band, gain);
  }

  public setMasterVolume(gain01: number): void {
    audioEngine.setMasterVolume(gain01);
  }

  public setChannelPfl(track: string, pfl: boolean): void {
    if (!LEGAL.includes(track as TrackType)) return;
    audioEngine.setChannelPfl?.(track as TrackType, pfl);
  }

  public onStepUpdate(cb: (step: number) => void): void {
    audioEngine.onStepUpdate = cb;
  }

  public setMasterVolumeDb(db: number, rampSec: number): void {
    audioEngine.setMasterVolumeDb?.(db, rampSec);
  }

  public updateMasterMe(params: Record<string, number>): void {
    audioEngine.updateMasterMe?.(params);
  }

  public updateToneShiftEQ(params: { bands: Array<{ freq: number; gain: number; q: number; type: string }> }): void {
    audioEngine.updateToneShiftEQ?.(params);
  }

  public setMasterDynamics(enabled: boolean, threshold: number, ratio: number, makeup: number): void {
    (audioEngine as any).setMasterDynamics?.(enabled, threshold, ratio, makeup);
  }

  public setMasterFx(wet: number, feedback: number, rate: number, depth: number): void {
    (audioEngine as any).setMasterFx?.(wet, feedback, rate, depth);
  }

  public setMasterDsp(cutoff: number, resonance: number, depth: number, drive: number): void {
    (audioEngine as any).setMasterDsp?.(cutoff, resonance, depth, drive);
  }

  public setMasterMastering(threshold: number, ratio: number, makeup: number, ceiling: number): void {
    (audioEngine as any).setMasterMastering?.(threshold, ratio, makeup, ceiling);
  }

  public setBpm(bpm: number): void {
    audioEngine.setBpm?.(bpm);
  }

  public getBpm(): number {
    return audioEngine.getBpm?.() ?? 120;
  }

  public getIsPlaying(): boolean {
    return audioEngine.getIsPlaying?.() ?? false;
  }

  public createMasterStreamDestination(): MediaStreamAudioDestinationNode | null {
    return audioEngine.createMasterStreamDestination?.() ?? null;
  }

  public disconnectMasterStreamDestination(dest: MediaStreamAudioDestinationNode): void {
    audioEngine.disconnectMasterStreamDestination?.(dest);
  }

  public createVisualAnalyser(fftSize?: number): AnalyserNode | null {
    return audioEngine.createVisualAnalyser?.(fftSize ?? 2048) ?? null;
  }

  public disconnectVisualAnalyser(analyser: AnalyserNode): void {
    audioEngine.disconnectVisualAnalyser?.(analyser);
  }

  public automateEqBandGain(band: number, gainDb: number, rampSec: number): void {
    audioEngine.automateEqBandGain?.(band, gainDb, rampSec);
  }

  public setOptionalSynthVoice(channel: string, type: string, freq: number, opts: Record<string, number>): void {
    (audioEngine as any).setOptionalSynthVoice?.(channel as TrackType, type, freq, opts);
  }

  public setDrumKit(kit: string): void {
    audioEngine.setDrumKit?.(kit);
  }

  public instrumentNote(note: string | number): void {
    audioEngine.instrumentNote?.(note);
  }

  public noteOnWorklet(freq: number, velocity: number, type: string): void {
    audioEngine.noteOnWorklet?.(freq, velocity, type);
  }

  public setSpatialSetup(setup: string): void {
    audioEngine.setSpatialSetup?.(setup);
  }

  public setSpatialMode(mode: 'ON_TOP' | 'SEPARATION'): void {
    audioEngine.setSpatialMode?.(mode);
  }

  public automateDsp(param: string, value: number, rampTime: number): void {
    (audioEngine as any).automateDsp?.(param, value, rampTime);
  }

  public setDspOversampling(value: number): void {
    audioEngine.setDspOversampling?.(value);
  }

  public setDspParam(params: Record<string, number>): void {
    audioEngine.setDspParam?.(params);
  }

  public setOptionalModMatrix(params: Record<string, number | boolean | undefined>): void {
    (audioEngine as any).setOptionalModMatrix?.(params);
  }

  public automateEffect(param: string, value: number, rampTime: number): void {
    (audioEngine as any).automateEffect?.(param, value, rampTime);
  }

  public setEffectParams(params: Record<string, number>): void {
    audioEngine.setEffectParams?.(params);
  }

  public setEffectParam(param: Record<string, number>): void {
    audioEngine.setEffectParam?.(param);
  }

  public setOptionalReverb(params: Record<string, number | boolean | undefined>): void {
    (audioEngine as any).setOptionalReverb?.(params);
  }

  public readMeterValues(): { peakL: number; peakR: number; peakHoldL: number; peakHoldR: number } | null {
    return audioEngine.readMeterValues?.() ?? null;
  }

  public getTrackSampleUrl(track: string): string | null {
    return audioEngine.getTrackSampleUrl?.(track as TrackType) ?? null;
  }

  public async getMusicSampleChannels(url: string): Promise<{ output: Float32Array[]; sampleRate: number; durationSeconds: number } | null> {
    const result = await (audioEngine as any).getMusicSampleChannels?.(url);
    if (!result) return null;
    return {
      output: Array.isArray(result) ? result : (result?.output ?? []),
      sampleRate: result?.sampleRate ?? 48000,
      durationSeconds: result?.durationSeconds ?? 0,
    };
  }

  public async ensureDemoPattern?(): Promise<void> {
    return audioEngine.ensureDemoPattern?.();
  }

  /** Rolle eines Kanals (zur Semantik-Auswertung); Hilfs-Export der Domänen-Namen. */
  public getTrackRole(track: TrackType): string {
    return TRACK_ROLE_MAP[track] ?? 'sample';
  }
}

/** Der einzige/standardmäßige Audio-Backend für diese Web-App. */
export const webAudioBackend = new WebAudioBackend();
