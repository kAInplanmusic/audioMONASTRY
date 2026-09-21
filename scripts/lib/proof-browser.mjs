/**
 * Gemeinsame Bausteine der Live-Beweis-Skripte gegen eine LAUFENDE Instanz
 * ======================================================================
 * Die Skripte `scripts/*-proof.mjs` und `scripts/worklet-startup-verify.mjs`
 * messen gegen eine bereits laufende Instanz (lokal oder per SSH-Tunnel). Jedes
 * von ihnen brauchte bisher dieselbe Vorspann-Logik: Basis-URL, Studio-Token und
 * `sleep`. Sie liegt jetzt genau einmal hier.
 *
 * Aufruf-Muster bleibt unveraendert:
 *   E2E_BASE_URL=http://localhost:8080 node scripts/<name>.mjs
 */
import { readFileSync } from 'node:fs';

/** Basis-URL der zu messenden Instanz (ohne Schraegstrich am Ende). */
export const BASE = (process.env.E2E_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');

/**
 * Studio-Token aus der Umgebung, sonst aus der Repo-`.env` (Schluessel
 * `STUDIO_ACCESS_TOKEN`). Leerer String = kein Token (oeffentliche Routen).
 */
export const token = (() => {
  const fromEnv = (process.env.STUDIO_ACCESS_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  const line = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split('\n').find((l) => l.startsWith('STUDIO_ACCESS_TOKEN='));
  return (line?.slice('STUDIO_ACCESS_TOKEN='.length) ?? '').trim();
})();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
