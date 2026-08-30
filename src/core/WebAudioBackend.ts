/**
 * audioMONASTRY · Referenz: WebAudioBackend (1.1.1)
 * ------------------------------------------------
 * Kapselt die bestehende AudioEngine/Tone.js-Kette hinter das `IAudioBackend`
 * Interface. Die 16 Module sollen künftig nur noch dieses Interface nutzen.
 */
import { audioEngine } from '../utils/audioEngine';
import { TrackType, TRACK_ROLE_MAP } from '../types';
import { IAudioBackend } from './interfaces';
import * as Tone from 'tone';

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

  public onStepUpdate(cb: (step: number) => void): void {
    audioEngine.onStepUpdate = cb;
  }

  /** Rolle eines Kanals (zur Semantik-Auswertung); Hilfs-Export der Domänen-Namen. */
  public getTrackRole(track: TrackType): string {
    return TRACK_ROLE_MAP[track] ?? 'sample';
  }
}

/** Der einzige/standardmäßige Audio-Backend für diese Web-App. */
export const webAudioBackend = new WebAudioBackend();
