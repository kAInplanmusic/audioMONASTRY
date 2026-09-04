/**
 * audioMONASTRY · SFZ-Voice-Management (LinuxSampler-Vorbild, eigener Code)
 * =========================================================================
 * Polyphone Stimmenverwaltung für SFZ-Instrumente:
 *   * Region-Auswahl über `matchRegion()` (Key-Ranges, Velocity-Layer,
 *     Round-Robin, Loops) aus `sfzParser.ts`
 *   * Voice-Pool (max. 16, LRU-Stealing), AD-Hüllkurve (Attack/Release aus
 *     Region bzw. Default), Loop-Wiedergabe (`loop_continuous`), Note-Off
 *   * Sample-Quellen als Map `sampleName -> Float32Array` (OPFS/Decode-Worker
 *     liefert die Buffer; hier reines, serverlos testbares Voice-Management)
 */
import { matchRegion, parseSfz, type SfzRegion } from './sfzParser';

export interface SfzSourceMap {
  [sample: string]: Float32Array;
}

interface SfzVoice {
  region: SfzRegion;
  source: Float32Array;
  pos: number;
  active: boolean;
  releasing: boolean;
  noteHz: number;
  velocity: number;
  age: number;
  envPos: number;
  voicesAmpRelease: number;
}

const MAX_VOICES = 16;

export class SfzVoiceBank {
  private regions: SfzRegion[] = [];
  private sources: SfzSourceMap = {};
  private voices: SfzVoice[] = [];
  private sampleRate: number;
  private roundRobin = 0;
  private ageCounter = 0;
  private attackSec: number;
  private releaseSec: number;

  constructor(sampleRate = 48000, attackSec = 0.002, releaseSec = 0.08) {
    this.sampleRate = Math.max(8000, sampleRate);
    this.attackSec = attackSec;
    this.releaseSec = releaseSec;
  }

  /** Lädt SFZ-Text + Sample-Buffer und ersetzt das Instrument. */
  load(sfzText: string, sources: SfzSourceMap): string[] {
    const parsed = parseSfz(sfzText);
    this.regions = parsed.regions;
    this.sources = sources;
    this.voices = [];
    return parsed.errors;
  }

  get regionCount(): number {
    return this.regions.length;
  }

  noteOn(note: number, velocity = 100): void {
    if (this.regions.length === 0) return;
    const region = matchRegion(this.regions, note, velocity, { roundRobin: this.roundRobin++ });
    if (!region?.sample) return;
    const source = this.sources[region.sample];
    if (!source || source.length === 0) return;

    let voice = this.voices.find((v) => v.releasing);
    if (!voice && this.voices.length >= MAX_VOICES) {
      let oldest = this.voices[0];
      for (const v of this.voices) if (v.age < oldest.age) oldest = v;
      voice = oldest;
    }
    if (voice) {
      voice.region = region;
      voice.source = source;
      voice.pos = 0;
      voice.active = true;
      voice.releasing = false;
      voice.noteHz = note;
      voice.velocity = velocity / 127;
      voice.age = ++this.ageCounter;
      voice.envPos = 0;
      voice.voicesAmpRelease = 0;
    } else {
      this.voices.push({ region, source, pos: 0, active: true, releasing: false, noteHz: note, velocity: velocity / 127, age: ++this.ageCounter, envPos: 0, voicesAmpRelease: 0 });
    }
  }

  noteOff(note: number): void {
    for (const v of this.voices) {
      if (Math.abs(v.noteHz - note) < 0.5 && !v.releasing) v.releasing = true;
    }
  }

  /** Rendert einen Block (wird zuerst genullt). */
  renderBlock(out: Float32Array, blockLen: number): void {
    out.fill(0);
    for (let i = 0; i < blockLen; i++) {
      let mix = 0;
      for (const v of this.voices) {
        if (!v.active) continue;
        // Loop-Logik: loop_continuous springt an loop_start zurück.
        if (v.pos >= v.source.length) {
          if (v.region.loopMode === 'loop_continuous' && (v.region.loopStart ?? 0) < v.source.length) {
            v.pos = Math.max(0, v.region.loopStart ?? 0);
          } else {
            v.active = false;
            continue;
          }
        }
        const idx = Math.floor(v.pos);
        const frac = v.pos - idx;
        const next = Math.min(idx + 1, v.source.length - 1);
        const s = v.source[idx] + (v.source[next] - v.source[idx]) * frac;

        // AD-Hüllkurve: kurzer Attack, Release nach Note-Off.
        const rel = this.releaseSec * this.sampleRate;
        const atk = Math.max(1, this.attackSec * this.sampleRate);
        let env = 1;
        if (v.releasing) {
          env = Math.max(0, 1 - (v.voicesAmpRelease ?? 0));
        } else {
          env = Math.min(1, v.envPos / atk);
          v.envPos += 1;
        }
        if (v.releasing) v.voicesAmpRelease = (v.voicesAmpRelease ?? 0) + 1 / rel;
        mix += s * env * v.velocity;
        v.pos += 1;
      }
      if (!Number.isFinite(mix)) mix = 0;
      out[i] = Math.max(-1, Math.min(1, mix));
    }
  }
}
