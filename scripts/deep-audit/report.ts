// Deep-Audit-System – Bericht, Dedupe und Datei-Ausgabe.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuditReport, Finding, Severity, StageResult } from './types.js';
import { SEVERITY_ORDER } from './types.js';
import { matchesAny } from './pattern.js';

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER[severity] ?? 0;
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line ?? 0}:${finding.category.toLowerCase()}:${finding.message.trim().toLowerCase().slice(0, 160)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...finding });
      continue;
    }
    if (severityRank(finding.severity) > severityRank(existing.severity)) {
      byKey.set(key, { ...finding, source: existing.source ? `${existing.source}+${finding.source}` : finding.source });
    } else if (existing.source !== finding.source) {
      existing.source = existing.source ? `${existing.source}+${finding.source}` : finding.source;
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const fileCompare = a.file.localeCompare(b.file);
    if (fileCompare !== 0) return fileCompare;
    const lineA = a.line ?? Number.MAX_SAFE_INTEGER;
    const lineB = b.line ?? Number.MAX_SAFE_INTEGER;
    if (lineA !== lineB) return lineA - lineB;
    return severityRank(b.severity) - severityRank(a.severity);
  });
}

function severityBadge(severity: Severity): string {
  const labels: Record<Severity, string> = {
    critical: 'KRITISCH',
    high: 'HOCH',
    medium: 'MITTEL',
    low: 'NIEDRIG',
    info: 'INFO',
  };
  return labels[severity];
}

function stageStatusIcon(status: StageResult['status']): string {
  const icons: Record<StageResult['status'], string> = {
    pass: 'PASS',
    warn: 'WARN',
    fail: 'FAIL',
    skipped: 'SKIPPED',
    error: 'ERROR',
  };
  return icons[status];
}

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push('# Deep Audit 300 – audioMONASTRY');
  lines.push('');
  lines.push(`- **Datum:** ${report.generatedAt}`);
  lines.push(`- **Commit:** \`${report.commit}\``);
  lines.push(`- **Branch:** \`${report.branch}\``);
  lines.push(`- **Modus:** \`${report.mode}\``);
  lines.push(`- **Status:** ${report.passed ? 'PASS' : 'FAIL'}`);
  lines.push(`- **Zusammenfassung:** ${report.summary}`);
  lines.push('');
  lines.push('## Methoden-Matrix (300-%-Prinzip)');
  lines.push('');
  lines.push('| Methode | Status | Findings | Dauer |');
  lines.push('|---|---|---|---|');
  for (const stage of report.stages) {
    lines.push(`| ${stageStatusIcon(stage.status)} ${stage.name} | ${stage.status} | ${stage.findings.length} | ${Math.round(stage.durationMs / 1000)} s |`);
  }
  lines.push('');
  lines.push(`**Geprüfte Dateien:** ${report.scope.length}`);
  lines.push('');
  lines.push(`**KI-Provider:** ${report.providersUsed.length ? report.providersUsed.join(', ') : 'keine (offline)'}`);
  lines.push('');
  lines.push('## Findings nach Schweregrad');
  lines.push('');
  const grouped: Record<Severity, Finding[]> = { critical: [], high: [], medium: [], low: [], info: [] };
  for (const finding of report.findings) {
    grouped[finding.severity]?.push(finding);
  }
  for (const severity of ['critical', 'high', 'medium', 'low', 'info'] as Severity[]) {
    const items = grouped[severity];
    if (!items || items.length === 0) continue;
    lines.push(`### ${severityBadge(severity)} (${items.length})`);
    lines.push('');
    lines.push('| Quelle | Datei | Zeile | Kategorie | Titel |');
    lines.push('|---|---|---|---|---|');
    for (const finding of items) {
      const lineText = finding.line === null ? '–' : String(finding.line);
      lines.push(`| ${finding.source} | \`${finding.file}\` | ${lineText} | ${finding.category} | ${finding.title} |`);
    }
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>Details öffnen</summary>');
    lines.push('');
    for (const finding of items) {
      lines.push(`**${finding.title}** – \`${finding.file}:${finding.line ?? '?'}\` (${finding.source})`);
      lines.push('');
      lines.push(finding.message);
      if (finding.evidence) {
        lines.push('');
        lines.push(`*Evidenz:* ${finding.evidence}`);
      }
      if (finding.suggestion) {
        lines.push('');
        lines.push(`*Empfehlung:* ${finding.suggestion}`);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }
  if (report.findings.length === 0) {
    lines.push('Keine Findings in diesem Lauf.');
    lines.push('');
  }
  return lines.join('\n');
}

export function writeReport(root: string, report: AuditReport): { auditPath: string; jsonPath: string; detailPath: string } {
  const outputDir = path.join(root, 'test-results', 'deep-audit');
  mkdirSync(outputDir, { recursive: true });
  const auditPath = path.join(root, 'AUDIT_DEEP.md');
  const jsonPath = path.join(outputDir, 'findings.json');
  const detailPath = path.join(outputDir, 'report.md');
  const markdown = renderMarkdown(report);
  writeFileSync(auditPath, markdown, 'utf8');
  writeFileSync(detailPath, markdown, 'utf8');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { auditPath, jsonPath, detailPath };
}

export function findNextTodoId(masterTodo: string, dateTag: string): string {
  const today = dateTag;
  const existing = new Set<string>();
  const regex = /DA-(\d{4}-\d{2}-\d{2})-(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(masterTodo)) !== null) {
    existing.add(match[0]);
  }
  let index = 1;
  let id = `DA-${today}-${String(index).padStart(3, '0')}`;
  while (existing.has(id)) {
    index += 1;
    id = `DA-${today}-${String(index).padStart(3, '0')}`;
  }
  return id;
}

export function appendToMasterTodo(root: string, report: AuditReport, findings: Finding[]): string | null {
  const todoPath = path.join(root, 'MASTER_TODO.md');
  if (!existsSync(todoPath)) return null;
  const content = readFileSync(todoPath, 'utf8');
  const today = report.generatedAt.slice(0, 10);
  const lines: string[] = [];
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`## Deep-Audit ${today} – Befunde`);
  lines.push('');
  let added = 0;
  for (const finding of findings) {
    if (finding.severity !== 'critical' && finding.severity !== 'high' && finding.severity !== 'medium') continue;
    const location = finding.file + (finding.line ? `:${finding.line}` : '');
    const marker = `\`${location}\` (${finding.source})`;
    const existingText = `${content}\n${lines.join('\n')}`;
    if (existingText.includes(marker)) continue;
    const id = findNextTodoId(existingText, today);
    lines.push(`- [ ] **${id} · ${finding.severity.toUpperCase()} · ${finding.title}** – ${marker}`);
    lines.push(`  - ${finding.message.replaceAll('\n', ' ').slice(0, 400)}`);
    if (finding.suggestion) {
      lines.push(`  - Vorschlag: ${finding.suggestion.replaceAll('\n', ' ').slice(0, 300)}`);
    }
    added += 1;
  }
  if (added === 0) {
    return null;
  }
  lines.push('');
  const addition = lines.join('\n');
  const updated = content.endsWith('\n') ? `${content}${addition}` : `${content}\n${addition}`;
  writeFileSync(todoPath, updated, 'utf8');
  return todoPath;
}

export function filterFindings(findings: Finding[], patterns: string[]): Finding[] {
  return findings.filter((finding) => matchesAny(patterns, finding.file));
}
