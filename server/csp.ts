/**
 * audioMONASTRY · Content-Security-Policy (F7-Fix)
 * ================================================
 * Vorher: genau EIN Header, fest im Code, `Content-Security-Policy-Report-Only`,
 * dessen `connect-src` mit `https:` und `wss:` praktisch ALLES erlaubte
 * (jedes Ziel, jedes Protokoll) – der Header war damit Dekoration, und weil
 * KEIN `report-uri` gesetzt war, landeten Verstöße nur in der Browser-Konsole
 * (server.ts, S-7). Der Audit-Befund war entsprechend: „Report-Only-Inhalt
 * prüfen, connect-src auf die wirklich genutzten Hosts begrenzen".
 *
 * Hier wird die Policy deshalb:
 *   1. aus der TATSAECHLICHEN Umgebung abgeleitet (Domains/URLs der Installation:
 *      eigene Origine, Supabase/R2-Medien, Flotten-Ziele, Modell-Provider) statt
 *      pauschal `https:`/`wss:`;
 *   2. per `CSP_MODE=enforce` scharf schaltbar – und per `CSP_MODE=report-only`
 *      (Default) weiter beobachtbar;
 *   3. mit einem ECHTEN Meldeziel versehen (`/api/security/csp-report`), damit
 *      "welche Verstöße will ich vorher sehen" beantwortbar ist statt geraten.
 *
 * Default bleibt bewusst `report-only`: die verbleibenden Unsicherheiten sind
 * hosting-abhaengig (Medien von R2/Supabase, WSS-Hosts der SFU/Fleet, ein
 * browser-seitiges lokales Ollama am Operator-Rechner) und waren nicht durch
 * einen einzigen Lauf verifizierbar. Mit Meldeziel ist die Umstellung jetzt eine
 * Betreiber-Entscheidung auf Datenbasis (`CSP_MODE=enforce`), kein Blindflug.
 *
 * --- Drahtformate des Browsers (2026-09-21 mit echtem Chrome 153 gemessen) ----
 * Der Meldeweg ist seit F7 vorhanden – die DATEN fehlten. Der lokale Beweislauf
 * (Policy der App, echtes Chrome, Recorder am Meldeziel) hat zwei Dinge gezeigt,
 * die den Meldeweg praktisch leer liessen:
 *
 *   1. Es gibt zwei Drahtformate, und der Browser waehlt das zweite, sobald die
 *      Policy `report-to` nennt (so wie diese Policy):
 *        * `report-uri`      → `application/csp-report`, EIN Objekt unter
 *          `csp-report`, Schluessel mit Bindestrich (`violated-directive`,
 *          `blocked-uri`, `document-uri`) – und EINE Meldung je Verstoss.
 *        * `report-to`/Reporting-API → `application/reports+json`, ein ARRAY von
 *          `{ age, type: 'csp-violation', body: {…} }` mit camelCase-Schluesseln
 *          (`effectiveDirective`, `blockedURL`, `documentURL`, `sourceFile`) –
 *          und MEHRERE Meldungen in EINEM POST (gemessen: 2 in einem Body).
 *      Wer nur die Altform liest, verwirft jede Meldung aus dem modernen Weg.
 *   2. Ueber `http://` liefert Chrome die Reporting-API stillschweigend nicht aus
 *      (gemessen: `report-uri` allein → Meldung kommt; `report-to` dabei → 0
 *      Meldungen; dieselbe Konfiguration ueber `https://` → Meldung kommt).
 *      Im Betrieb (HTTPS ueber Caddy) greift deshalb der moderne Weg; lokal
 *      ueber HTTP sieht man nur den Altweg. Fuer die Beobachtung heisst das:
 *      zaehlen/auswerten muss den MODERNEN Weg koennen, sonst ist die
 *      Enforce-Entscheidung weiter blind.
 */

/** Modi: beobachten (Default) oder durchsetzen. */
export type CspMode = 'report-only' | 'enforce';

