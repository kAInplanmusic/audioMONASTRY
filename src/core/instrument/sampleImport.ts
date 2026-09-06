/**
 * audioMONASTRY · Sample-Import (AUDIO-7)
 * ======================================
 * Produktionsreifer Import für:
 *   - WAV  (PCM 16/24/32 + IEEE-Float 32)  → normierte Float32-Samples
 *   - SF2  (SoundFont-2 Subset)            → SFZ-Text + Sample-Buffer-Map
 *   - EXS  (plist-XML-Region-Map, Teilmenge) → SFZ-Text + Sample-Buffer-Map
 *
 * Ausgabe im SFZ-Format, das die vorhandene SFZ-Voice-Engine
 * (src/core/instrument/sfzVoice.ts) direkt abspielen kann.
 */

export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Interleaved Float32 in [-1, 1]. */
  samples: Float32Array;
}

export interface ImportedInstrument {
  name: string;
  sfzText: string;
  /** key = Sample-Pfad (wie in sfzText referenziert), value = Float32Array (mono). */
  samples: Record<string, Float32Array>;
  sampleRate: number;
  format: 'wav' | 'sf2' | 'exs';
}

/* ------------------------------------------------------------------ */
/* WAV                                                              */
/* ------------------------------------------------------------------ */

export function parseWav(bytes: ArrayBuffer | Uint8Array): WavData {
  const buf = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  const view = new DataView(buf);
  if (view.getUint32(0, false) !== 0x52494646) throw new Error('Kein RIFF/WAV (magic "RIFF" fehlt)');
  if (view.getUint32(8, false) !== 0x57415645) throw new Error('Kein WAV (format "WAVE" fehlt)');

  let fmtChunk: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOffset = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420) { // fmt
      fmtChunk = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 0x64617461) { // data
      dataOffset = body;
      dataLength = size;
    }
    offset = body + size + (size % 2); // Chunks sind 2-byte aligned
  }
  if (!fmtChunk || dataOffset < 0) throw new Error('WAV unvollständig (fmt/data fehlt)');
  if (fmtChunk.channels < 1 || fmtChunk.channels > 8) throw new Error(`Ungültige Kanalzahl: ${fmtChunk.channels}`);

  const { channels, sampleRate, bits, audioFormat } = fmtChunk;
  const frameCount = Math.floor(dataLength / (channels * Math.max(1, bits / 8)));
  const out = new Float32Array(frameCount * channels);
  const pcm = bits === 16 && audioFormat === 1 || audioFormat === 3; // 16-bit PCM oder Float
  if (audioFormat === 3 && bits === 32) {
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(dataOffset + i * 4, true);
  } else if (audioFormat === 1 && bits === 16) {
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
  } else if (audioFormat === 1 && bits === 24) {
    for (let i = 0; i < out.length; i++) {
      const b = dataOffset + i * 3;
      const v = (view.getUint8(b) | (view.getUint8(b + 1) << 8) | (view.getUint8(b + 2) << 16));
      out[i] = ((v << 8) >> 8) / 8388608; // sign-extend 24-bit
    }
  } else if (audioFormat === 1 && bits === 32) {
    for (let i = 0; i < out.length; i++) out[i] = view.getInt32(dataOffset + i * 4, true) / 2147483648;
  } else if (audioFormat === 6 || audioFormat === 0xfffe) {
    // A-law/µ-law/extensible: nur PCM-Subformat verarbeiten, sonst Fehler.
    throw new Error(`WAV-Codec ${audioFormat} nicht unterstützt (nur PCM/Float)`);
  } else {
    throw new Error(`WAV-Format ${audioFormat}/${bits} bit nicht unterstützt`);
  }
  void pcm;
  return { sampleRate, channels, bitsPerSample: bits, samples: out };
}

/** WAV → einfaches SFZ-Instrument (eine Region über das ganze Sample). */
export function wavToSfz(name: string, data: WavData): ImportedInstrument {
  const mono = toMono(data);
  const path = `${sanitize(name)}.wav`;
  return {
    name,
    format: 'wav',
    sampleRate: data.sampleRate,
    samples: { [path]: mono },
    sfzText: [
      '<region>',
      `sample=${path}`,
      `pitch_keycenter=60`,
      'loop_mode=no_loop',
    ].join('\n'),
  };
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'sample';
}

