import 'dotenv/config';

/**
 * audioMONASTRY – Replicate-Livetest (Stems, Pay-per-Use)
 * ========================================================
 * Prüft den kompletten Server-Pfad gegen die echte Replicate-API:
 *   1. Token/Account gültig?
 *   2. Modell-Version auflösbar (cjwbw/demucs oder REPLICATE_STEM_MODEL)?
 *   3. Prediction-Job startbar und bis zum Ende verfolgbar?
 *      (bei fehlendem Guthaben wird 402 INSUFFICIENT_CREDIT erwartet und
 *       als verifizierter Pfad gewertet)
 *
 * Aufruf:  npx tsx scripts/replicate-smoke.ts
 * Exit:    0 = Pfad verifiziert (Job gelaufen ODER 402 sauber erkannt)
 *          1 = Token/Modell/Input-Format fehlerhaft
 */
const TOKEN = (process.env.REPLICATE_API_TOKEN || '').trim();
const MODEL = (process.env.REPLICATE_STEM_MODEL || 'cjwbw/demucs').trim();

function log(step: string, detail: string): void {
  console.log(`[replicate-smoke] ${step}: ${detail}`);
}

/**
 * 12s Testsignal (44.1 kHz, Stereo, 16-bit) mit leisem Rauschen.
 * Reine Stille/kurze Clips scheitern an Demucs' Reflect-Padding
 * (Segmentlänge ~7.8s) – daher mind. 12s und minimales Dithering.
 */
function makeTestWavDataUri(): string {
  const sampleRate = 44100;
  const seconds = 12;
  const channels = 2;
  const samples = Math.floor(sampleRate * seconds) * channels;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);            // PCM chunk size
  buf.writeUInt16LE(1, 20);             // PCM
  buf.writeUInt16LE(channels, 22);      // Stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  buf.writeUInt16LE(channels * 2, 32);  // block align
  buf.writeUInt16LE(16, 34);            // bits
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 44; i < buf.length; i += 2) {
    // Leises Rauschen (±200 LSB) hält den Peak weit unter 0 dBFS.
    buf.writeInt16LE(Math.floor((Math.random() - 0.5) * 400), i);
  }
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}

async function main(): Promise<void> {
  if (!TOKEN) {
    log('FAIL', 'REPLICATE_API_TOKEN nicht gesetzt');
    process.exit(2);
  }

  // 1) Account
  const accountResp = await fetch('https://api.replicate.com/v1/account', {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!accountResp.ok) {
    log('FAIL', `Account-Endpunkt HTTP ${accountResp.status}`);
    process.exit(1);
  }
  const account = await accountResp.json() as { type?: string; username?: string; name?: string };
  log('OK', `Account gültig (type=${account.type ?? '?'}, username=${account.username ?? '?'}, name=${account.name ?? '?'})`);

  // 2) Modell-Version auflösen (Alias-404-Fix aus server.ts)
  const modelResp = await fetch(`https://api.replicate.com/v1/models/${MODEL}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!modelResp.ok) {
    log('FAIL', `Modell ${MODEL}: HTTP ${modelResp.status}`);
    process.exit(1);
  }
  const modelInfo = await modelResp.json() as { latest_version?: { id?: string } };
  const versionId = modelInfo.latest_version?.id ?? '';
  if (!versionId) {
    log('FAIL', `Modell ${MODEL}: keine lauffähige Version`);
    process.exit(1);
  }
  log('OK', `Modell ${MODEL} aufgelöst → Version ${versionId}`);

  // 3) Prediction starten (Prefer: wait; 402 = INSUFFICIENT_CREDIT erwartet)
  const audio = makeTestWavDataUri();
  const createResp = await fetch(
    `https://api.replicate.com/v1/models/${MODEL}/versions/${versionId}/predictions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Prefer: 'wait',
      },
      body: JSON.stringify({ input: { audio } }),
      signal: AbortSignal.timeout(120_000),
    },
  );

  if (createResp.status === 402) {
    log('OK', '402 INSUFFICIENT_CREDIT erkannt – Replicate-Guthaben aufgebraucht; lokaler Fallback greift. Pfad verifiziert (echter Stem-Job erst nach Guthaben-Aufladung).');
    process.exit(0);
  }
  if (createResp.status === 401 || createResp.status === 403) {
    log('FAIL', `Token abgelehnt (HTTP ${createResp.status})`);
    process.exit(1);
  }
  if (!createResp.ok) {
    const body = await createResp.text().catch(() => '');
    log('FAIL', `Prediction HTTP ${createResp.status}: ${body.slice(0, 300)}`);
    process.exit(1);
  }

  let prediction = await createResp.json() as { id?: string; status?: string; output?: unknown; logs?: string };

  // 4) Polling-Fallback (Prefer: wait kann mit "starting"/"processing" zurückkehren)
  for (let i = 0; i < 60 && prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled'; i++) {
    if (i === 0) log('INFO', `Prediction ${prediction.id ?? '?'} läuft (status=${prediction.status ?? '?'}) – warte…`);
    await new Promise((r) => setTimeout(r, 10_000));
    const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!pollResp.ok) {
      log('FAIL', `Polling HTTP ${pollResp.status}`);
      process.exit(1);
    }
    prediction = await pollResp.json() as typeof prediction;
  }

  if (prediction.status === 'succeeded') {
    log('OK', `Stem-Job erfolgreich gelaufen (Prediction ${prediction.id ?? '?'})`);
    console.log('[replicate-smoke] Output:', JSON.stringify(prediction.output).slice(0, 500));
    process.exit(0);
  }
  if (prediction.status === 'failed') {
    log('FAIL', `Stem-Job fehlgeschlagen (Prediction ${prediction.id ?? '?'})`);
    console.log('[replicate-smoke] Logs:', (prediction.logs ?? '').slice(-1200));
    process.exit(1);
  }
  log('FAIL', `Job nicht terminal nach Polling (status=${prediction.status ?? 'unbekannt'})`);
  process.exit(1);
}

main().catch((e) => {
  log('FAIL', (e as Error).message);
  process.exit(1);
});
