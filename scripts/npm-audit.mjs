#!/usr/bin/env node
/**
 * audioMONASTRY · Sicherheits-Audit der Abhaengigkeiten
 * =====================================================================
 * WARUM EIGENES SKRIPT STATT `npm audit` (messbarer Gate-Defekt, 2026-09-19):
 *
 *   $ npm audit
 *   npm notice This endpoint is being retired. Use the bulk advisory endpoint instead.
 *   npm error audit endpoint returned an error
 *   npm error 400 Bad Request - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick
 *
 * npm 10.x (node 22.23.2) postet weiter an den abgekuendigten `quick`-Endpunkt und
 * bekommt 400 - damit schlaegt `npm run security` (und damit `npm run verify`)
 * DAUERHAFT fuer jeden fehl, unabhaengig vom Code. Gemessen am 2026-09-19:
 *   bulk  (/-/npm/v1/security/advisories/bulk)  -> HTTP 503 (Dienst gestoert)
 *   full  (/-/npm/v1/security/audits)           -> HTTP 200 (liefert Advisories)
 *
 * Dieses Skript fragt deshalb selbst ab - zuerst den vom Registry-Betreiber
 * empfohlenen **bulk**-Endpunkt, sonst den **full**-Endpunkt (und SAGT, welcher
 * benutzt wurde). Sind beide nicht erreichbar, endet das Gate mit Fehler: eine
 * ungepruefte Abhaengigkeitsliste darf nicht als "gruen" durchgehen.
 *
 * Schwellwert: Advisories ab `high` lassen das Gate fehlschlagen (critical ebenso).
 * moderate/niedrig werden gemeldet, aber nicht gewertet.
 *
 * Aufruf: node scripts/npm-audit.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BULK_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const FULL_URL = 'https://registry.npmjs.org/-/npm/v1/security/audits';
const FAIL_SEVERITIES = new Set(['high', 'critical']);

/** Abhaengigkeiten aus package-lock.json (v2/v3) als {name: version}. */
export function dependenciesFromLock(lockText) {
  const lock = JSON.parse(lockText);
  const packages = lock.packages ?? {};
  const deps = new Map();
  for (const [path, meta] of Object.entries(packages)) {
    if (!path.includes('node_modules/')) continue; // Root-Paket ueberspringen
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const version = meta?.version;
    if (version) deps.set(name, version);
  }
  return Object.fromEntries(deps);
}

/** Paketname aus einem Lock-Pfad ("node_modules/a/node_modules/@s/b" -> "@s/b"). */
export function packageNameFromPath(path) {
  const idx = path.lastIndexOf('node_modules/');
  return idx === -1 ? '' : path.slice(idx + 'node_modules/'.length);
}

const postJson = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'npm-command': 'audit' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data };
};

/** Sammelt Advisories: erst bulk (empfohlen), sonst full. Sagt, was benutzt wurde. */
export async function collectAdvisories(deps) {
  const bulk = await postJson(BULK_URL, deps).catch((e) => ({ status: 0, data: null, error: e.message }));
  if (bulk.status === 200 && bulk.data && !bulk.data.error) {
    const findings = [];
    for (const [name, list] of Object.entries(bulk.data)) {
      for (const adv of list ?? []) {
        findings.push({
          module: name,
          severity: String(adv.severity ?? 'unknown'),
          title: String(adv.title ?? ''),
          vulnerable: String(adv.vulnerable_versions ?? ''),
          url: adv.url ?? '',
        });
      }
    }
    return { source: 'bulk', findings };
  }

  const full = await postJson(FULL_URL, {
    name: 'audiomonastry',
    version: '1.0.0',
    requires: deps,
    dependencies: Object.fromEntries(
      Object.entries(deps).map(([name, version]) => [name, { version, integrity: '', requires: {}, dependencies: {} }]),
    ),
  }).catch((e) => ({ status: 0, data: null, error: e.message }));

  if (full.status === 200 && full.data?.advisories) {
    const findings = Object.values(full.data.advisories).map((adv) => ({
      module: String(adv.module_name ?? ''),
      severity: String(adv.severity ?? 'unknown'),
      title: String(adv.title ?? ''),
      vulnerable: String(adv.vulnerable_versions ?? ''),
      url: adv.url ?? '',
    }));
    return { source: 'full', findings, bulkStatus: bulk.status };
  }

  return {
    source: null,
    findings: [],
    error: `bulk HTTP ${bulk.status ?? '?'}, full HTTP ${full.status ?? '?'}`,
  };
}

const main = async () => {
  const lockPath = join(ROOT, 'package-lock.json');
  const deps = dependenciesFromLock(readFileSync(lockPath, 'utf8'));
  const count = Object.keys(deps).length;
  const result = await collectAdvisories(deps);

  if (!result.source) {
    console.error(`❌ Sicherheits-Audit nicht moeglich: ${result.error}`);
    console.error('   (${count} Abhaengigkeiten NICHT geprueft — das Gate darf nicht gruen sein.)'.replace('${count}', String(count)));
    process.exit(3);
  }

  const bySeverity = {};
  for (const f of result.findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  const blocking = result.findings.filter((f) => FAIL_SEVERITIES.has(f.severity));

  console.log(`Sicherheits-Audit (${result.source}-Endpunkt): ${count} Abhaengigkeiten geprueft.`);
  console.log(`  Befunde: ${result.findings.length} ${JSON.stringify(bySeverity)}`);
  if (result.bulkStatus && result.bulkStatus !== 200) {
    console.log(`  Hinweis: der empfohlene bulk-Endpunkt antwortete HTTP ${result.bulkStatus} - es wurde der full-Endpunkt benutzt.`);
  }

  if (blocking.length > 0) {
    console.error(`\n❌ ${blocking.length} Befund(e) ab Schweregrad high:`);
    for (const f of blocking.slice(0, 25)) {
      console.error(`   ${f.severity.toUpperCase()}  ${f.module}  (${f.vulnerable})  ${f.title.slice(0, 70)}`);
    }
    process.exit(1);
  }

  if (result.findings.length > 0) {
    console.log('   Keine Befunde ab high - moderate/niedrig sind gemeldet, aber nicht blockierend.');
  }
  console.log('✅ Keine blockierenden Sicherheitsbefunde.');
};

if (process.argv[1] && process.argv[1].endsWith('npm-audit.mjs')) {
  main().catch((e) => {
    console.error(`❌ Sicherheits-Audit abgebrochen: ${e.message}`);
    process.exit(3);
  });
}