export function toMono(data: WavData): Float32Array {
  if (data.channels === 1) return data.samples.slice();
  const n = Math.floor(data.samples.length / data.channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < data.channels; c++) sum += data.samples[i * data.channels + c];
    out[i] = sum / data.channels;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* SF2 (SoundFont-2 Subset) → SFZ                                     */
/* ------------------------------------------------------------------ */

/**
 * Liest ein SoundFont-2: `phdr` (Preset-Header) + `shdr` (Sample-Header).
 * Erzeugt je Preset eine `<global>`-SFZ-Sektion mit Sample-Map. Regionen
 * (Zonen) werden vereinfacht auf den gesamten Sample-Bereich gemappt –
 * für produktive Drum-/Instrument-Basis nutzbar, nicht für komplexe
 * Multi-Zone-SoundFonts.
 */
export function sf2ToSfz(name: string, bytes: ArrayBuffer | Uint8Array): ImportedInstrument {
  const buf = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  const view = new DataView(buf);
  const ascii = (off: number, len: number) => {
    let s = '';
    for (let i = 0; i < len && off + i < buf.byteLength; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  };
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'sfbk') throw new Error('Kein SoundFont-2 (sfbk fehlt)');

  let sampleRate = 44100;
  let smpl: ArrayBuffer | null = null;
  const shdr: { name: string; start: number; end: number; rate: number }[] = [];
  const phdr: { name: string; sampleStartIdx: number }[] = [];

  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = ascii(off, 4);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'LIST') {
      const type = ascii(body, 4);
      if (type === 'sdta') {
        // smpl-Chunks innerhalb sdta
        let p = body + 4;
        while (p + 8 <= body + size) {
          const cid = ascii(p, 4);
          const csize = view.getUint32(p + 4, true);
          if (cid === 'smpl') smpl = buf.slice(p + 8, p + 8 + csize);
          p += 8 + csize;
        }
      } else if (type === 'pdta') {
        let p = body + 4;
        while (p + 8 <= body + size) {
          const cid = ascii(p, 4);
          const csize = view.getUint32(p + 4, true);
          const c = p + 8;
          if (cid === 'phdr') {
            const count = Math.floor(csize / 38);
            for (let i = 0; i < count; i++) {
              const presetName = ascii(c + i * 38, 20).replace(/\0+$/g, '');
              const sampleStartIdx = view.getUint16(c + i * 38 + 34, true);
              if (presetName) phdr.push({ name: presetName, sampleStartIdx });
            }
          } else if (cid === 'shdr') {
            const count = Math.floor(csize / 46);
            for (let i = 0; i < count; i++) {
              const sampleName = ascii(c + i * 46, 20).replace(/\0+$/g, '');
              const start = view.getUint32(c + i * 46 + 20, true);
              const end = view.getUint32(c + i * 46 + 24, true);
              const rate = view.getUint32(c + i * 46 + 32, true);
              if (sampleName && end > start) shdr.push({ name: sampleName, start, end, rate });
            }
          } else if (cid === 'ifil') {
            // keine Aktion nötig
          }
          p += 8 + csize;
        }
      }
    } else if (id === 'INFO') {
      // sampleRate wird üblicherweise aus shdr übernommen
    }
    off = body + size + (size % 2);
  }

  if (!smpl) throw new Error('SF2 enthält keine Sample-Daten (sdta/smpl)');
  const samples: Record<string, Float32Array> = {};
  for (const s of shdr) {
    if (!s.rate) continue;
    sampleRate = s.rate;
    const start = Math.max(0, s.start);
    const end = Math.min(s.end, Math.floor(smpl.byteLength / 2));
    const n = Math.max(0, end - start);
    const arr = new Float32Array(n);
    const v = new DataView(smpl);
    for (let i = 0; i < n; i++) arr[i] = v.getInt16((start + i) * 2, true) / 32768;
    samples[`${sanitize(s.name)}.wav`] = arr;
  }
  if (Object.keys(samples).length === 0) throw new Error('SF2 enthält keine verwertbaren Samples');

  const sections: string[] = [];
  for (const preset of phdr) {
    const idx = Math.min(preset.sampleStartIdx, shdr.length - 1);
    const s = shdr[idx];
    if (!s) continue;
    const key = `${sanitize(s.name)}.wav`;
    if (!samples[key]) continue;
    sections.push(`\n<group>\nlokey=0 hikey=127\npitch_keycenter=60\n\n<region>\nsample=${key}\n`);
  }
  if (sections.length === 0) {
    // Fallback: erstes Sample als ein Region-Instrument
    const key = Object.keys(samples)[0];
    sections.push(`<region>\nsample=${key}\npitch_keycenter=60\n`);
  }

  return { name, format: 'sf2', sampleRate, samples, sfzText: sections.join('\n') };
}

