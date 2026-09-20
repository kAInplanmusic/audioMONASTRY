/**
 * audioMONASTRY · Cloudflare-R2-Konfiguration aus EINER Herkunft (FIX F2)
 * ======================================================================
 * Anlass (exakter App-Test 2026-09-20, F2): Auf app-1 lagen die R2-Zugangsdaten
 * in `CFS3_ACCESS_KEY_ID`/`CFS3_SECRET_ACCESS_KEY` – Namen, die der Server NIE
 * gelesen hat (erkenne: `server/cloud.ts` las `CFS3_ACCESS_KEY`/`CFS3_SECRET_KEY`).
 * Der Aufruf fiel damit STILL auf die zweite Herkunft (`CFR2_*` aus dem
 * Portal-Rollen-Env) zurück, und dieses Paar passte nicht zu Bucket/Endpoint →
 * `SignatureDoesNotMatch` in `/api/cloud/health`, Autosave und Upload.
 *
 * Genau zwei Dinge verhindert dieses Modul:
 *   1. **Stilles Ignorieren**: Jede bekannte Schreibweise wird gelesen; war die
 *      benutzte Schreibweise ein Alias (z. B. `CFS3_ACCESS_KEY_ID`), steht das
 *      als `usedEnvKeys` in der Health-Antwort und die Quelle wird benannt.
 *   2. **Widersprüchliche Quellen**: Liefern zwei gesetzte Variablen
 *      unterschiedliche Werte für dasselbe Feld, ist das eine Abweichung
 *      (`deviation`) – sie wird gemeldet, nicht stillschweigend priorisiert.
 *      Secret-Werte erscheinen dabei NIE im Klartext, nur als Fingerabdruck.
 *
 * Reine Funktion über einer Env-Map (kein `process.env`-Zugriff im Modul, keine
 * Seiteneffekte) – dadurch in Tests und im Betreiber-Skript identisch nutzbar.
 */
import { createHash } from 'node:crypto';

/** Env-Map (Prozess-Env, Rollen-Env, Test-Double). */
export type R2Env = Record<string, string | undefined>;

/**
 * Kanonische Namen (das, was ein Knoten-`.env` enthalten SOLL) und die
 * Alias-Schreibweisen, die weiterhin gelesen werden.
 *
 * Reihenfolge = Vorrang. `CFS3_*` steht vorn, weil das die in
 * `docs/ENV_MATRIX.md`/`.env.hetzner.example` dokumentierte kanonische Familie
 * ist und der Portal-Worker die Rollen-.env daraus schreibt.
 */
export const R2_ENV_ALIASES: Record<R2ConfigField, readonly string[]> = {
  accessKeyId: [
    'CFS3_ACCESS_KEY',
    // F2-Befund: diese Schreibweise stand live auf app-1 und wurde ignoriert.
    'CFS3_ACCESS_KEY_ID',
    'CFR2_ACCESS_KEY_ID',
    'CFR2_ACCESS_KEY',
    'CLOUDFLARE_ACCESS_KEY_ID',
  ],
  secretAccessKey: [
    'CFS3_SECRET_KEY',
    'CFS3_SECRET_ACCESS_KEY',
    'CFR2_SECRET_ACCESS_KEY',
    'CFR2_SECRET_KEY',
    'CLOUDFLARE_SECRET_ACCESS_KEY',
  ],
  endpoint: [
    'CFS3_ENDPOINT',
    'CFR2_ENDPOINT',
    'CFR2_URL',
  ],
  bucket: [
    'CFS3_BUCKET',
    'CFR2_BUCKET',
  ],
  publicUrl: [
    'CFS3_PUBLIC_URL',
    'CFR2_PUBLIC_URL',
  ],
  accountId: [
    'CFR2_ACCOUNT_ID',
    'CFS3_ACCOUNT_ID',
    'CLOUDFLARE_ACCOUNT_ID',
    'CF_ACCOUNT_ID',
  ],
};

export type R2ConfigField = 'accessKeyId' | 'secretAccessKey' | 'endpoint' | 'bucket' | 'publicUrl' | 'accountId';

/**
 * Kanonische Namen, die der Server aus der Rollen-/Knoten-`.env` erwartet.
 * `services/portal-worker` schreibt genau diese Namen (siehe
 * `tests/portalWorkerR2EnvParity.test.ts` – der Test hält beide Seiten zusammen,
 * damit Portal und Server nicht wieder auseinanderlaufen).
 */
export const R2_CANONICAL_ENV_KEYS = {
  accessKeyId: 'CFS3_ACCESS_KEY',
  secretAccessKey: 'CFS3_SECRET_KEY',
  endpoint: 'CFS3_ENDPOINT',
  bucket: 'CFS3_BUCKET',
  publicUrl: 'CFS3_PUBLIC_URL',
  accountId: 'CFR2_ACCOUNT_ID',
} as const;

