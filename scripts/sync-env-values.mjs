#!/usr/bin/env node
/**
 * Wichtige Werte aus .env in die Ziel-Env-Dateien uebernehmen.
 *
 * WARUM MIT AUSDRUECKLICHER LISTE
 * -------------------------------
 * `.env` hat 69 Schluessel, `.env.portal`/`.env.deploy` hatten je 28 bzw. 27.
 * Ein blindes "alles rueberkopieren" waere falsch:
 *   * Die Zieldateien benutzen TEILS ANDERE NAMEN als der Code liest
 *     (`CF_S3_ACCESS_KEY` statt `CFS3_ACCESS_KEY`, `SB_API_KEY` statt `SB_ANON_PUB`).
 *     Genau daran scheiterte `POST /api/wire-fleet` mit "Cloudflare-Zone nicht
 *     gefunden": der Wert war da, der NAME passte nicht.
 *   * Verwaltungs-Token (SUPABASE_PAT, SB_PAT, SQ_PERSONAL_TOKEN) gehoeren
 *     NICHT auf jeden Flotten-Knoten. Sie werden hier bewusst nicht kopiert.
 *
 * REGELN
 * ------
 *   1. Es wird nur ERGAENZT. Vorhandene Werte bleiben unangetastet - ausser bei
 *      den unten einzeln begruendeten Ausnahmen.
 *   2. Jeder Wert wird in Anfuehrungszeichen gesetzt, wenn die Shell ihn sonst
 *      zerlegen wuerde. Die Zieldateien werden von den Flotten-Skripten per
 *      `source` GELESEN: `LEGAL_NAME=Patrick Hilf` fuehrt dort "Hilf" als Befehl
 *      aus (exit 127). Das ist am 2026-09-23 passiert und vom Gate gefunden.
 *   3. Vorgabe ist der Trockenlauf; geschrieben wird nur mit --apply.
 *
 * Aufruf: node scripts/sync-env-values.mjs [--apply]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const Q = String.fromCharCode(34); // doppeltes Anfuehrungszeichen

/** Werte, die die App zur Laufzeit braucht - Zielname -> Quellname in .env. */
const UEBERNEHMEN = {
  // --- Supabase ---
  SB_URL: 'SB_URL',
  SB_SERVICE_ROLE: 'SB_SERVICE_ROLE',
  SB_ANON_PUB: 'SB_ANON_PUB',
  SB_PUBLISHABLE: 'SB_PUBLISHABLE',
  SB_PROJECT_ID: 'SB_PROJECT_ID',
  SB_REST_ENDPOINT: 'SB_REST_ENDPOINT',
  SUPABASE_URL: 'SUPABASE_URL',
  VITE_SUPABASE_URL: 'VITE_SUPABASE_URL',
  VITE_SUPABASE_ANON_PUB: 'VITE_SUPABASE_ANON_PUB',

  // --- Cloudflare R2 (der Code liest CFS3_*) ---
  CFS3_ACCESS_KEY: 'CFS3_ACCESS_KEY',
  CFS3_SECRET_KEY: 'CFS3_SECRET_KEY',
  CFS3_ENDPOINT: 'CFS3_ENDPOINT',
  CFS3_BUCKET: 'CFS3_BUCKET',
  CFR2_ACCOUNT_ID: 'CFR2_ACCOUNT_ID',
  CFR2_PUBLIC_URL: 'CFR2_PUBLIC_URL',
  CFS3_PUBLIC_URL: 'CFR2_PUBLIC_URL',
  VITE_CFR2_PUBLIC_URL: 'CFR2_PUBLIC_URL',
  VITE_CFR2_ACCOUNT_ID: 'CFR2_ACCOUNT_ID',
  VITE_CFS3_BUCKET: 'CFS3_BUCKET',

  // --- Cloudflare-API ---
  CF_API_TOKEN: 'CF_API_TOKEN',
  CF_ACCOUNT_ID: 'CF_ACCOUNT_ID',
  CF_TOKEN_UT: 'CF_TOKEN_UT',
  CF_TOKEN_ACCOUNT: 'CF_TOKEN_ACCOUNT',

  // --- App-Betrieb ---
  STUDIO_ACCESS_TOKEN: 'STUDIO_ACCESS_TOKEN',
  SESSION_SECRET: 'SESSION_SECRET',
  ADMIN_USER: 'ADMIN_USER',
  ADMIN_PASSWORD: 'ADMIN_PASSWORD',
  CSP_MODE: 'CSP_MODE',
  DOMAIN: 'DOMAIN',
  APP_URL: 'APP_URL',
  IDLE_SHUTDOWN_MINUTES: 'IDLE_SHUTDOWN_MINUTES',
  TURN_URLS: 'TURN_URLS',
  TURN_STATIC_AUTH_SECRET: 'TURN_STATIC_AUTH_SECRET',
  HCLOUD_TOKEN: 'HCLOUD_TOKEN',
  DNS_HC_TOKEN: 'DNS_HC_TOKEN',

  // --- AI-Laufzeit (die Flotte braucht sie) ---
  RP_API_KEY: 'RP_API_KEY',
  RP_ENDPOINT_ID_BRAIN: 'RP_ENDPOINT_ID_BRAIN',
  RP_ENDPOINT_ID_EARS: 'RP_ENDPOINT_ID_EARS',
  RP_ENDPOINT_ID_VOICE: 'RP_ENDPOINT_ID_VOICE',
  RP_ENDPOINT_ID_MUSIC: 'RP_ENDPOINT_ID_MUSIC',
  RP_ENDPOINT_ID_ORCHESTRATOR: 'RP_ENDPOINT_ID_ORCHESTRATOR',
  RP_ENDPOINT_ID_IMAGE: 'RP_ENDPOINT_ID_IMAGE',
  RP_ENDPOINT_ID_VIDEO_REAL: 'RP_ENDPOINT_ID_VIDEO_REAL',
  RP_ENDPOINT_ID_VIDEO_ABSTRACT: 'RP_ENDPOINT_ID_VIDEO_ABSTRACT',
  RP_BRAIN_OPENAI_URL: 'RP_BRAIN_OPENAI_URL',
  RP_S3_ACCESS_KEY: 'RP_S3_ACCESS_KEY',
  RP_S3_SECRET_KEY: 'RP_S3_SECRET_KEY',
  DEEPSEEK_API_KEY: 'DEEPSEEK_API_KEY',
  HF_TOKEN: 'HF_TOKEN',
  HF_API_KEY: 'HF_API_KEY',

  // --- Rechtstexte (das Impressum wird aus der Env gerendert) ---
  LEGAL_NAME: 'LEGAL_NAME',
  LEGAL_STREET: 'LEGAL_STREET',
  LEGAL_CITY: 'LEGAL_CITY',
  LEGAL_COUNTRY: 'LEGAL_COUNTRY',
  LEGAL_EMAIL: 'LEGAL_EMAIL',
  LEGAL_REPRESENT: 'LEGAL_REPRESENT',
  LEGAL_SUPERVISORY: 'LEGAL_SUPERVISORY',
};

