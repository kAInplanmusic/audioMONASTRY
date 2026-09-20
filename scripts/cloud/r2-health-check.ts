#!/usr/bin/env tsx
/**
 * audioMONASTRY · R2-Diagnose für den Betreiber (FIX F2)
 * =====================================================
 * Prüft die Cloudflare-R2-Anbindung mit einem ECHTEN Probeobjekt – also genau
 * dem Weg, der live mit `SignatureDoesNotMatch` scheiterte. Der Bericht nennt:
 *   - welche Env-Variablen die Werte geliefert haben (EINE Herkunft, Namen statt
 *     Werte – Zugangsschlüssel erscheinen nie),
 *   - ob sich zwei Quellen widersprechen (Abweichung ⇒ das ist die Ursache),
 *   - das Ergebnis der Schreibprobe (PUT + DELETE, mit Timeout) und die
 *     Klartext-Anleitung zum Fehlercode.
 *
 * Aufruf (im Repo-Root, mit der relevanten `.env`):
 *   npx tsx scripts/cloud/r2-health-check.ts
 *   npx tsx scripts/cloud/r2-health-check.ts --json
 *   npx tsx scripts/cloud/r2-health-check.ts --timeout=8000 --key-prefix=probes/diag-
 *
 * Exit-Code: 0 = Probe ok (und keine Abweichung), 1 = Probe/Config nicht ok.
 * Es wird NICHTS gelöscht außer dem eigenen Probeobjekt; keine Secrets im Log.
 */
import 'dotenv/config';
import { describeR2Source, formatR2DeviationWarning, resolveR2Config } from '../../server/r2Config';
import { probeR2, r2ProblemHint } from '../../server/r2Health';

interface Cli {
  json: boolean;
  timeoutMs: number | undefined;
  keyPrefix: string | undefined;
}

function parseArgs(argv: string[]): Cli {
  const json = argv.includes('--json');
  const timeoutArg = argv.find((a) => a.startsWith('--timeout='));
  const prefixArg = argv.find((a) => a.startsWith('--key-prefix='));
  const timeout = timeoutArg ? Number(timeoutArg.split('=')[1]) : undefined;
  return {
    json,
    timeoutMs: Number.isFinite(timeout) && (timeout as number) > 0 ? (timeout as number) : undefined,
    keyPrefix: prefixArg ? prefixArg.split('=').slice(1).join('=') : undefined,
  };
}

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2));
  const config = resolveR2Config(process.env as Record<string, string | undefined>);
  const probe = await probeR2(config, { timeoutMs: cli.timeoutMs, keyPrefix: cli.keyPrefix });
  const deviationWarning = config.deviation.length ? formatR2DeviationWarning(config.deviation) : null;
  const ok = probe.ok && config.deviation.length === 0;

  const report = {
    ok,
    // Herkunft: nur Variablennamen, nie Werte.
    source: describeR2Source(config),
    usedEnvKeys: config.usedEnvKeys,
    ignoredEnvKeys: config.ignoredEnvKeys,
    problems: config.problems,
    deviation: config.deviation.map((d) => ({ field: d.field, chosen: d.chosen, values: d.values })),
    endpoint: probe.endpointHost,
    bucket: probe.bucket,
    probe: {
      method: probe.method,
      key: probe.key,
      ok: probe.ok,
      problem: probe.problem,
      message: probe.message,
      durationMs: probe.durationMs,
      attempts: probe.attempts,
    },
    hint: probe.ok ? null : r2ProblemHint(probe.problem),
  };

  if (cli.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('audioMONASTRY R2-Healthcheck (FIX F2)');
    console.log(`  Quelle:        ${report.source}`);
    console.log(`  Bucket:        ${report.bucket ?? '(nicht gesetzt)'}`);
    console.log(`  Endpoint:      ${report.endpoint ?? '(nicht gesetzt)'}`);
    console.log(`  Probe:         ${probe.ok ? 'ok' : `FEHLER [${probe.problem}]`} (${probe.method}, ${probe.durationMs} ms)`);
    if (probe.key) console.log(`  Probeobjekt:   ${probe.key} (nach dem Test gelöscht)`);
    if (probe.message) console.log(`  Meldung:       ${probe.message}`);
    if (report.problems.length) console.log(`  Auffällig:     ${report.problems.join(', ')}`);
    if (report.ignoredEnvKeys.length) console.log(`  Unbenutzt:     ${report.ignoredEnvKeys.join(', ')} (anderer Wert als die benutzte Quelle)`);
    if (deviationWarning) console.log(`  ABWEICHUNG:    ${deviationWarning}`);
    if (!probe.ok) console.log(`  Betreiber:     ${r2ProblemHint(probe.problem)}`);
    console.log(ok ? '  Ergebnis:      ok – R2 ist beschreibbar.' : '  Ergebnis:      NICHT ok – siehe oben (docs/OPS_RUNBOOK.md, Abschnitt „R2 (F2)“).');
  }

  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[r2-health-check] unerwarteter Fehler:', (error as Error)?.message ?? error);
    process.exit(1);
  });