/** Pfad, an den der Browser CSP-Verstöße meldet (siehe securityRoutes). */
export const CSP_REPORT_PATH = '/api/security/csp-report';

/**
 * Modell-Provider, die der Browser (LlmRouter, OpenAI-kompatible Clients)
 * direkt anspricht. Bewusst NAMENTLICH – kein `https:`-Wildcard. Nur Hosts,
 * keine Keys; Provider-Keys bleiben serverseitig (AGENTS.md §4.5).
 */
const PROVIDER_HOSTS = [
  'https://api.deepseek.com',
  'https://router.huggingface.co',
  'https://api-inference.huggingface.co',
  'https://*.endpoints.huggingface.cloud',
  'https://api.openai.com',
  'https://api.mistral.ai',
  'https://api.groq.com',
];

/**
 * Env-Variablen, die auf HTTP(S)-Ziele der Installation zeigen.
 *
 * Die `VITE_*`-Einträge sind die vom Client tatsächlich benutzten Ziele
 * (`src/config/runtime.ts`): nur wenn der Betreiber die API/das Signaling auf
 * einen ANDEREN Host legt, erscheinen sie. Ohne sie fehlte genau dieser Host in
 * `connect-src` – eine scharfe Policy hätte die Signalisierung gekappt, während
 * die Report-Only-Policy es nur gemeldet hätte. Sind sie nicht gesetzt, ändert
 * sich nichts (Default = gleiche Origin, deckt `'self'` ab).
 */
const URL_ENV_KEYS = [
  'BACKEND_CORE_URL',
  'MASTER_PLAYER_URL',
  'STEM_AI_URL',
  'OLLAMA_URL',
  'SUPABASE_URL',
  'SB_URL',
  'VITE_SB_URL',
  // Browser-Alias derselben Supabase-URL (src/lib/cloudConfig.ts:38) - die
  // kanonische Liste kennt `VITE_SUPABASE_URL` gleichberechtigt.
  'VITE_SUPABASE_URL',
  'CFR2_PUBLIC_URL',
  // Browser-Alias der R2-Public-URL (src/lib/cloudConfig.ts:48).
  'VITE_CFR2_PUBLIC_URL',
  /**
   * SFU-Signalisierung: der Server reicht `SFU_SIGNALING_URL` als `sfu.url` an
   * den Client durch (`/api/webrtc-config`, server/webrtcConfig.ts), und der
   * Client verbindet sich per socket.io (HTTP-Polling + WebSocket) zu GENAU
   * diesem Host – siehe src/core/transport/sfuEndpoint.ts. Der Host liegt auf
   * einem eigenen Namen (z. B. `sfu.<domain>`) und ist damit NICHT von `'self'`
   * oder der eigenen Domain gedeckt; ohne diesen Eintrag kappt eine scharfe
   * Policy die SFU-Signalisierung (im lokalen Lauf gemessen: der laufende
   * Header enthielt `https://sfu.anunnakitools.de` NICHT, obwohl die Variable
   * gesetzt war).
   */
  'SFU_SIGNALING_URL',
  'VITE_SFU_URL',
  // Client-seitige (Build-Zeit-)Ziele – siehe src/config/runtime.ts.
  'VITE_API_BASE_URL',
  'VITE_SOCKET_IO_SIGNALING_URL',
  'VITE_SIGNALING_WS_URL',
  'VITE_SIGNALING_HTTP_URL',
  'VITE_SIGNALING_TRANSPORT_URL',
];

/** Env-Variablen mit CSV von Origins (z. B. `https://app.example,http://localhost:5173`). */
const ORIGIN_ENV_KEYS = ['API_ALLOWED_ORIGINS', 'SIGNALING_ALLOWED_ORIGINS', 'CSP_ALLOWED_ORIGINS'];

/**
 * R2-Anbindung: Account-ID und Bucket, aus denen der Client seinen S3-Endpunkt
 * SELBST bildet (`src/lib/cloudConfig.ts:53`:
 * `https://<bucket>.<account>.r2.cloudflarestorage.com`). Dieselbe Ableitung
 * hier, damit die Policy den Host kennt, den der Browser tatsaechlich anspricht
 * (Presign-/Upload-Pfade) – und weil `src/utils/mediaUrlGuard.ts` genau diesen
 * Host als vertrauenswuerdiges Medienziel durchlaesst.
 */