/**
 * Namen, deren VORHANDENER Wert ueberschrieben werden darf - mit Begruendung.
 *
 * `CLOUDFLARE_API_TOKEN`: genau diesen Namen liest der Portal-Worker
 * (services/portal-worker/src/index.js:555). Der alte Wert hatte kein DNS-Recht,
 * deshalb scheiterte die Verdrahtung mit "Cloudflare-Zone nicht gefunden"
 * (PROD-P0-F1). Jetzt steht dort das neue, gemessene Token.
 */
const DARF_UEBERSCHREIBEN = new Set(['CLOUDFLARE_API_TOKEN']);

/** Bewusst NICHT uebernommen - erscheint im Bericht. */
const NICHT_UEBERNEHMEN = {
  SUPABASE_PAT: 'Verwaltungs-Token: gehoert nicht auf jeden Knoten',
  SB_PAT: 'Verwaltungs-Token: gehoert nicht auf jeden Knoten',
  SQ_PERSONAL_TOKEN: 'Verwaltungs-Token: gehoert nicht auf jeden Knoten',
  HOS_S3_ACCESS_KEY: 'anderer Speicher (Hetzner Object Storage)',
  HOS_S3_SECRET_KEY: 'anderer Speicher (Hetzner Object Storage)',
  HOS_S3_BUCKET: 'anderer Speicher (Hetzner Object Storage)',
  HOS_S3_ENDPOINT: 'anderer Speicher (Hetzner Object Storage)',
  CFS3_PUBLIC_KEY: 'kein Konsument im Code gefunden',
  AI_MOS_MIN_RATINGS: 'lokaler Schwellwert der Testumgebung',
  RUNPOD_TEMPLATE_NAME_MUSIC: 'Werkzeug zum Anlegen von Templates',
  RUNPOD_TEMPLATE_NAME_VIDEO_ABSTRACT: 'Werkzeug zum Anlegen von Templates',
  GHCR_TOKEN: 'Registry-Zugang: nur im Deploy-Schritt noetig',
  GHCR_PASSWORD: 'Registry-Zugang: nur im Deploy-Schritt noetig',
};

