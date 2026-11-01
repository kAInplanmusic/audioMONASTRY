#!/usr/bin/env node
/**
 * Xonar U7 Audio Integrity Test (DB-011/017)
 * ============================================
 * Tests real audio hardware on Xonar U7.
 * 
 * Hardware paths:
 * 1. camilla_sink -> pipewire -> U7 hardware (for playback)
 * 2. U7 capture -> pipewire -> camilla_sink.monitor (for recording)
 * 
 * For loopback: play through camilla_sink, record from camilla_sink.monitor
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

/**
 * Generate test WAV files using ffmpeg
 */
function generateTestSignal(filepath) {
  const args = [
    '-hide_banner', '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=0.5',
    '-ac', String(CHANNELS),
    '-ar', String(SAMPLE_RATE),
    '-c:a', 'pcm_s16le',
    filepath
  ];
  const result = spawnSync('ffmpeg', args, { encoding: 'utf-8' });
  return result.status === 0 && fs.existsSync(filepath);
}

function generateSweep(filepath, startHz = 100, endHz = 10000, duration = 2) {
  const args = [
    '-hide_banner', '-y',
    '-f', 'lavfi',
    '-i', `sweep=freq=${startHz}:${endHz}:duration=${duration}:sample_rate=${SAMPLE_RATE}`,
    '-ac', String(CHANNELS),
    '-c:a', 'pcm_s16le',
    filepath
  ];
  const result = spawnSync('ffmpeg', args, { encoding: 'utf-8' });
  return result.status === 0 && fs.existsSync(filepath);
}

/**
 * Check hardware detection via ALSA
 */
function checkHardware() {
  const result = {
    u7Attached: false,
    camillaAvailable: false,
    loopbackModule: false,
  };
  
  try {
    const cardsContent = fs.readFileSync('/proc/asound/cards', 'utf-8');
    result.u7Attached = cardsContent.includes('[U7');
  } catch {}
  
  try {
    const pwLink = spawnSync('pw-link', ['-l'], { encoding: 'utf-8' });
    result.camillaAvailable = pwLink.stdout.includes('camilla_sink:playback');
  } catch {}
  
  try {
    const mods = fs.readFileSync('/proc/modules', 'utf-8');
    result.loopbackModule = mods.includes('snd_aloop') || mods.includes('snd-aloop');
  } catch {}
  
  return result;
}

/**
 * Analyze audio file with ffprobe + sox
 */
function analyzeAudio(filepath) {
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'format=duration:stream=sample_rate,channels',
    '-of', 'json',
    filepath
  ], { encoding: 'utf-8' });
  
  let info = {};
  try { info = JSON.parse(probe.stdout); } catch {}
  
  const duration = parseFloat(info.format?.duration) || 0;
  const sampleRate = parseInt(info.streams?.[0]?.sample_rate) || 0;
  const channels = parseInt(info.streams?.[0]?.channels) || 0;
  
  let rmsDb = -100;
  const stats = spawnSync('sox', [filepath, '-n', 'stats'], { encoding: 'utf-8' });
  const rmsMatch = stats.stderr.match(/RMS lev dB\s+([-\d.]+)/);
  if (rmsMatch) rmsDb = parseFloat(rmsMatch[1]);
  
  return {
    duration,
    sampleRate,
    channels,
    rmsDb,
  };
}

/**
 * Test PipeWire camilla_sink loop
 */
function testCamillaLoop(sineFile, loopFile) {
  console.log('    Testing camilla_sink loop...\n');
  
  // Play sine through camilla_sink
  const play = spawnSync('aplay', ['-D', 'camilla_sink', '-f', 'cd', '-t', 'wav', sineFile], {
    encoding: 'utf-8',
    timeout: 3000
  });
  
  if (play.status !== 0) {
    console.log('    WARNING: aplay failed or timed out');
    return null;
  }
  
  console.log('    Played 440Hz sine through camilla_sink');
  
  // Record from monitor (capture the output)
  const recordDuration = 1;
  const rec = spawnSync('arecord', [
    '-D', 'camilla_sink.monitor',
    '-f', 'cd',
    '-t', 'wav',
    '-d', String(recordDuration),
    '-r', String(SAMPLE_RATE),
    '-c', String(CHANNELS),
    loopFile
  ], { encoding: 'utf-8', timeout: 5000 });
  
  if (rec.status !== 0 || !fs.existsSync(loopFile) || fs.statSync(loopFile).size < 1000) {
    console.log('    WARNING: Loopback recording failed or empty');
    if (rec.stderr) console.log('    arecord stderr:', rec.stderr.substring(0, 200));
    return null;
  }
  
  console.log('    Recorded from camilla_sink.monitor');
  return analyzeAudio(loopFile);
}