const R2_ACCOUNT_ENV_KEYS = ['CFR2_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID', 'VITE_CFR2_ACCOUNT_ID'];
const R2_BUCKET_ENV_KEYS = ['CFS3_BUCKET', 'CFR2_BUCKET', 'VITE_CFS3_BUCKET', 'VITE_CFR2_BUCKET'];

export type EnvLike = Record<string, string | undefined>;

/** `https://host[:port]` einer einzelnen URL – ohne Pfad/Query; '' wenn unbrauchbar. */
export function hostSource(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'wss:' && url.protocol !== 'ws:') {
      return '';
    }
    // ws/wss werden als wss-Origin geführt: WebSocket-Ziele gehören in
    // `connect-src` (dort zählt das ws-Schema, siehe buildConnectSources).
    const scheme = url.protocol === 'http:' || url.protocol === 'ws:' ? 'http' : 'https';
    return `${scheme}://${url.host}`;
  } catch {
    return '';
  }
}

/** S3-Endpunkt des R2-Buckets – dieselbe Ableitung wie im Client (cloudConfig.ts). */
function r2BucketHost(env: EnvLike): string {
  const firstValue = (keys: string[]) =>
    keys.map((key) => String(env[key] ?? '').trim()).find((value) => value.length > 0) ?? '';
  const account = firstValue(R2_ACCOUNT_ENV_KEYS);
  const bucket = firstValue(R2_BUCKET_ENV_KEYS);
  // Nur zeichengueltige Werte: ein leeres/unsinniges Paar darf keine kaputte
  // CSP-Quelle erzeugen (die der Browser dann verwirft - stiller Fehler).
  if (!/^[a-z0-9-]{3,64}$/i.test(account) || !/^[a-z0-9.-]{3,63}$/i.test(bucket)) return '';
  return `https://${bucket}.${account}.r2.cloudflarestorage.com`;
}

/** Alle Hosts, die diese Installation kennt (dedupliziert, ohne Wildcard). */
export function collectPolicyHosts(env: EnvLike): string[] {
  const hosts = new Set<string>();
  const add = (value: unknown) => {
    for (const part of String(value ?? '').split(',')) {
      const host = hostSource(part);
      if (host) hosts.add(host);
    }
  };
  // Eigene Domain (Caddy) – Anmeldung/API/Signaling laufen über sie.
  const domain = String(env.DOMAIN ?? '').trim();
  if (domain && !domain.startsWith(':') && domain !== 'localhost') add(`https://${domain}`);
  for (const key of URL_ENV_KEYS) add(env[key]);
  for (const key of ORIGIN_ENV_KEYS) {
    for (const part of String(env[key] ?? '').split(',')) {
      const origin = String(part).trim();
      if (origin && origin !== '*' && origin.includes('://')) add(origin);
    }
  }
  // Zusatz-Hosts des Betreibers (CSV von Origins oder nackten Hosts).
  for (const part of String(env.CSP_ALLOWED_HOSTS ?? '').split(',')) add(String(part).trim());
  // R2-S3-Endpunkt, den der Client aus Account+Bucket bildet.
  const r2 = r2BucketHost(env);
  if (r2) hosts.add(r2);
  // DEV/Zusatz: 'none' ist der Schalter, um die eingebauten Provider-Hosts
  // abzuwaehlen (wer sie nicht braucht, bekommt eine engere Policy).
  return [...hosts].sort();
}

