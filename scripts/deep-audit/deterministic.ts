// Deep-Audit-System – deterministische Prüfstufen (lokal ohne KI).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuditConfig, Finding, Severity, StageResult } from './types.js';
import { normalizeSeverity } from './types.js';
import { fingerprintFinding } from './pattern.js';
import { parseJsonLoose, runCommand } from './process.js';
import type { SelectedFile } from './files.js';

const NPM_AUDIT_SEVERITY_MAP: Record<string, Severity> = {
  critical: 'critical',
  high: 'high',
  moderate: 'medium',
  low: 'low',
  info: 'info',
};

function stage(
  name: string,
  status: StageResult['status'],
  findings: Finding[],
  summary: string | undefined,
  startedAt: number,
): StageResult {
  return { name, status, findings, summary, durationMs: Date.now() - startedAt };
}

function findingFromValues(values: {
  file: string;
  line: number | null;
  severity: Severity;
  category: string;
  title: string;
  message: string;
  source: string;
  evidence?: string;
  suggestion?: string;
}): Finding {
  return {
    ...values,
    fingerprint: fingerprintFinding(values),
  };
}

function isLikelyMissingCommand(stderr: string, stdout = ''): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return (
    text.includes('command not found') ||
    text.includes('enoent') ||
    text.includes('could not find') ||
    text.includes('is not recognized')
  );
}

async function runTsc(root: string): Promise<StageResult> {
  const startedAt = Date.now();
  const result = await runCommand('npx', ['--no-install', 'tsc', '--noEmit'], { cwd: root, timeoutMs: 300_000 });
  if (isLikelyMissingCommand(result.stderr, result.stdout)) {
    return stage('tsc', 'skipped', [], 'tsc nicht verfügbar', startedAt);
  }
  const findings: Finding[] = [];
  const lines = `${result.stdout}\n${result.stderr}`.split('\n');
  for (const line of lines) {
    const match = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/.exec(line.trim());
    if (match) {
      findings.push(
        findingFromValues({
          file: match[1],
          line: Number(match[2]),
          severity: 'high',
          category: 'type-safety',
          title: match[4],
          message: match[5],
          source: 'tsc',
        }),
      );
    }
  }
  if (result.exitCode !== 0 && findings.length === 0) {
    return stage('tsc', 'fail', [], result.stderr.trim().slice(0, 2000) || 'tsc fehlgeschlagen', startedAt);
  }
  const status = result.exitCode === 0 ? 'pass' : 'fail';
  return stage('tsc', status, findings, `${findings.length} TS-Fehler`, startedAt);
}

async function runEslint(root: string, files: SelectedFile[]): Promise<StageResult> {
  const startedAt = Date.now();
  const lintFiles = files
    .filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.path))
    .map((file) => file.path);
  if (lintFiles.length === 0) {
    return stage('eslint', 'skipped', [], 'keine JS/TS-Dateien im Scope', startedAt);
  }
  const result = await runCommand(
    'npx',
    ['--no-install', 'eslint', '--format', 'json', '--no-warn-ignored', ...lintFiles],
    { cwd: root, timeoutMs: 300_000, maxBuffer: 128 * 1024 * 1024 },
  );
  if (isLikelyMissingCommand(result.stderr, result.stdout)) {
    return stage('eslint', 'skipped', [], 'eslint nicht installiert', startedAt);
  }
  const parsed = parseJsonLoose<Array<{ filePath: string; messages: Array<{ line: number; column: number; severity: number; ruleId: string | null; message: string }> }>>(result.stdout);
  const findings: Finding[] = [];
  if (parsed) {
    for (const file of parsed) {
      for (const message of file.messages) {
        if (message.severity < 1) continue;
        const severity: Severity = message.severity >= 2 ? 'medium' : 'low';
        findings.push(
          findingFromValues({
            file: path.relative(root, file.filePath).replaceAll('\\', '/') || file.filePath.replaceAll('\\', '/'),
            line: message.line || null,
            severity,
            category: message.ruleId ?? 'eslint',
            title: message.ruleId ?? 'ESLint-Finding',
            message: message.message,
            source: 'eslint',
          }),
        );
      }
    }
  }
  if (result.exitCode !== 0 && parsed === null) {
    return stage('eslint', 'error', [], result.stderr.trim().slice(0, 2000), startedAt);
  }
  const hasErrors = findings.some((finding) => finding.severity === 'medium');
  return stage('eslint', hasErrors ? 'warn' : 'pass', findings, `${findings.length} ESLint-Findings`, startedAt);
}

