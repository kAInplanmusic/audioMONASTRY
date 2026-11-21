import { MasterStreamTap } from '../../../src/audio/masterStreamTap';
import { LocalV2SpatialMonitorController } from '../../../src/audio/spatial/localV2SpatialMonitorController';
import { V2LiveSink } from '../../../src/core/audio/backends/V2LiveSink';
import { planClubSpeakers } from '../../../src/core/spatial/v2/clubPlanner';

const frequency = 440;
const silenceLimit = 0.00001;

function requireSignal(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function measure(channel: Float32Array, sampleRate: number) {
  let energy = 0;
  let peak = 0;
  let sine = 0;
  let cosine = 0;
  for (let i = 0; i < channel.length; i++) {
    const sample = channel[i];
    const phase = 2 * Math.PI * frequency * i / sampleRate;
    peak = Math.max(peak, Math.abs(sample));
    energy += sample * sample;
    sine += sample * Math.sin(phase);
    cosine += sample * Math.cos(phase);
  }
  return { peak, rms: Math.sqrt(energy / channel.length), tone: 2 * Math.hypot(sine, cosine) / channel.length };
}

function summarise(analyser: AnalyserNode) {
  const pcm = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(pcm);
  return { ...measure(pcm, analyser.context.sampleRate), pcm: Array.from(pcm) };
}

async function waitFor<T>(label: string, read: () => T, accepted: (sample: T) => boolean): Promise<T> {
  const end = performance.now() + 4000;
  for (;;) {
    const sample = read();
    if (accepted(sample)) return sample;
    if (performance.now() >= end) throw new Error(`${label}: unexpected PCM ${JSON.stringify(sample).slice(0, 350)}`);
    await new Promise<void>(resolve => window.setTimeout(resolve, 20));
  }
}

async function recordStream(stream: MediaStream, context: AudioContext) {
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const parts: Blob[] = [];
  recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('Chromium could not record the stream'));
  });
  recorder.start();
  await new Promise<void>(resolve => window.setTimeout(resolve, 300));
  if (recorder.state !== 'inactive') recorder.stop();
  await stopped;
  const blob = new Blob(parts, { type: recorder.mimeType });
  const audio = await context.decodeAudioData(await blob.arrayBuffer());
  const channel = audio.getChannelData(0);
  const center = Math.floor(channel.length / 2);
  return {
    bytes: blob.size,
    frames: audio.length,
    channels: audio.numberOfChannels,
    mimeType: blob.type,
    pcm: measure(channel.subarray(center - 1024, center + 1024), audio.sampleRate),
  };
}

async function runOutputProof() {
  const context = new AudioContext({ sampleRate: 48000 });
  const faults: string[] = [];
  const sink = new V2LiveSink({ onFault: (fault) => faults.push(JSON.stringify(fault)) });
  const spatial = new LocalV2SpatialMonitorController(sink);
  const silent = context.createGain();
  silent.gain.value = 0;
  silent.connect(context.destination);
  const splitter = context.createChannelSplitter(2);
  const left = context.createAnalyser();
  const right = context.createAnalyser();
  const wet = context.createAnalyser();
  for (const analyser of [left, right, wet]) {
    analyser.fftSize = 2048;
    analyser.connect(silent);
  }
  splitter.connect(left, 0);
  splitter.connect(right, 1);

  function stereo() {
    return { left: summarise(left), right: summarise(right) };
  }
  const stereoActive = (samples: ReturnType<typeof stereo>) => samples.left.tone > 0.02 && samples.right.tone > 0.02;
  const stereoSilent = (samples: ReturnType<typeof stereo>) => samples.left.peak < silenceLimit && samples.right.peak < silenceLimit;
  function stableStereo(label: string) {
    // Accept only an analyser window entirely after the transition.
    const readyAt = context.currentTime + 2 * left.fftSize / context.sampleRate;
    return waitFor(label, stereo, samples => context.currentTime >= readyAt && stereoActive(samples));
  }
  const plan = planClubSpeakers({ widthM: 8, depthM: 6, satellites: 12 });

  try {
    await context.resume();
    requireSignal(context.state === 'running' && crossOriginIsolated, 'AudioContext or SAB unavailable');
    requireSignal(await sink.connect(context), 'Initial V2 AudioWorklet connection failed');
    requireSignal(sink.connectExtra(splitter), 'Stereo output tap failed');
    requireSignal(sink.startTestTone(frequency, 0.2), 'Test tone was not enqueued');
    const baseline = await stableStereo('Stereo output');

    await spatial.start(plan, wet);
    const speaker = plan.satellites.find(({ id }) => id === 'front-2');
    if (!speaker) throw new Error('Reference speaker missing');
    requireSignal(sink.setSpatialTrackPosition('channel1', speaker.positionM), 'Spatial position was not enqueued');
    const binaural = await waitFor('Spatial headphone output', () => summarise(wet), data => data.tone > 0.01);
    const spatialChannels = await waitFor('Spatial meter PCM', () => spatial.meter.snapshot()?.channels ?? [],
      channels => channels.length === 12 && channels.filter(channel => channel.active).length === 1);
    const dryWithSpatial = await stableStereo('Independent stereo tap');
    const tap = new MasterStreamTap({ getContext: () => context, getSink: () => sink, getLegacyTap: () => null });
    const stream = tap.create();
    if (!stream || !tap.isV2Connected) throw new Error('MasterStreamTap has no real AudioWorklet source');
    let recording: Awaited<ReturnType<typeof recordStream>>;
    try {
      recording = await recordStream(stream.stream, context);
    } finally {
      tap.disconnect(stream);
      for (const track of stream.stream.getTracks()) track.stop();
    }
    spatial.stop();
    await waitFor('Spatial output after bypass', () => summarise(wet), data => data.peak < silenceLimit);
    sink.stopTestTone();
    const stopped = await waitFor('Stereo after stop', stereo, stereoSilent);

    sink.disconnect();
    requireSignal(await sink.connect(context), 'V2 AudioWorklet reconnect failed');
    requireSignal(sink.connectExtra(splitter), 'Stereo tap after reconnect failed');
    await waitFor('Stereo starts silent after reconnect', stereo, stereoSilent);
    requireSignal(sink.startTestTone(frequency, 0.2), 'Test tone after reconnect was not enqueued');
    const reconnected = await stableStereo('Stereo after reconnect');
    return { sampleRate: context.sampleRate, frequency, baseline, binaural, spatialChannels, dryWithSpatial, recording, stopped, reconnected, faults };
  } finally {
    spatial.stop();
    sink.disconnect();
    for (const node of [splitter, left, right, wet, silent]) node.disconnect();
    await context.close();
  }
}

declare global {
  interface Window {
    releaseOutputProof?: Promise<Awaited<ReturnType<typeof runOutputProof>>>;
  }
}

document.querySelector('button')?.addEventListener('click', () => {
  window.releaseOutputProof = runOutputProof();
}, { once: true });
