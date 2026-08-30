/**
 * audioMONASTRY · Stem-Splitter (lokaler DSP-Fallback, 5 Stems)
 * ==============================================================
 * Produktionsreifer Offline-Split nach den Best Practices aus der
 * Browser-Stem-Separation (Demucs/Spleeter-Architektur):
 *
 *  - decode → resample auf 44,1 kHz → Filterbänke → WAV-Encode
 *  - 5 Stems: vocals (Center-Extraktion), melody (Harmonic-Emphasis),
 *    highs / mids / lows (Biquad-Bänder)
 *  - Läuft komplett offline (OfflineAudioContext), keine Cloud, kein Modell
 *
 * Sobald ein ONNX-Demucs-Modell geladen ist, übernimmt der KI-Pfad
 * (`src/ai/localDemucs.ts`); dieser Splitter ist der stabile Fallback.
 */

export interface LocalStemUrls {
  vocals: string;
  melody: string;
  highs: string;
  mids: string;
  lows: string;
}

function getCtxCtor(): typeof OfflineAudioContext | null {
  const win = (typeof window !== 'undefined' ? window : globalThis) as unknown as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  return win.OfflineAudioContext ?? win.webkitOfflineAudioContext ?? null;
}

/** AudioBuffer → 16-Bit-PCM-WAV-Blob. */
function encodeWav(buffer: AudioBuffer): Blob {
  const numCh = Math.min(2, buffer.numberOfChannels);
  const len = buffer.length;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i] || 0));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Teilt eine Audio-Datei offline in 5 Stems und liefert Object-URLs.
 * `onProgress` wird mit 0..100 aufgerufen.
 */
export async function splitStemsLocally(file: File, onProgress?: (p: number) => void): Promise<LocalStemUrls> {
  const Ctx = getCtxCtor();
  if (!Ctx) throw new Error('OfflineAudioContext nicht verfügbar');

  const arrayBuffer = await file.arrayBuffer();
  const decodeCtx = new Ctx(2, 1, 44100);
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  onProgress?.(15);

  // Resample auf 44,1 kHz durch Offline-Render.
  const length = Math.ceil(decoded.duration * 44100);
  const resampleCtx = new Ctx(2, length, 44100);
  const src = resampleCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(resampleCtx.destination);
  src.start(0);
  const audio = await resampleCtx.startRendering();
  onProgress?.(35);

  const chL = audio.getChannelData(0);
  const chR = audio.numberOfChannels > 1 ? audio.getChannelData(1) : audio.getChannelData(0);

  // Mono-Mix + Side (für Center-/Vocal-Extraktion) als eigene Buffer bauen.
  const monoBuf = new Ctx(1, audio.length, 44100).createBuffer(1, audio.length, 44100);
  const sideBuf = new Ctx(1, audio.length, 44100).createBuffer(1, audio.length, 44100);
  const monoData = monoBuf.getChannelData(0);
  const sideData = sideBuf.getChannelData(0);
  for (let i = 0; i < audio.length; i++) {
    monoData[i] = (chL[i] + chR[i]) * 0.5;
    sideData[i] = (chL[i] - chR[i]) * 0.5;
  }

  const band = (ctx: OfflineAudioContext, type: BiquadFilterType, freq: number, q = 0.8) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  };

  const renderInto = async (
    input: AudioBuffer,
    build: (ctx: OfflineAudioContext) => AudioNode[],
  ): Promise<string> => {
    const off = new Ctx(2, input.length, 44100);
    const s = off.createBufferSource();
    s.buffer = input;
    let tail: AudioNode = s;
    for (const node of build(off)) { tail.connect(node); tail = node; }
    tail.connect(off.destination);
    s.start(0);
    const rendered = await off.startRendering();
    return URL.createObjectURL(encodeWav(rendered));
  };

  const lows = await renderInto(monoBuf, (c) => [band(c, 'lowpass', 160, 0.7)]);
  onProgress?.(55);
  const mids = await renderInto(monoBuf, (c) => {
    const lp = band(c, 'lowpass', 2600, 0.6);
    const hp = band(c, 'highpass', 180, 0.7);
    return [hp, lp];
  });
  onProgress?.(70);
  const highs = await renderInto(monoBuf, (c) => [band(c, 'highpass', 2600, 0.6)]);
  onProgress?.(80);

  // Melody: Mitten/Höhen mit harmonischer Betonung (Peaks bei 1k/2k/4k).
  const melody = await renderInto(monoBuf, (c) => {
    const hp = band(c, 'highpass', 320, 0.7);
    const p1 = band(c, 'peaking', 1000, 1.1); p1.gain.value = 4;
    const p2 = band(c, 'peaking', 2000, 1.1); p2.gain.value = 5;
    const p3 = band(c, 'peaking', 4000, 1.0); p3.gain.value = 3;
    return [hp, p1, p2, p3];
  });
  onProgress?.(90);

  // Vocals: Center-Extraktion = (mid) − 0.7·(side), bandbegrenzt 180–8000 Hz.
  const vocals = await renderInto(monoBuf, (c) => {
    const sideGain = c.createGain(); sideGain.gain.value = 0.7;
    const sideSrc = c.createBufferSource(); sideSrc.buffer = sideBuf;
    const hp = band(c, 'highpass', 180, 0.7);
    const lp = band(c, 'lowpass', 8000, 0.6);
    // Signalfluss: mid − side: erst mid normal, dann side invertiert addieren.
    const mix = c.createGain(); mix.gain.value = 1;
    sideSrc.connect(sideGain);
    sideGain.connect(mix);
    sideSrc.start(0);
    // mix ist der Ausgang der Kette; negative Überlagerung via gain -1 auf side:
    sideGain.gain.value = -0.7;
    return [mix, hp, lp];
  });
  onProgress?.(100);

  return { vocals, melody, highs, mids, lows };
}