async function runKnip(root: string): Promise<StageResult> {
  const startedAt = Date.now();
  const result = await runCommand('npx', ['--no-install', 'knip', '--reporter', 'json'], { cwd: root, timeoutMs: 300_000, maxBuffer: 128 * 1024 * 1024 });
  if (isLikelyMissingCommand(result.stderr, result.stdout)) {
    return stage('knip', 'skipped', [], 'knip nicht installiert', startedAt);
  }
  const parsed = parseJsonLoose<Array<{ file?: string; text?: string; symbols?: string[] }>>(result.stdout);
  const findings: Finding[] = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item.file) continue;
      findings.push(
        findingFromValues({
          file: item.file.replaceAll('\\', '/'),
          line: null,
          severity: 'low',
          category: 'unused-code',
          title: 'Knip-Finding',
          message: item.text ?? 'Nicht verwendeter Code/Export',
          source: 'knip',
          evidence: item.symbols?.join(', ') ?? undefined,
        }),
      );
    }
  }
  return stage('knip', findings.length ? 'warn' : 'pass', findings, `${findings.length} Knip-Findings`, startedAt);
}

async function runJscpd(root: string): Promise<StageResult> {
  const startedAt = Date.now();
  const outputDir = path.join(root, 'test-results', 'deep-audit', 'jscpd');
  mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, 'jscpd-report.json');
  const result = await runCommand(
    'npx',
    ['--no-install', 'jscpd', '--reporters', 'json', '--output', outputDir, '--min-tokens', '100', 'src', 'server', 'services', 'scripts'],
    { cwd: root, timeoutMs: 300_000, maxBuffer: 128 * 1024 * 1024 },
  );
  if (isLikelyMissingCommand(result.stderr, result.stdout)) {
    return stage('jscpd', 'skipped', [], 'jscpd nicht installiert', startedAt);
  }
  let findings: Finding[] = [];
  if (existsSync(outputFile)) {
    try {
      const data = JSON.parse(readFileSync(outputFile, 'utf8')) as { duplicates?: Array<{ firstFile?: { name?: string }; secondFile?: { name?: string }; format?: string; fragment?: string; lines?: number }> };
      for (const duplicate of data.duplicates ?? []) {
        const first = duplicate.firstFile?.name;
        const second = duplicate.secondFile?.name;
        const file = first ?? second ?? 'unbekannt';
        findings.push(
          findingFromValues({
            file,
            line: null,
            severity: 'low',
            category: 'duplication',
            title: 'Code-Duplikat',
            message: `Duplikat zwischen ${first ?? '?'} und ${second ?? '?'}`,
            source: 'jscpd',
            evidence: duplicate.fragment?.slice(0, 500) ?? undefined,
            suggestion: 'Duplizierten Code in eine gemeinsame Funktion extrahieren.',
          }),
        );
      }
    } catch {
      findings = [];
    }
  }
  return stage('jscpd', findings.length ? 'warn' : 'pass', findings, `${findings.length} Duplikat-Gruppen`, startedAt);
}

async function runNpmAudit(root: string): Promise<StageResult> {
  const startedAt = Date.now();
  const result = await runCommand('npm', ['audit', '--json'], { cwd: root, timeoutMs: 300_000, maxBuffer: 128 * 1024 * 1024 });
  if (isLikelyMissingCommand(result.stderr, result.stdout)) {
    return stage('npm-audit', 'skipped', [], 'npm audit nicht verfügbar', startedAt);
  }
  const parsed = parseJsonLoose<{ metadata?: { vulnerabilities?: Record<string, number> }; vulnerabilities?: Record<string, { name?: string; severity?: string; isDirect?: boolean; via?: Array<{ title?: string; severity?: string; range?: string; url?: string } | string>; effects?: string[]; fixAvailable?: unknown }> }>(result.stdout);
  const findings: Finding[] = [];
  if (parsed?.vulnerabilities) {
    for (const [name, vuln] of Object.entries(parsed.vulnerabilities)) {
      const severity = NPM_AUDIT_SEVERITY_MAP[vuln.severity?.toLowerCase() ?? ''] ?? 'low';
      const via = (vuln.via ?? []).find((entry): entry is { title?: string; severity?: string; range?: string; url?: string } => typeof entry === 'object' && entry !== null);
      const firstVia = vuln.via?.[0];
      const fallbackMessage = typeof firstVia === 'string' ? firstVia : `npm audit meldet ${name}`;
      findings.push(
        findingFromValues({
          file: 'package-lock.json',
          line: null,
          severity,
          category: 'dependency',
          title: `Verwundbarkeit: ${name}`,
          message: via?.title ?? fallbackMessage,
          source: 'npm-audit',
          evidence: via?.url,
          suggestion: vuln.fixAvailable ? 'npm audit fix ausführen' : 'Abhängigkeit manuell aktualisieren/ersetzen',
        }),
      );
    }
  }
  const hasHigh = findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical');
  return stage('npm-audit', hasHigh ? 'fail' : findings.length ? 'warn' : 'pass', findings, `${findings.length} npm-audit-Findings`, startedAt);
}