/** Braucht der Wert Anfuehrungszeichen, damit die Shell ihn nicht zerlegt? */
const BRAUCHT_ZITAT = new RegExp('[\\s' + Q + "'`$\\\\#!*?()\\[\\]{}|&;<>~]");

function zitat(wert) {
  if (wert === '') return '';
  if (!BRAUCHT_ZITAT.test(wert)) return wert;
  const maskiert = wert.replace(new RegExp('([' + Q + '\\\\$`])', 'g'), '\\\\$1');
  return Q + maskiert + Q;
}

function entzitat(wert) {
  const t = wert.trim();
  if (t.length >= 2 && ((t[0] === Q && t[t.length - 1] === Q) || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return wert;
}

function lies(datei) {
  const map = new Map();
  let inhalt = '';
  try {
    inhalt = readFileSync(datei, 'utf8');
  } catch {
    return { map, inhalt: null };
  }
  for (const zeile of inhalt.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(zeile.trim());
    if (m) map.set(m[1], m[2]);
  }
  return { map, inhalt };
}

const quelle = lies('.env').map;

for (const ziel of ['.env.portal', '.env.deploy']) {
  const { map: vorhanden, inhalt } = lies(ziel);
  if (inhalt === null) {
    console.log(`\n${ziel}: existiert nicht - uebersprungen`);
    continue;
  }
  const setzen = [];
  const schonDa = [];
  const unangetastet = [];

  for (const [zielName, quellName] of Object.entries(UEBERNEHMEN)) {
    const wert = quelle.get(quellName);
    if (wert === undefined || entzitat(wert) === '') continue;
    const soll = zitat(entzitat(wert));
    const alt = vorhanden.get(zielName);
    if (alt === undefined) {
      setzen.push([zielName, soll, 'neu']);
    } else if (alt === soll) {
      schonDa.push(zielName);
    } else if (entzitat(alt) === entzitat(wert)) {
      setzen.push([zielName, soll, 'quotiert']);
    } else if (DARF_UEBERSCHREIBEN.has(zielName)) {
      setzen.push([zielName, soll, 'aktualisiert']);
    } else {
      unangetastet.push(zielName);
    }
  }

  console.log(`\n=== ${ziel} ===`);
  console.log(`  unveraendert:                ${schonDa.length}`);
  console.log(`  vorhanden, NICHT angetastet: ${unangetastet.length}${unangetastet.length ? ` (${unangetastet.slice(0, 8).join(', ')}${unangetastet.length > 8 ? ' …' : ''})` : ''}`);
  console.log(`  zu setzen:                   ${setzen.length}`);
  for (const [name, , art] of setzen) console.log(`    ${art === 'neu' ? '+' : art === 'quotiert' ? 'q' : '~'} ${name}`);

  if (!APPLY || setzen.length === 0) continue;

  let neu = inhalt;
  for (const [name, wert] of setzen) {
    const zeile = new RegExp(`^${name}=.*$`, 'm');
    if (zeile.test(neu)) neu = neu.replace(zeile, `${name}=${wert}`);
    else neu = neu.replace(/\n?$/, `\n${name}=${wert}\n`);
  }
  writeFileSync(ziel, neu, 'utf8');
  console.log(`  -> geschrieben (${setzen.length})`);
}

console.log('\n=== Bewusst NICHT uebernommen ===');
for (const [name, grund] of Object.entries(NICHT_UEBERNEHMEN)) {
  if (quelle.has(name)) console.log(`    ${name}: ${grund}`);
}
if (!APPLY) console.log('\nTrockenlauf - mit --apply wirklich schreiben.');
