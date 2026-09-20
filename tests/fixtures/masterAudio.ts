/**
 * Test-Hilfe für die Master-Payload-Prüfung (FIX F3).
 *
 * Baut ECHTE RIFF/WAVE-Dateien statt Attrappen: Die Dauerprüfung liest den
 * RIFF-Kopf (fmt-byteRate + data-Größe), ein erfundener Puffer würde also nichts
 * belegen. Über `sampleRate`/`bits` bleiben die Dateien dabei klein - 245 s bei
 * 2 000 B/s sind ~480 kB, dieselbe Spielzeit in 48-kHz-Stereo wäre 47 MB.
 */

export interface WavOptions {
  sampleRate: number;
  channels: number;
  bits: number;
  seconds: number;
  /**
   * Abweichende (falsche) `data`-Angabe im Kopf bei unverändertem Puffer - prüft,
   * dass die Dauer auf die tatsächlich vorhandenen Bytes gedeckelt wird.
   */
  declaredDataSize?: number;
}

/** WAV als Bytes (Header + Stille-Nutzdaten). */
export function wavBytes(opts: WavOptions): Buffer {
  const byteRate = opts.sampleRate * opts.channels * (opts.bits / 8);
  const dataSize = Math.round(byteRate * opts.seconds);
  const declared = opts.declaredDataSize ?? dataSize;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + declared, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(opts.channels, 22);
  header.writeUInt32LE(opts.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((opts.channels * opts.bits) / 8, 32); // blockAlign
  header.writeUInt16LE(opts.bits, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(declared, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

/** WAV als Base64 (so, wie der Client die Spur sendet). */
export function wavBase64(opts: WavOptions): string {
  return wavBytes(opts).toString('base64');
}