/* ------------------------------------------------------------------ */
/* EXS (plist-XML-Region-Map, Teilmenge) → SFZ                         */
/* ------------------------------------------------------------------ */

/**
 * Konvertiert eine vereinfachte EXS-plist-XML in SFZ.
 * Erwartet `<dict><key>filename</key><string>foo.wav</string>...</dict>`
 * Regionen mit `note`/`key` und Sample-Datei. Die Sample-Bytes müssen
 * separat übergeben werden (externe Dateien auf dem Stick/Laufwerk).
 */
export function exsPlistToSfz(name: string, xml: string, samples: Record<string, Float32Array>): ImportedInstrument {
  const regions = parseExsRegions(xml);
  if (regions.length === 0) throw new Error('EXS: keine Regionen gefunden');
  const sfzLines: string[] = [];
  for (const r of regions) {
    const key = sanitize(r.file);
    if (!samples[key]) continue;
    sfzLines.push(`<region>\nsample=${key}\npitch_keycenter=${r.key ?? 60}\nlokey=${r.loKey ?? 0} hikey=${r.hiKey ?? 127}\n`);
  }
  if (sfzLines.length === 0) throw new Error('EXS: keine passenden Sample-Buffer vorhanden');
  const rate = 44100;
  return { name, format: 'exs', sampleRate: rate, samples, sfzText: sfzLines.join('\n') };
}

interface ExsRegion { file: string; key?: number; loKey?: number; hiKey?: number }

export function parseExsRegions(xml: string): ExsRegion[] {
  const regions: ExsRegion[] = [];
  const dictRe = /<dict>([\s\S]*?)<\/dict>/g;
  let m: RegExpExecArray | null;
  while ((m = dictRe.exec(xml))) {
    const body = m[1];
    const keys = [...body.matchAll(/<key>([^<]+)<\/key>\s*<(?:string|integer|real)>(?:<string>)?([^<]*)(?:<\/string>)?<\/(?:string|integer|real)>/g)];
    const map: Record<string, string> = {};
    for (const k of keys) map[k[1].toLowerCase()] = k[2];
    const file = map.filename ?? map['sample name'] ?? map.file;
    if (!file) continue;
    regions.push({
      file,
      key: map.note !== undefined ? Number(map.note) : undefined,
      loKey: map['lo key'] !== undefined ? Number(map['lo key']) : undefined,
      hiKey: map['hi key'] !== undefined ? Number(map['hi key']) : undefined,
    });
  }
  return regions;
}

/* ------------------------------------------------------------------ */
/* High-Level: Datei-Import                                            */
/* ------------------------------------------------------------------ */

export function detectImportFormat(name: string, bytes: ArrayBuffer | Uint8Array): 'wav' | 'sf2' | 'exs' {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = String.fromCharCode(b[0], b[1], b[2], b[3] ?? 0);
  if (head === 'RIFF') {
    const type = String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0);
    return type === 'sfbk' ? 'sf2' : 'wav';
  }
  if (name.toLowerCase().endsWith('.exs') || /<dict>|<plist/i.test(String.fromCharCode(...b.slice(0, Math.min(256, b.length))))) return 'exs';
  throw new Error(`Unbekanntes Import-Format (erwartet .wav/.sf2/.exs): ${name}`);
}
