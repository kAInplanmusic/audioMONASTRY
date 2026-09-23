/**
 * QUAL-P3-002: Reproduktion des verlorenen Chunk-Eintrags beim parallelen Upload.
 *
 * Hypothese: `ChunkedUploadStore.writeChunk()` liest die Metadaten, schreibt die
 * Chunk-Daten und baut die Metadaten danach per read-modify-write NEU auf
 * (`{ ...meta, chunks: { ...meta.chunks, [index]: laenge } }`). Zwei gleichzeitige
 * Chunk-Schreibvorgaenge auf dieselbe Sitzung lesen also denselben Ausgangsstand,
 * und der zweite ueberschreibt den Eintrag des ersten - ein verlorener Eintrag.
 *
 * Zusaetzlich: `readMeta()` meldet JEDEN Lesefehler als UNKNOWN_UPLOAD. Ein
 * gleichzeitiges `status()` waehrend eines Schreibvorgangs kann deshalb
 * "unbekannte Upload-Sitzung" melden, obwohl die Sitzung existiert.
 *
 * Der Skript benutzt die echte Klasse in einem temporaeren Verzeichnis: keine
 * Datenbank, kein Netz, kein HTTP.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChunkedUploadStore } from '../server/chunkedUpload';

const CHUNK = 1024;
const TEILE = 8;

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'chunkupload-race-'));
  const store = new ChunkedUploadStore(dir);

  try {
    const { meta } = await store.init({
      filename: 'probe.bin',
      size: CHUNK * TEILE,
      chunkSize: CHUNK,
      contentType: 'application/octet-stream',
    });

    // Alle Teile GLEICHZEITIG - so verhaelt sich ein Client mit parallelen
    // Verbindungen, und genau das erlaubt die Schnittstelle auch.
    const ergebnisse = await Promise.allSettled(
      Array.from({ length: TEILE }, (_, i) => store.writeChunk(meta.uploadId, i, Buffer.alloc(CHUNK, i))),
    );

    const fehlgeschlagen = ergebnisse.filter((e) => e.status === 'rejected');
    const nachher = await store.readMeta(meta.uploadId);
    const eingetragen = Object.keys(nachher.chunks ?? {}).length;
    const status = await store.status(meta.uploadId);

    console.log(`Chunks gesendet       : ${TEILE}`);
    console.log(`Schreibvorgaenge ok   : ${TEILE - fehlgeschlagen.length}`);
    console.log(`davon mit Fehler      : ${fehlgeschlagen.length}`);
    console.log(`Eintraege in Metadaten: ${eingetragen}   (erwartet: ${TEILE})`);
    console.log(`status.missingChunks  : ${status.missingChunks.length}`);
    console.log('');
    if (eingetragen < TEILE) {
      console.log(`VERLORENER EINTRAG: ${TEILE - eingetragen} von ${TEILE} Chunks fehlen in den Metadaten,`);
      console.log('obwohl ihre Daten geschrieben wurden. Ein Client, der genau diese');
      console.log('Chunks gesendet hat, muss sie erneut senden - oder der Upload gilt');
      console.log('als unvollstaendig.');
      return 1;
    }
    console.log('Alle Eintraege vorhanden - kein Verlust in dieser Messung.');
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Abbruch:', error);
    process.exit(2);
  });