/**
 * `connect-src`-Quellen: `'self'`, Blob, Hosts (http+https) und deren wss-Variante.
 *
 * `CSP_CONNECT_SRC` übersteuert die Ableitung komplett (Betreiber-Notausgang,
 * z. B. für eine Sonderinstallation). Getrennt wird an Komma UND Leerraum –
 * CSP-Quellenlisten sind per Spezifikation leerzeichengetrennt, die übrigen
 * Env-Listen dieses Projekts kommagetrennt; beide Schreibweisen müssen
 * funktionieren, sonst wird die Notausgangs-Liste still zu EINEM ungültigen
 * Eintrag (vom Test tests/cspPolicy.test.ts aufgedeckt).
 */
export function buildConnectSources(env: EnvLike): string[] {
  const override = String(env.CSP_CONNECT_SRC ?? '').trim();
  if (override) return override.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const sources = new Set<string>(['\'self\'', 'blob:']);
  for (const host of collectPolicyHosts(env)) {
    sources.add(host);
    if (host.startsWith('https://')) sources.add(host.replace('https://', 'wss://'));
    if (host.startsWith('http://')) sources.add(host.replace('http://', 'ws://'));
  }
  if (String(env.CSP_ALLOW_PROVIDER_HOSTS ?? '1') !== '0') {
    for (const host of PROVIDER_HOSTS) sources.add(host);
  }
  return [...sources];
}

/** Ist die Policy im meldenden Modus? Default: ja (Verhalten der Installation). */
export function resolveCspMode(env: EnvLike): CspMode {
  const raw = String(env.CSP_MODE ?? '').trim().toLowerCase();
  return raw === 'enforce' ? 'enforce' : 'report-only';
}

export interface CspPolicy {
  mode: CspMode;
  /** Header-Name je Modus: derselbe Inhalt, andere Wirkung. */
  headerName: 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only';
  value: string;
}

/**
 * Baut die Policy. Deterministisch (Sortierung stabil), damit Tests und
 * Betreiber-Diff denselben Text sehen.
 */
