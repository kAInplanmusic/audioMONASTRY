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
  'CFR2_PUBLIC_URL',
  // Client-seitige (Build-Zeit-)Ziele – siehe src/config/runtime.ts.
  'VITE_API_BASE_URL',
  'VITE_SOCKET_IO_SIGNALING_URL',
  'VITE_SIGNALING_WS_URL',
  'VITE_SIGNALING_HTTP_URL',
  'VITE_SIGNALING_TRANSPORT_URL',
];

/** Env-Variablen mit CSV von Origins (z. B. `https://app.example,http://localhost:5173`). */
const ORIGIN_ENV_KEYS = ['API_ALLOWED_ORIGINS', 'SIGNALING_ALLOWED_ORIGINS', 'CSP_ALLOWED_ORIGINS'];

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

/**
 * Fasst einen CSP-Report auf das Nötige zusammen: Direktive + Hosts, keine
 * vollen URLs (die können Query-Parameter mit Daten tragen). Unbekannte Formate
 * ergeben `null` – der Endpunkt antwortet trotzdem 204 (kein Feedback an
 * Angreifer über akzeptierte Formate).
 *
 * Zwei Formen werden bedient, weil der Meldeweg beide anbietet:
 *   * `report-uri`   → ein Objekt, verschachtelt unter `csp-report` (Legacy),
 *   * `report-to`/Reporting-API → ein ARRAY von `{ type, body }`-Meldungen.
 * Ohne die Array-Behandlung wäre der Meldeweg für genau die Browser stumm, die
 * die moderne Reporting-API nutzen (vom Test tests/cspPolicy.test.ts aufgedeckt).
 */
export function summarizeCspReport(body: unknown): CspViolationSummary | null {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body)) {
    for (const entry of body) {
      const summary = summarizeCspReport(entry);
      if (summary) return summary;
    }
    return null;
  }
  const container = body as Record<string, unknown>;
  const raw = (container['csp-report'] ?? container.body ?? container) as unknown;
  if (!raw || typeof raw !== 'object') return null;
  const report = raw as Record<string, unknown>;
  const directive = String(report['violated-directive'] ?? report['effective-directive'] ?? '').split(' ')[0];
  if (!directive || !/^[a-z-]{3,40}$/.test(directive)) return null;
  return {
    directive,
    blockedHost: hostOf(report['blocked-uri'] ?? report.blockedURL),
    documentHost: hostOf(report['document-uri'] ?? report.documentURL),
  };
}