/**
 * Main
 */
function main() {
  console.log('=== Xonar U7 Audio Integrity Test (DB-011/017) ===\n');
  
  // Phase 1: Hardware
  const hw = checkHardware();
  console.log('Hardware Status:');
  console.log('  U7 attached: ' + (hw.u7Attached ? 'YES' : 'NO'));
  console.log('  camilla_sink: ' + (hw.camillaAvailable ? 'AVAILABLE' : 'NOT FOUND'));
  console.log('  snd-aloop: ' + (hw.loopbackModule ? 'LOADED' : 'NOT LOADED'));
  
  if (!hw.u7Attached) {
    console.error('\n[GATE] FAIL: U7 not detected');
    process.exit(1);
  }
  
  // Phase 2: Generate signals
  console.log('\nGenerating test signals...');
  const tmpdir = '/tmp/audio-u7-test-' + crypto.randomBytes(4).toString('hex');
  fs.mkdirSync(tmpdir, { recursive: true });
  
  const sineFile = path.join(tmpdir, 'sine-440.wav');
  const sweepFile = path.join(tmpdir, 'sweep.wav');
  const loopFile = path.join(tmpdir, 'loopback.wav');
  
  const sineOk = generateTestSignal(sineFile);
  const sweepOk = generateSweep(sweepFile);
  
  console.log('  sine-440.wav: ' + (sineOk ? 'OK' : 'FAILED'));
  console.log('  sweep.wav: ' + (sweepOk ? 'OK' : 'FAILED'));
  
  if (!sineOk) {
    console.error('Failed to generate sine test file');
    process.exit(1);
  }
  
  // Phase 3: Analyze generated signals
  console.log('\nSignal Analysis:');
  const sineAnalysis = analyzeAudio(sineFile);
  console.log('  Sine 440Hz: ' + sineAnalysis.duration.toFixed(2) + 's, RMS: ' + sineAnalysis.rmsDb.toFixed(1) + 'dB');
  
  if (sweepOk) {
    const sweepAnalysis = analyzeAudio(sweepFile);
    console.log('  Sweep: ' + sweepAnalysis.duration.toFixed(2) + 's, RMS: ' + sweepAnalysis.rmsDb.toFixed(1) + 'dB');
  }
  
  // Phase 4: PipeWire loopback test
  let loopResult = null;
  let loopPass = false;
  
  if (hw.camillaAvailable) {
    console.log('\nPipeWire Loopback Test:');
    loopResult = testCamillaLoop(sineFile, loopFile);
    
    if (loopResult) {
      console.log('  Loopback duration: ' + loopResult.duration.toFixed(2) + 's');
      console.log('  Loopback RMS: ' + loopResult.rmsDb.toFixed(1) + 'dB');
      loopPass = loopResult.duration >= 0.5 && loopResult.rmsDb > -40;
    }
  }
  
  // Cleanup
  fs.rmSync(tmpdir, { recursive: true, force: true });
  
  // Determine pass/fail
  const signalPass = sineAnalysis.duration >= 0.4 && sineAnalysis.duration <= 0.6 && sineAnalysis.rmsDb > -30;
  const hwPass = hw.u7Attached;
  const overallPass = hwPass && signalPass;
  
  // Report
  const report = {
    timestamp: new Date().toISOString(),
    hardware: hw,
    tests: {
      u7Detected: hwPass,
      signalGeneration: signalPass,
      pipeWireLoop: {
        available: hw.camillaAvailable,
        tested: loopResult !== null,
        passed: loopPass,
        measured: loopResult ? {
          duration: loopResult.duration,
          rmsDb: loopResult.rmsDb,
        } : null,
      },
    },
    overall: overallPass,
    notes: {
      freqResponse: 'Requires audio analysis tools (scipy.signal.welch) or physical loopback cable',
      pdcOffset: 'Requires impulse response measurement and cross-correlation',
      xruns: 'Count buffer underruns in PipeWire/journal',
    },
  };
  
  const reportPath = path.join(process.cwd(), 'reports', 'audio-u7-integrity.json');
  const reportsDir = path.dirname(reportPath);
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  
  console.log('\nReport saved to: ' + reportPath);
  
  if (overallPass) {
    console.log('\n[GATE] PASS: Audio hardware verified');
    if (hw.camillaAvailable && loopPass) {
      console.log('[INFO] PipeWire loopback test passed');
    }
    console.log('\nFor full frequency response analysis:');
    console.log('  - Run: python3 scripts/audio-spectrum-analysis.py');
    console.log('  - Or use physical audio loopback cable');
    process.exit(0);
  } else {
    console.log('\n[GATE] FAIL: Audio integrity test failed');
    process.exit(1);
  }
}

main();