export function buildCspPolicy(env: EnvLike): CspPolicy {
  const mode = resolveCspMode(env);
  const hostSources = collectPolicyHosts(env);
  const connect = buildConnectSources(env);
  const mediaList = hostSources.length > 0 ? ` ${hostSources.join(' ')}` : '';
  const directives: string[] = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // AudioWorklets/WASM brauchen 'wasm-unsafe-eval' und blob-Worker.
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${mediaList}`,
    `media-src 'self' blob: data:${mediaList}`,
    `connect-src ${connect.join(' ')}`,
    // Meldeziel: ohne report-uri landen Verstoesse nur in der Browser-Konsole.
    // `report-to default` bindet zusaetzlich die moderne Reporting-API an die
    // Gruppe aus `Reporting-Endpoints` (buildReportingHeaders) - sonst wuerde nur
    // der Altweg `report-uri` bedient und die Browser, die report-to nutzen,
    // meldeten weiter ins Leere.
    `report-uri ${CSP_REPORT_PATH}`,
    'report-to default',
  ];
  return {
    mode,
    headerName: mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
    value: directives.join('; '),
  };
}

/**
 * Kopf-Header fuer den Meldeweg: `Reporting-Endpoints` nennt die Gruppe,
 * `report-to` bindet die Policy daran (moderne Browser), `report-uri` bleibt
 * fuer aeltere. Beides derselbe Pfad.
 */
export function buildReportingHeaders(): Record<string, string> {
  return {
    'Reporting-Endpoints': `default="${CSP_REPORT_PATH}"`,
  };
}

export interface CspViolationSummary {
  /** Verletzte Direktive, z. B. `connect-src`. */
  directive: string;
  /** Blockiertes Ziel – nur der HOST, nie der volle Pfad/Query. */
  blockedHost: string;
  /** Dokument, in dem es passierte – nur der HOST. */
  documentHost: string;
  /**
   * CSP-Sonderwert statt Host: Chrome meldet `inline`, `eval`, `data`, `blob`
   * (z. B. Favicon als `data:`-URI oder ein Inline-Skript). Ohne dieses Feld
   * waeren genau die haeufigsten Artefakte im Zaehler nicht unterscheidbar.
   */
  blockedKeyword: string;
}

function hostOf(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

/** CSP-Sonderwerte, die der Browser statt einer URL meldet (gemessen). */
const CSP_TARGET_KEYWORDS = new Set([
  'inline',
  'eval',
  'data',
  'blob',
  'self',
  'wasm-eval',
  'javascript',
  'about',
  'filesystem',
]);

/** Ziel eines Verstosses: Host ODER CSP-Sonderwert (nie beides). */
function blockedTargetOf(raw: unknown): { host: string; keyword: string } {
  const value = String(raw ?? '').trim();
  if (!value) return { host: '', keyword: '' };
  const bare = value.replace(/:$/, '').toLowerCase();
  if (CSP_TARGET_KEYWORDS.has(bare)) return { host: '', keyword: bare };
  return { host: hostOf(value), keyword: '' };
}

/**
 * Feld aus einem Report lesen: die Reporting-API schreibt camelCase
 * (`effectiveDirective`, `blockedURL`, `documentURL`), der Altweg `report-uri`
 * Bindestrich-Schluessel (`effective-directive`, `blocked-uri`, `document-uri`).
 * Beide Formen werden bedient.
 */
function reportField(report: Record<string, unknown>, camel: string, dashed: string): unknown {
  return report[camel] ?? report[dashed];
}

/**
 * Fasst EINEN Report auf das Nötige zusammen: Direktive + Hosts, keine
 * vollen URLs (die können Query-Parameter mit Daten tragen). Unbekannte Formate
 * ergeben `null` – der Endpunkt antwortet trotzdem 204 (kein Feedback an
 * Angreifer über akzeptierte Formate).
 */
export function summarizeCspReport(body: unknown): CspViolationSummary | null {
  return summarizeCspReports(body)[0] ?? null;
}

/**
 * Wie `summarizeCspReport`, aber für ALLE Meldungen eines Bodies.
 *
 * Die Reporting-API schickt ein ARRAY und bündelt mehrere Verstoesse in EINEM
 * POST (gemessen mit Chrome 153: ein POST enthielt `media-src` UND
 * `script-src-elem`). Wer nur das erste Element liest, verliert Verstoesse -
 * und genau die Summe entscheidet ueber `CSP_MODE=enforce`.
 */
export function summarizeCspReports(body: unknown): CspViolationSummary[] {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body)) return body.flatMap((entry) => summarizeCspReports(entry));
  const container = body as Record<string, unknown>;
  // Meldungstyp der Reporting-API: nur CSP-Verstoesse gehoeren hierher
  // (dieselbe Schnittstelle transportiert auch `deprecation`, `crash`, …).
  const type = String(container.type ?? '').trim();
  if (type && type !== 'csp-violation') return [];
  const raw = (container['csp-report'] ?? container.body ?? container) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const report = raw as Record<string, unknown>;
  // `effective-directive` gewinnt gegen `violated-directive`: das ist die
  // Direktive, die den Request tatsaechlich entschieden hat (Chrome setzt in
  // `violated-directive` teils eine weitere Fassung). Die -elem-Varianten
  // (`img-src-elem`, `script-src-elem`) bleiben bewusst erhalten - genau die
  // Direktive muss ein Betreiber im enforce-Fall lockern, und im Zaehler ist
  // damit sichtbar, welche Fassung greift.
  const directive = String(
    reportField(report, 'effectiveDirective', 'effective-directive')
    ?? reportField(report, 'violatedDirective', 'violated-directive')
    ?? '',
  ).split(' ')[0];
  if (!directive || !/^[a-z-]{3,40}$/.test(directive)) return [];
  const target = blockedTargetOf(reportField(report, 'blockedURL', 'blocked-uri'));
  return [{
    directive,
    blockedHost: target.host,
    documentHost: hostOf(reportField(report, 'documentURL', 'document-uri')),
    blockedKeyword: target.keyword,
  }];
}

/** Ziel eines Verstosses als Label fuer Log/Zaehler (`Host`, Sonderwert, sonst ''). */
export function cspViolationTarget(summary: CspViolationSummary): string {
  return summary.blockedHost || summary.blockedKeyword;
}

