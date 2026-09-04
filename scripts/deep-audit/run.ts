// Deep-Audit-System – CLI-Einstiegspunkt.
// Aufruf: tsx scripts/deep-audit/run.ts [--mode full|diff|files] [--files a.ts b.ts] [--offline] [--providers all|deepseek|hf] [--update-todo] [--smoke] [--fail-on critical|high|none]

import 'dotenv/config';
import { appendToMasterTodo, dedupeFindings, writeReport } from './report.js';
import { findRepoRoot, isFailSeverity, loadConfig, providerReady, resolveFailOn } from './config.js';
import { exportFindings, runDeterministicStages } from './deterministic.js';
import { addAgentsContext, makeReviewBatchesForFiles, runAiPass } from './ai.js';
import { selectFiles, type SelectedFile } from './files.js';
import { runCommand } from './process.js';
import type { AuditReport, Severity, StageResult } from './types.js';
import { normalizeSeverity } from './types.js';

interface CliOptions {
  mode: 'full' | 'diff' | 'files';
  files: string[];
  offline: boolean;
  providers: 'all' | 'deepseek' | 'hf' | 'none';
  updateTodo: boolean;
  smoke: boolean;
  failOn: Severity | 'none';
  skipHeavy: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'full',
    files: [],
    offline: false,
    providers: 'all',
    updateTodo: false,
    smoke: false,
    failOn: 'critical',
    skipHeavy: false,
    help: false,
  };
  let collectFiles = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (collectFiles) {
      if (arg.startsWith('--')) {
        collectFiles = false;
      } else {
        options.files.push(arg);
        continue;
      }
    }
    if (arg === '--mode') {
      const value = argv[i + 1];
      if (value === 'full' || value === 'diff' || value === 'files') options.mode = value;
      i += 1;
    } else if (arg === '--files') {
      collectFiles = true;
    } else if (arg === '--offline') {
      options.offline = true;
    } else if (arg === '--providers') {
      const value = argv[i + 1];
      if (value === 'all' || value === 'deepseek' || value === 'hf' || value === 'none') options.providers = value;
      i += 1;
    } else if (arg === '--update-todo') {
      options.updateTodo = true;
    } else if (arg === '--smoke') {
      options.smoke = true;
    } else if (arg === '--skip-heavy') {
      options.skipHeavy = true;
    } else if (arg === '--fail-on') {
      const value = argv[i + 1];
      options.failOn = resolveFailOn(value, 'critical');
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Deep Audit 300 für audioMONASTRY

Verwendung:
  npm run audit:deep                       # Full-Audit (deterministisch + KI)
  npm run audit:deep:diff                  # nur Änderungen gegen origin/main
  npm run audit:deep:static                # nur deterministische Tools, kein KI-Call
  npm run audit:deep:smoke                 # kleiner Smoke-Lauf

Optionen:
  --mode full|diff|files
  --files pfad1 pfad2 ...
  --offline
  --providers all|deepseek|hf|none
  --update-todo
  --smoke
  --skip-heavy
  --fail-on critical|high|none
  --help`);
}

function riskRank(risk: SelectedFile['risk']): number {
  if (risk === 'hot') return 3;
  if (risk === 'risk') return 2;
  return 1;
}

function pickAiFiles(files: SelectedFile[], mode: CliOptions['mode'], config: ReturnType<typeof loadConfig>, smoke: boolean): SelectedFile[] {
  if (smoke || mode !== 'full') return files;
  const sorted = [...files].sort((a, b) => riskRank(b.risk) - riskRank(a.risk) || b.size - a.size);
  if (sorted.length <= config.maxAiFiles) return sorted;
  console.warn(`Hinweis: Full-Mode deckt deterministisch ${files.length} Dateien ab, KI-Pässe laufen auf ${config.maxAiFiles} priorisierten Dateien (Risk/Hot zuerst).`);
  return sorted.slice(0, config.maxAiFiles);
}

function skippedStage(name: string, reason: string): StageResult {
  return { name, status: 'skipped', findings: [], summary: reason, durationMs: 0 };
}

function findingFiles(stages: StageResult[]): Set<string> {
  const set = new Set<string>();
  for (const stage of stages) {
    for (const finding of stage.findings) {
      if (finding.file && finding.file !== 'unbekannt') set.add(finding.file);
    }
  }
  return set;
}

async function gitMeta(root: string): Promise<{ commit: string; branch: string }> {
  const commit = await runCommand('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
  const branch = await runCommand('git', ['branch', '--show-current'], { cwd: root });
  return {
    commit: commit.stdout.trim() || 'unknown',
    branch: branch.stdout.trim() || 'unknown',
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const root = findRepoRoot();
  const config = loadConfig(root);
  const meta = await gitMeta(root);
  const startedAt = Date.now();

  console.log(`Deep Audit 300 startet (Modus: ${options.mode}, Provider: ${options.providers})`);
  const selected = await selectFiles(root, config, options.mode, options.files, options.smoke);
  if (selected.length === 0) {
    console.error('Keine Dateien im Scope gefunden. Prüfe --mode/--files oder Git-Status.');
    process.exitCode = 1;
    return;
  }
  console.log(`${selected.length} Dateien im Scope.`);

  const stages: StageResult[] = [];
  console.log('Stufe 1/2: Deterministische Scans laufen ...');
  const deterministicStages = await runDeterministicStages(root, config, selected, { skipHeavy: options.skipHeavy });
  stages.push(...deterministicStages);
  exportFindings(deterministicStages, root);
  for (const stage of deterministicStages) {
    console.log(`  [${stage.status.toUpperCase().padEnd(7)}] ${stage.name} (${stage.findings.length} Findings, ${Math.round(stage.durationMs / 1000)} s)`);
  }

  const providersUsed: string[] = [];
  const aiFiles = pickAiFiles(selected, options.mode, config, options.smoke);

  if (options.providers !== 'none' && !options.offline && aiFiles.length > 0) {
    console.log('Stufe 2/2: KI-Review-Pässe laufen ...');
    const agentsContext = addAgentsContext(root);
    const wantDeepSeek = options.providers === 'all' || options.providers === 'deepseek';
    const wantHf = options.providers === 'all' || options.providers === 'hf';

    const flashProvider = config.providers.deepseekFlash;
    const flashBatches = makeReviewBatchesForFiles(root, config, aiFiles);
    if (wantDeepSeek && providerReady(flashProvider)) {
      const stage = await runAiPass('deepseek-flash', flashProvider, flashBatches, config, agentsContext);
      stages.push(stage);
      if (stage.status !== 'skipped') providersUsed.push(`deepseek:${flashProvider.model}`);
      console.log(`  [${stage.status.toUpperCase().padEnd(7)}] deepseek-flash (${stage.findings.length} Findings, ${Math.round(stage.durationMs / 1000)} s)`);
    } else if (wantDeepSeek) {
      stages.push(skippedStage('deepseek-flash', 'DeepSeek-API-Key fehlt'));
    }

    const aiStages = stages.filter((stage) => stage.name === 'deepseek-flash' || stage.name === 'hf-qwen' || stage.name === 'deepseek-pro');
    const filesWithFindings = findingFiles(aiStages);

    // Pass 2: HF Qwen als unabhängiger Zweit-Rater (Hot-Pfade + Dateien mit Flash-Findings).
    const hfProvider = config.providers.hfQwen;
    const hfFiles = aiFiles.filter((file) => file.risk === 'hot' || filesWithFindings.has(file.path));
    if (wantHf && hfFiles.length > 0 && providerReady(hfProvider)) {
      const hfBatches = makeReviewBatchesForFiles(root, config, hfFiles);
      const stage = await runAiPass('hf-qwen', hfProvider, hfBatches, config, agentsContext);
      stages.push(stage);
      if (stage.status !== 'skipped') providersUsed.push(`hf:${hfProvider.model}`);
      console.log(`  [${stage.status.toUpperCase().padEnd(7)}] hf-qwen (${stage.findings.length} Findings, ${Math.round(stage.durationMs / 1000)} s)`);
    } else if (wantHf) {
      stages.push(skippedStage('hf-qwen', hfFiles.length === 0 ? 'keine Hot-Pfade/Findings im Scope' : 'HF-API-Key fehlt'));
    }

    // Pass 3: DeepSeek Pro verifiziert Hot-Pfade und High-Severity-Kandidaten.
    const proProvider = config.providers.deepseekPro;
    const afterAiStages = stages.filter((stage) => stage.name === 'deepseek-flash' || stage.name === 'hf-qwen');
    const highFindings = afterAiStages.flatMap((stage) => stage.findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical'));
    const highFiles = new Set(highFindings.map((finding) => finding.file));
    const proFiles = aiFiles.filter((file) => file.risk === 'hot' || highFiles.has(file.path));
    if (wantDeepSeek && proFiles.length > 0 && providerReady(proProvider)) {
      const proBatches = makeReviewBatchesForFiles(root, config, proFiles);
      const stage = await runAiPass('deepseek-pro', proProvider, proBatches, config, agentsContext);
      stages.push(stage);
      if (stage.status !== 'skipped') providersUsed.push(`deepseek:${proProvider.model}`);
      console.log(`  [${stage.status.toUpperCase().padEnd(7)}] deepseek-pro (${stage.findings.length} Findings, ${Math.round(stage.durationMs / 1000)} s)`);
    } else if (wantDeepSeek) {
      stages.push(skippedStage('deepseek-pro', proFiles.length === 0 ? 'keine Hot-Pfade im Scope' : 'DeepSeek-API-Key fehlt'));
    }
  } else {
    stages.push(skippedStage('deepseek-flash', options.offline ? 'offline-Modus' : 'Provider deaktiviert/kein Scope'));
    stages.push(skippedStage('hf-qwen', options.offline ? 'offline-Modus' : 'Provider deaktiviert/kein Scope'));
    stages.push(skippedStage('deepseek-pro', options.offline ? 'offline-Modus' : 'Provider deaktiviert/kein Scope'));
  }

  const findings = dedupeFindings(stages.flatMap((stage) => stage.findings));
  const failOn = options.failOn === 'none' ? 'none' as const : normalizeSeverity(options.failOn, 'critical');
  const gateFindings = findings.filter((finding) => failOn !== 'none' && isFailSeverity(finding.severity, failOn as Severity));
  const stageFailed = stages.some((stage) => stage.status === 'fail');
  const passed = gateFindings.length === 0 && !stageFailed;
  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    commit: meta.commit,
    branch: meta.branch,
    mode: options.mode,
    scope: selected.map((file) => file.path),
    providersUsed: [...new Set(providersUsed)],
    stages,
    findings,
    passed,
    summary: `${findings.length} Findings, ${gateFindings.length} Gate-relevant (${failOn}), Dauer ${durationSec} s`,
  };

  const paths = writeReport(root, report);
  console.log('');
  console.log(report.summary);
  console.log(`Report: ${paths.auditPath}`);
  console.log(`JSON:   ${paths.jsonPath}`);
  if (options.updateTodo) {
    const todoPath = appendToMasterTodo(root, report, findings);
    if (todoPath) console.log(`MASTER_TODO aktualisiert: ${todoPath}`);
  }
  process.exitCode = passed ? 0 : 1;
  if (!passed) console.error('Audit-Gate nicht bestanden.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
