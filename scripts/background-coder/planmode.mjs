#!/usr/bin/env node
/**
 * Background-Coder PLAN MODE
 * --------------------------
 * Kein Implementierungsmodus: Jeder Agent erstellt einen Audit-/Code-Review-Plan
 * mit seinem jeweiligen Schwerpunkt und seinen Fähigkeiten. Es werden keine
 * Code-Änderungen vorgenommen und AGENT_TODO bleibt unangetastet.
 *
 * Ergebnisse: logs/background-coder/audit-plans.md
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { hfRouter, QuotaPausedError } from './hfRouter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const CONFIG = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const OUT = path.join(ROOT, 'logs', 'background-coder', 'audit-plans.md');

const PLAN_AGENTS = [
  {
    key: 'MOA',
    role: 'Orchestrator / DeepSeek V4 Flash Visionary (max thinking)',
    model: CONFIG.orchestrator,
    focus: 'Gesamtübersicht: Architektur, Abhängigkeiten, Datenfluss, Risiko-Cluster, Reihenfolge der Audits, Konflikt-/Parallelisierungsanalyse.',
  },
  {
    key: '#2',
    role: 'Kimi K2.7-Code',
    model: CONFIG.agents['#2'],
    focus: 'Backend, Datenbank, Security, Architektur, Migrationen, Abrechnung: API/Server-Härtung, SQL/Supabase, Auth/RBAC, Pfad-/Input-Validierung, Zustandsmaschinen.',
  },
  {
    key: '#3',
    role: 'GLM-5.3',
    model: CONFIG.agents['#3'],
    focus: 'Performance, Audio/DSP, Lasttests: Hot-Path-Allokationen, RT-Safety, Worklets, Latenz/PDC, CPU-Budget, Skalierungs-/Stresstest-Plan.',
  },
  {
    key: '#4',
    role: 'Qwen3-Coder-Next',
    model: CONFIG.agents['#4'],
    focus: 'UI/UX, Rendering, Accessibility, Code-Eleganz: React-Hygiene, Memoization, ARIA/Screenreader, Canvas/Rendering, Dead-Code-/Redundanz-Analyse.',
  },
  {
    key: '#5',
    role: 'GLM-5.3-Flash',
    model: CONFIG.agents['#5'],
    focus: 'Schnelle/einfache Aufgaben, CI/CD, Backups, Runbooks: Build-Workflows, npm audit, Skriptqualität, Doku-, Backup- und Runbook-Lücken.',
  },
  {
    key: '#6',
    role: 'DeepSeek V4 Pro (Final Review)',
    model: CONFIG.agents['#6'],
    focus: 'Unabhängiger Sicherheits-/Compliance-/Hotfix-Review-Plan und End-to-End-Prüfplan (gegen die Pläne von #2..#5).',
  },
];

function statusSummary() {
  const todoPath = path.join(ROOT, 'AGENT_TODO.json');
  if (!existsSync(todoPath)) return '(kein AGENT_TODO vorhanden)';
  const payload = JSON.parse(readFileSync(todoPath, 'utf8'));
  const counts = {};
  for (const t of payload.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return JSON.stringify(counts);
}

async function askPlan(agent) {
  const prompt = `Du bist der Audit-Planer "${agent.role}" im Background-Coder von audioMONASTRY.
Erstelle einen KONKRETEN Audit-/Code-Review-Plan für deinen Schwerpunkt:

Schwerpunkt: ${agent.focus}

Kontext:
- AGENT_TODO-Status: ${statusSummary()}
- Queue läuft über HF Router / Inference Providers (provider=auto)
- Keine Implementierung jetzt – nur Planung.

Liefere als Markdown:
## Audit-Plan: ${agent.role}
1. Fokus/Ziel
2. Dateien/Komponenten, die geprüft werden
3. Prüfschritte (konkret, nummeriert)
4. Werkzeuge/Tests/Gates
5. Erwartete Findings-Kategorien (Security/Code-Eleganz/RT/Architektur/UI)
6. Akzeptanzkriterien für einen sauberen Audit-Lauf`;

  const res = await hfRouter.chat({
    modelId: agent.model.model,
    messages: [
      { role: 'system', content: 'Du bist ein Audit-Planer. Keine Code-Änderungen, keine JSON-Pflicht.' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 4096,
    temperature: 0.1,
  });
  return res.content.trim();
}

async function main() {
  mkdirSync(path.dirname(OUT), { recursive: true });
  const sections = [`# Background-Coder Tiefen-Audit Plan\n\nErstellt: ${new Date().toISOString()}\n\n> PLAN MODE – keine Codeänderungen.\n`];

  for (const agent of PLAN_AGENTS) {
    if (!hfRouter.apiKey()) {
      sections.push(`\n## ${agent.role}\n\n**BLOCKED:** Kein HF-Token.\n`);
      continue;
    }
    try {
      console.log(`[plan-mode] ${agent.role} ...`);
      const plan = await askPlan(agent);
      sections.push(`\n---\n\n${plan}\n`);
    } catch (e) {
      const reason = e instanceof QuotaPausedError ? e.message : `Fehler: ${e.message}`;
      sections.push(`\n## Audit-Plan: ${agent.role}\n\n**BLOCKED:** ${reason}\n`);
      console.warn(`[plan-mode] ${agent.role} fehlgeschlagen: ${reason}`);
      if (e instanceof QuotaPausedError) break;
    }
  }

  writeFileSync(OUT, sections.join('\n'));
  console.log(`\nAudit-Pläne geschrieben: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
