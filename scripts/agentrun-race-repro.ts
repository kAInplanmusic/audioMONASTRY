/**
 * QUAL-P2-008: Reproduktion des Wettlaufs im AgentRunStore.
 *
 * Hypothese: `save()` schreibt NICHT atomar (writeFile = truncate + write). Waehrend
 * der Lauf seinen Fortschritt speichert, kann ein gleichzeitiges `load()` eine halb
 * geschriebene Datei erwischen. `JSON.parse` wirft dann, und `load()` faengt den
 * Fehler und meldet `null` - also "unbekannter Lauf", obwohl der Datensatz existiert.
 *
 * Dieser Skript laeuft NUR, wenn er nicht datenbank- oder netzwerkabhaengig ist: er
 * benutzt die echte AgentRunStore-Klasse in einem temporaeren Verzeichnis.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunStore, type AgentRunRecord } from '../src/core/ai/agentRuns';

const dir = mkdtempSync(join(tmpdir(), 'agentrun-race-'));
const store = new AgentRunStore(dir);

/** Ein absichtlich grosser Datensatz: breiteres Zeitfenster fuer den Leser. */
function record(i: number): AgentRunRecord {
  return {
    runId: 'r2',
    task: 'Aufgabe',
    userId: 'u1',
    status: 'running',
    createdAt: 1,
    updatedAt: 1 + i,
    executedCount: i,
    steps: Array.from({ length: 200 }, (_, k) => ({
      stepId: `s${k}`,
      status: 'done',
      output: 'x'.repeat(500),
      durationMs: 1,
    })),
    corrections: 0,
    cost: { totalEur: 0, byProvider: {} },
    allowWrite: true,
  } as unknown as AgentRunRecord;
}

const RUNDEN = Number(process.env.RUNDEN ?? 400);

async function main(): Promise<void> {
  await store.save(record(0));

  let schreibvorgaenge = 0;
  let lesevorgaenge = 0;
  let leereAntworten = 0;
  let laeuft = true;

  // Schreiber: simuliert onStep() waehrend der Ausfuehrung.
  const schreiber = (async () => {
    for (let i = 1; i <= RUNDEN && laeuft; i += 1) {
      await store.save(record(i));
      schreibvorgaenge += 1;
    }
  })();

  // Leser: simuliert cancel() -> store.load().
  const leser = (async () => {
    while (laeuft) {
      const got = await store.load('r2');
      lesevorgaenge += 1;
      if (!got) leereAntworten += 1;
    }
  })();

  await schreiber;
  laeuft = false;
  await leser;

  const quote = ((leereAntworten / Math.max(1, lesevorgaenge)) * 100).toFixed(2);
  console.log(`Schreibvorgaenge : ${schreibvorgaenge}`);
  console.log(`Lesevorgaenge    : ${lesevorgaenge}`);
  console.log(`davon null       : ${leereAntworten}  (${quote} %)`);
  console.log('');
  if (leereAntworten > 0) {
    console.log('REPRODUZIERT: load() liefert null, obwohl der Datensatz existiert.');
    console.log('Der Aufrufer sieht "unbekannter Lauf" - genau der Fehler aus tests/agentRuns.test.ts:175.');
  } else {
    console.log('NICHT reproduziert in dieser Messung.');
  }

  rmSync(dir, { recursive: true, force: true });
  process.exit(leereAntworten > 0 ? 1 : 0);
}

void main();
