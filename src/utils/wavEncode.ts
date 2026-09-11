/**
 * audioMONASTRY · WAV-Encoder (16-Bit-PCM) – EINE Implementierung
 * ==============================================================
 * Vorher gab es **fünf** Kopien desselben Encoders (`localDemucs`,
 * `stemSplitter`, `VoiceMonkService`, zweimal inline in `melody.ts`) – mit
 * unterschiedlichem Clamping und ohne NaN-Schutz. Genau solche Kopien laufen
 * still auseinander, und WAV-Header sind der Ort, an dem subtile Fehler
 * (falsche Blockgröße, Kanal-Reihenfolge, Vorzeichen) am teuersten sind.
 *
 * Kanonisch ist hier:
 *   * **asymmetrisches Clamping** (`s < 0 ? s * 0x8000 : s * 0x7fff`): der
 *     Wertebereich von int16 ist −32768…32767, symmetrisches `* 32767` verliert
 *     bei negativen Werten ein LSB (unhörbar, aber falsch gerundet).
 *   * **NaN/Infinity → 0** (sonst landet undefiniertes Bitmuster im PCM).
 *   * Bis zu 2 Kanäle, verschränkt (L,R,L,R …), Blockgröße entsprechend.
 *
 * Diese Datei ist bewusst rein (kein AudioContext) und damit direkt testbar.
 */

/** Größe des RIFF/WAVE-Headers in Bytes (kein Zusatz-Chunk). */
export const WAV_HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Quantisiert einen Sample auf einen **int16-Ganzzahlwert** (Clamping +
 * NaN-Schutz). Es wird abgeschnitten (nicht gerundet) — genau das tat
 * `DataView.setInt16()` in den bisherigen Encodern implizit, damit bleiben die
 * erzeugten Bytes identisch (einzige bewusste Änderung: negatives Clamping
 * nutzt jetzt den vollen −32768 statt −32767).
 */
export function quantizeInt16(sample: number): number {
  const s = Number.isFinite(sample) ? sample : 0;
  const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
  return Math.trunc(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

/**
 * Kodiert 1–2 Kanäle als 16-Bit-PCM-WAV.
 * Achtung: mehr als 2 Kanäle werden auf 2 begrenzt (WAV-PCM-Stereo-Default).
 */
export function encodeWavFromChannels(channels: readonly Float32Array[], sampleRate: number): Blob {
  const numCh = Math.max(1, Math.min(2, channels.length));
  const frames = channels[0]?.length ?? 0;
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 44100;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = frames * blockAlign;

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt-Chunk-Größe
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true); // Byte-Rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // Bits je Sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      view.setInt16(offset, quantizeInt16(channels[ch]?.[i] ?? 0), true);
      offset += bytesPerSample;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Bequemer Weg für einen `AudioBuffer` (nutzt die Kanäle ohne Kopie). */
export function encodeWavFromAudioBuffer(buffer: AudioBuffer): Blob {
  const numCh = Math.max(1, Math.min(2, buffer.numberOfChannels));
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));
  return encodeWavFromChannels(channels, buffer.sampleRate);
}

/**
 * Kompatibilitätssignatur (Mono-Float32Array, Default 22050 Hz) – die bisherigen
 * Aufrufer in `melody.ts` und `VoiceMonkService.ts` nutzen genau das.
 */
export function encodeWavMono(samples: Float32Array, sampleRate = 22050): Blob {
  return encodeWavFromChannels([samples], sampleRate);
}