async function runSemgrep(root: string, files: SelectedFile[]): Promise<StageResult> {
  const startedAt = Date.now();
  const scanFiles = files.filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs|py|sql|rs)$/.test(file.path)).map((file) => file.path);
  if (scanFiles.length === 0) {
    return stage('semgrep', 'skipped', [], 'keine semgrep-relevanten Dateien', startedAt);
  }
  const result = await runCommand(
    'semgrep',
    ['--config=auto', '--json', '--metrics=off', '--quiet', ...scanFiles],
    { cwd: root, timeoutMs: 600_000, maxBuffer: 256 * 1024 * 1024 },
  );
  if (isLikelyMissingCommand(result.stderr, result.stdout)) {
    return stage('semgrep', 'skipped', [], 'semgrep nicht installiert', startedAt);
  }
  const parsed = parseJsonLoose<{ results?: Array<{ path?: string; start?: { line?: number }; extra?: { severity?: string; message?: string; metadata?: { cwe?: string[]; references?: string[] } } }> }>(result.stdout);
  const findings: Finding[] = [];
  if (parsed?.results) {
    for (const rule of parsed.results) {
      const severity = normalizeSeverity(rule.extra?.severity ?? 'WARNING', 'medium') as Severity;
      if (rule.extra?.severity === 'ERROR') {
        // Semgrep ERROR wird als high behandelt
      }
      const effective: Severity = rule.extra?.severity === 'ERROR' ? 'high' : severity === 'critical' || severity === 'high' ? severity : severity === 'medium' ? 'medium' : 'low';
      findings.push(
        findingFromValues({
          file: rule.path ?? 'unbekannt',
          line: rule.start?.line ?? null,
          severity: effective,
          category: 'security',
          title: 'Semgrep-Regel',
          message: rule.extra?.message ?? 'Semgrep-Finding',
          source: 'semgrep',
          evidence: rule.extra?.metadata?.cwe?.join(', ') ?? rule.extra?.metadata?.references?.join(', '),
        }),
      );
    }
  }
  const hasHigh = findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical');
  return stage('semgrep', hasHigh ? 'fail' : findings.length ? 'warn' : 'pass', findings, `${findings.length} Semgrep-Findings`, startedAt);
}

async function runNodeScript(root: string, name: string, script: string, args: string[] = []): Promise<StageResult> {
  const startedAt = Date.now();
  const result = await runCommand('node', [script, ...args], { cwd: root, timeoutMs: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout.trim();
  if (result.exitCode === 0) {
    return stage(name, 'pass', [], stdout.slice(0, 1000) || 'ok', startedAt);
  }
  const message = stdout.slice(0, 3000) || result.stderr.trim().slice(0, 2000);
  return stage(name, 'fail', [
    findingFromValues({
      file: script.replaceAll('\\', '/'),
      line: null,
      severity: 'high',
      category: 'project-gate',
      title: `${name} fehlgeschlagen`,
      message,
      source: name,
    }),
  ], message, startedAt);
}

export async function runDeterministicStages(
  root: string,
  config: AuditConfig,
  files: SelectedFile[],
  opts: { skipHeavy?: boolean } = {},
): Promise<StageResult[]> {
  const stages: StageResult[] = [];
  stages.push(await runTsc(root));
  stages.push(await runEslint(root, files));
  stages.push(await runKnip(root));
  if (!opts.skipHeavy) stages.push(await runJscpd(root));
  stages.push(await runNpmAudit(root));
  stages.push(await runSemgrep(root, files));
  stages.push(await runNodeScript(root, 'interface-boundaries', 'scripts/validate-interface-boundaries.mjs'));
  stages.push(await runNodeScript(root, 'react-memo', 'scripts/check-react-memo.mjs'));
  stages.push(await runNodeScript(root, 'bundle-budget', 'scripts/check-bundle-size.mjs'));
  return stages;
}

export function exportFindings(stages: StageResult[], root: string): void {
  const outputDir = path.join(root, 'test-results', 'deep-audit');
  mkdirSync(outputDir, { recursive: true });
  const findings = stages.flatMap((s) => s.findings);
  writeFileSync(path.join(outputDir, 'deterministic-findings.json'), JSON.stringify(findings, null, 2));
}