/** Ein gesetzter Wert samt Herkunft (Name) – Wert nur als Fingerabdruck. */
export interface R2SourceValue {
  name: string;
  /** Erste 8 Hex-Zeichen von sha256(Wert) – identifiziert Werte, ohne sie zu zeigen. */
  fingerprint: string;
  /** Länge des Werts (Zahl, kein Inhalt) – hilft bei Copy-Paste-Fehlern. */
  length: number;
}

/** Widersprüchliche Werte für dasselbe Feld aus mehreren Env-Variablen. */
export interface R2Deviation {
  field: R2ConfigField;
  /** Env-Name, dessen Wert benutzt wurde (Vorrang). */
  chosen: string;
  /** Alle gesetzten Werte des Feldes; `values[0]` ist der benutzte. */
  values: R2SourceValue[];
}

/** Format einer S3-Kennung falsch (z. B. Access-Key mit falscher Länge). */
export type R2ConfigProblem =
  | 'access-key-missing'
  | 'secret-missing'
  | 'access-key-shape'
  | 'secret-shape'
  | 'bucket-missing'
  | 'endpoint-invalid'
  | 'endpoint-ignored-alias';

export interface R2Config {
  /** Alle Pflichtfelder vorhanden UND plausibel geformt. */
  configured: boolean;
  /** Zugangspaar (Access Key + Secret) vollständig vorhanden. */
  hasCredentials: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  accountId: string;
  region: string;
  publicBaseUrl: string | null;
  /** Env-Namen, die die benutzten Werte geliefert haben (Nachweis „eine Herkunft“). */
  usedEnvKeys: string[];
  /** Gesetzte, aber NICHT benutzte Varianten (Aliase/Auffüller). */
  ignoredEnvKeys: string[];
  /** Nicht leer ⇒ zwei Quellen widersprechen sich. Meldepflichtig. */
  deviation: R2Deviation[];
  /** Feldweise Probleme (fehlend/Format) – Grundlage für `degraded`. */
  problems: R2ConfigProblem[];
}

// ---------------------------------------------------------------------------
// Fingerabdruck (kein Klartext-Secret verlassen)
// ---------------------------------------------------------------------------

/**
 * Kurzer, stabiler Fingerabdruck eines Werts.
 *
 * Warum überhaupt ein Hash und kein Klartext: `deviation` muss einem Betreiber
 * zeigen, WELCHE der beiden Quellen abweicht, ohne das Secret in Logs/Health-
 * JSON zu schreiben. Bei 64-Hex-Secrets (256 Bit Entropie) verrät ein
 * 8-Hex-Zeichen-Hash-Prefix nichts über den Wert.
 */
export function fingerprintValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Auflösung
// ---------------------------------------------------------------------------

interface ResolvedField {
  value: string;
  name: string | null;
  used: string[];
  ignored: string[];
  values: R2SourceValue[];
  deviation: R2Deviation | null;
}

/** Liest alle gesetzten Alias-Varianten eines Feldes und wählt deterministisch. */
function resolveField(env: R2Env, field: R2ConfigField): ResolvedField {
  const candidates: R2SourceValue[] = [];
  const names: string[] = [];
  for (const name of R2_ENV_ALIASES[field]) {
    const raw = env[name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    names.push(name);
    candidates.push({ name, fingerprint: fingerprintValue(value), length: value.length });
  }

  if (candidates.length === 0) {
    return { value: '', name: null, used: [], ignored: [], values: [], deviation: null };
  }

  const usedName = names[0];
  const usedValue = (env[usedName] ?? '').trim();
  const distinct = new Set(candidates.map((c) => c.fingerprint));
  const deviation: R2Deviation | null = distinct.size > 1
    ? { field, chosen: usedName, values: candidates }
    : null;

  return {
    value: usedValue,
    name: usedName,
    used: [usedName],
    // Gesetzte, aber nicht benutzte Varianten sind nur dann ein Problem, wenn
    // ihr Wert abweicht (sonst sind es reine Spiegel-Einträge).
    ignored: names.slice(1).filter((name, index) => candidates[index + 1].fingerprint !== candidates[0].fingerprint),
    values: candidates,
    deviation,
  };
}

const R2_ACCESS_KEY_SHAPE = /^[0-9a-f]{32}$/i;
const R2_SECRET_SHAPE = /^[0-9a-f]{64}$/i;

/** R2-Endpoint muss ein http(s)-Host sein; Alias `CLOUDFLARE_API` nur mit R2-Host. */
function validateEndpoint(raw: string): { ok: boolean; ignored: boolean } {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, ignored: false };
    return { ok: true, ignored: false };
  } catch {
    // Legacy-Alternative aus alten .env-Dateien: `CLOUDFLARE_API` ist NICHT als
    // R2-Endpoint dokumentiert und zeigte live auf einen falschen Host. Deshalb
    // nur akzeptieren, wenn der Hostname wirklich ein R2-Endpoint ist.
    if (typeof raw === 'string' && /r2\.cloudflarestorage\.com$/i.test(raw)) {
      try {
        const url = new URL(`https://${raw}`);
        if (url.hostname.endsWith('r2.cloudflarestorage.com')) return { ok: true, ignored: false };
      } catch {
        return { ok: false, ignored: true };
      }
    }
    return { ok: false, ignored: true };
  }
}

