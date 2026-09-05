#!/usr/bin/env node
/**
 * Background-Coder ORCHESTRATOR
 * Liest MASTER_TODO.md, klassifiziert automatisierbare Aufgaben und erzeugt
 * AGENT_TODO.md + AGENT_TODO.json (maschinenlesbar).
 *
 * Modellzuordnung ist FEST (siehe scripts/background-coder/config.json).
 * Aufgaben mit SERVER_REQUIRED=YES oder HARDWARE_REQUIRED=YES werden BLOCKED.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CONFIG = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const CLASS_LIMITS = CONFIG.classLimits;

const DOMAIN_RULES = [
  [/security|auth|token|secret|injection|rate.limit|csp|password|lock|rbac|credential/i, 'SECURITY'],
  [/compliance|dsgvo|gdpr|license|lizenz|audit log/i, 'COMPLIANCE'],
  [/hotfix/i, 'HOTFIX'],
  [/database|supabase|sql|migration|pgvector|schema/i, 'DATABASE'],
  [/migration|migrier/i, 'MIGRATION'],
  [/billing|abrechnung|kosten|budget|cost/i, 'ABRECHNUNG'],
  [/audio|worklet|dsp|lufs|reverb|eq|sample.rate|signal/i, 'AUDIO'],
  [/performance|latency|latenz|cpu|bundle|dropout|jitter/i, 'PERFORMANCE'],
  [/lasttest|load.test|stress|e2e/i, 'LASTTESTS'],
  [/barrierefrei|accessibility|aria|a11y/i, 'BARRIEREFREIHEIT'],
  [/render|canvas|webgl|gpu/i, 'RENDERING'],
  [/backend|server|socket|api|endpoint|express|routing/i, 'BACKEND'],
  [/ui\b|component|terminal|css|skin|theme|plugin-ui/i, 'UI'],
  [/ux\b|usability|flow|interaction/i, 'UX'],
  [/ci\/cd|workflow|github|deploy|docker|build|npm audit|pipeline/i, 'CI/CD'],
  [/backup|runbook|doku|documentation|readme/i, 'RUNBOOKS'],
  [/architektur|architecture|monolith|modul|boundary/i, 'ARCHITECTURE'],
];

const ROUTING = {
  LEICHT: { '#': '#5' },
  MITTEL: {
    BACKEND: '#2', DATABASE: '#2', SECURITY: '#2', UI: '#4', UX: '#4',
    'CI/CD': '#5', BACKUPS: '#5', RUNBOOKS: '#5', PERFORMANCE: '#3',
  },
  SCHWER: {
    ARCHITECTURE: '#2', MIGRATION: '#2', ABRECHNUNG: '#2', AUDIO: '#3',
    PERFORMANCE: '#3', LASTTESTS: '#3', BARRIEREFREIHEIT: '#4', RENDERING: '#4',
    SECURITY: '#2', COMPLIANCE: '#2', HOTFIX: '#2',
  },
};
// Backups gehören laut Spezifikation zu CI/CD/Backups/Runbooks → #5.
const DOMAIN_AGENT_OVERRIDE = { BACKUPS: '#5' };

function detectDomain(text) {
  for (const [re, domain] of DOMAIN_RULES) {
    if (re.test(text)) return domain;
  }
  return 'BACKEND';
}

function detectClass(text) {
  const t = text.toUpperCase();
  if (/AD-K|K-1|K-2|K-3|K-4|K-5|KRITISCH|HOCH|P0|S-1|S-2|S-3|S-4|SECURITY|COMPLIANCE|HOTFIX/.test(t)) return 'SCHWER';
  if (/AD-H|AD-M|MITTEL|P2/.test(t)) return 'MITTEL';
  if (/AD-I|AD-N|NIEDRIG|P3/.test(t)) return 'LEICHT';
  return 'LEICHT';
}

function detectBlockers(text) {
  const t = text.toLowerCase();
  const server = /live|browser|hörprobe|hoerprobe|playwright|e2e|lasttest|load.test|flotte|fleet|hetzner|sfu|webrtc-session/.test(t);
  const hardware = /hardware|usb|midi|controller|xonar|audio-interface|externe/.test(t);
  return { serverRequired: server, hardwareRequired: hardware };
}

function agentFor(cls, domain) {
  if (cls === 'LEICHT') return { agent: '#5', review: null };
  if (cls === 'MITTEL') {
    const agent = ROUTING.MITTEL[domain] ?? '#2';
    return { agent, review: null };
  }
  const agent = ROUTING.SCHWER[domain] ?? '#2';
  const review = CONFIG.reviewRequiredDomains.includes(domain) ? CONFIG.reviewAgent : null;
  return { agent, review };
}

function main() {
  const masterPath = path.join(ROOT, 'MASTER_TODO.md');
  if (!existsSync(masterPath)) {
    console.error('MASTER_TODO.md nicht gefunden.');
    process.exit(1);
  }
  const lines = readFileSync(masterPath, 'utf8').split(/\r?\n/);
  const tasks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[ \] (.*)$/);
    if (!m) continue;
    const text = m[1].trim();
    const cls = detectClass(text);
    const domain = detectDomain(text);
    const { serverRequired, hardwareRequired } = detectBlockers(text);
    const { agent, review } = agentFor(cls, domain);
    const ready = !serverRequired && !hardwareRequired;
    tasks.push({
      raw: text,
      priority: cls === 'SCHWER' ? 'P0/P1' : cls === 'MITTEL' ? 'P2' : 'P3',
      class: cls,
      domain,
      agent,
      reviewAgent: review,
      serverRequired,
      hardwareRequired,
      reviewRequired: review ? 'YES' : 'NO',
      ready,
    });
  }

  const ordered = { LEICHT: [], MITTEL: [], SCHWER: [], BACKLOG: [] };
  const counters = { LEICHT: 0, MITTEL: 0, SCHWER: 0 };
  let backlogN = 0;
  for (const task of tasks) {
    const cls = task.class;
    if (!task.ready) {
      backlogN += 1;
      ordered.BACKLOG.push({ ...task, status: 'BLOCKED', taskId: `BLOCK-${String(backlogN).padStart(3, '0')}` });
      continue;
    }
    counters[cls] += 1;
    if (counters[cls] <= CLASS_LIMITS[cls]) {
      const n = counters[cls];
      const idBase = cls === 'LEICHT' ? 0 : cls === 'MITTEL' ? 12 : 24;
      ordered[cls].push({ ...task, status: 'PENDING', taskId: `TASK-${String(idBase + n).padStart(3, '0')}` });
    } else {
      backlogN += 1;
      ordered.BACKLOG.push({ ...task, status: 'PENDING', taskId: `BACKLOG-${String(backlogN).padStart(3, '0')}` });
    }
  }

  const blocks = [];
  for (const cls of ['LEICHT', 'MITTEL', 'SCHWER']) {
    blocks.push(`\n## ${cls} (${cls === 'LEICHT' ? '1-12' : cls === 'MITTEL' ? '13-24' : '25-36'})\n`);
    for (const t of ordered[cls]) {
      blocks.push(`\n${t.taskId}\nCLASS: ${t.class}\nPRIORITY: ${t.priority}\nDOMAIN: ${t.domain}\nDESCRIPTION: ${t.raw}\nIMPLEMENTATION_AGENT: ${t.agent}\nREVIEW_AGENT: ${t.reviewAgent ?? '-'}\nSERVER_REQUIRED: ${t.serverRequired ? 'YES' : 'NO'}\nHARDWARE_REQUIRED: ${t.hardwareRequired ? 'YES' : 'NO'}\nREVIEW_REQUIRED: ${t.reviewRequired}\nSTATUS: ${t.status}\n`);
    }
  }
  blocks.push(`\n## BACKLOG / BLOCKED\n`);
  for (const t of ordered.BACKLOG) {
    blocks.push(`\nBLOCKED\nCLASS: ${t.class}\nDOMAIN: ${t.domain}\nDESCRIPTION: ${t.raw}\nSERVER_REQUIRED: ${t.serverRequired ? 'YES' : 'NO'}\nHARDWARE_REQUIRED: ${t.hardwareRequired ? 'YES' : 'NO'}\nSTATUS: BLOCKED\n`);
  }

  const summary = [
    `# AGENT_TODO – Background-Coder Pipeline`,
    `\nErzeugt: ${new Date().toISOString()}`,
    `\nLEICHT: ${ordered.LEICHT.length} · MITTEL: ${ordered.MITTEL.length} · SCHWER: ${ordered.SCHWER.length} · BLOCKED: ${ordered.BACKLOG.length}`,
    `\nFestes Modell-Routing: Orchestrator=DeepSeek V4 Flash Visionary (max thinking) · #2 Kimi K2.7-Code · #3 GLM-5.3 · #4 Qwen3-Coder-Next · #5 GLM-5.3-Flash · #6 DeepSeek V4 Pro`,
  ].join('\n');

  const md = summary + blocks.join('\n');
  writeFileSync(path.join(ROOT, 'AGENT_TODO.md'), md + '\n');
  writeFileSync(path.join(ROOT, 'AGENT_TODO.json'), JSON.stringify({
    created: new Date().toISOString(),
    counts: { LEICHT: ordered.LEICHT.length, MITTEL: ordered.MITTEL.length, SCHWER: ordered.SCHWER.length, BLOCKED: ordered.BACKLOG.length },
    tasks: [...ordered.LEICHT, ...ordered.MITTEL, ...ordered.SCHWER, ...ordered.BACKLOG],
  }, null, 2));

  console.log(`AGENT_TODO.md/JSON erzeugt: LEICHT=${ordered.LEICHT.length} MITTEL=${ordered.MITTEL.length} SCHWER=${ordered.SCHWER.length} BLOCKED=${ordered.BACKLOG.length}`);
}

main();