/**
 * Löst die R2-Konfiguration aus der Env-Map auf: EINE benutzte Herkunft pro
 * Feld, alle Abweichungen explizit ausgewiesen.
 */
export function resolveR2Config(env: R2Env): R2Config {
  const accessKeyId = resolveField(env, 'accessKeyId');
  const secretAccessKey = resolveField(env, 'secretAccessKey');
  const endpointField = resolveField(env, 'endpoint');
  const bucketField = resolveField(env, 'bucket');
  const publicUrlField = resolveField(env, 'publicUrl');
  const accountIdField = resolveField(env, 'accountId');

  const problems: R2ConfigProblem[] = [];
  if (!accessKeyId.name) problems.push('access-key-missing');
  else if (!R2_ACCESS_KEY_SHAPE.test(accessKeyId.value)) problems.push('access-key-shape');
  if (!secretAccessKey.name) problems.push('secret-missing');
  else if (!R2_SECRET_SHAPE.test(secretAccessKey.value)) problems.push('secret-shape');
  if (!bucketField.name) problems.push('bucket-missing');

  const endpointCheck = endpointField.value ? validateEndpoint(endpointField.value) : { ok: false, ignored: false };
  if (endpointField.value && !endpointCheck.ok) problems.push('endpoint-invalid');
  if (endpointField.value && endpointCheck.ignored) problems.push('endpoint-ignored-alias');

  // Account-ID: explizit gesetzt > aus Endpoint-Hostname abgeleitet.
  const fromEndpoint = (() => {
    if (!endpointField.value || !endpointCheck.ok) return '';
    try {
      const host = new URL(endpointField.value).hostname;
      return host.endsWith('r2.cloudflarestorage.com') ? (host.split('.')[0] ?? '') : '';
    } catch {
      return '';
    }
  })();
  const accountId = accountIdField.value || fromEndpoint;

  const endpoint = endpointCheck.ok
    ? endpointField.value
    : accountId
      ? `https://${accountId}.r2.cloudflarestorage.com`
      : '';

  const hasCredentials = Boolean(accessKeyId.value && secretAccessKey.value);
  const configured = hasCredentials
    && !problems.some((p) => p === 'access-key-shape' || p === 'secret-shape' || p === 'bucket-missing' || p === 'endpoint-invalid')
    && Boolean(endpoint);

  const usedEnvKeys = [
    accessKeyId.name, secretAccessKey.name, endpointField.name, bucketField.name, accountIdField.name,
  ].filter((name): name is string => Boolean(name));

  const ignoredEnvKeys = [
    ...accessKeyId.ignored, ...secretAccessKey.ignored,
    ...endpointField.used, ...endpointField.ignored,
    ...bucketField.used, ...bucketField.ignored,
    ...publicUrlField.used, ...publicUrlField.ignored,
    ...accountIdField.used, ...accountIdField.ignored,
  ].filter((name) => !usedEnvKeys.includes(name));

  const deviation = [
    accessKeyId.deviation, secretAccessKey.deviation, endpointField.deviation,
    bucketField.deviation, publicUrlField.deviation, accountIdField.deviation,
  ].filter((d): d is R2Deviation => d !== null);

  return {
    configured,
    hasCredentials,
    accessKeyId: accessKeyId.value,
    secretAccessKey: secretAccessKey.value,
    endpoint,
    bucket: bucketField.value,
    accountId,
    region: 'auto',
    publicBaseUrl: publicUrlField.value || null,
    usedEnvKeys,
    ignoredEnvKeys,
    deviation,
    problems,
  };
}

/** Ein-Zeilen-Beschreibung der Herkunft für Logs/Health (nie Werte). */
export function describeR2Source(config: R2Config): string {
  if (!config.usedEnvKeys.length) return 'keine R2-Variablen gesetzt';
  return config.usedEnvKeys.join(' + ');
}

/** Meldet Abweichungen als eine Warnung (ohne Werte, nur Namen/Fingerabdruck). */
export function formatR2DeviationWarning(deviation: R2Deviation[]): string {
  const parts = deviation.map((d) => {
    const sources = d.values
      .map((v) => `${v.name}(len=${v.length}, fp=${v.fingerprint})`)
      .join(' vs ');
    return `${d.field}: benutzt ${d.chosen} [${sources}]`;
  });
  return `Mehrere R2-Quellen widersprechen sich – ${parts.join('; ')}. `
    + 'Die Rollen-`.env` (Portal) und die Knoten-`.env` müssen dasselbe Paar in derselben benannten Familie tragen.';
}
