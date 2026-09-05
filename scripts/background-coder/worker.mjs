#!/usr/bin/env node
/**
 * Background-Coder WORKER
 * Überwacht AGENT_TODO.json, verarbeitet READY-Aufgaben sequenziell
 * (keine blinde Parallelisierung) und hält die Statusmaschine ein.
 *
 * Modellzuordnung ist FEST und kommt aus config.json.
 * Es werden keine API-Keys erfunden oder ersetzt – nur vorhandene Env-Variablen
 * aus .env / Prozess-Umgebung verwendet. Fehlt ein Key, wird die Aufgabe BLOCKED.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const CONFIG = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const TODO_JSON = path.join(ROOT, 'AGENT_TODO.json');
const TODO_MD = path.join(ROOT, 'AGENT_TODO.md');
const LOG_DIR = path.join(ROOT, 'logs', 'background-coder');

const STATUSES = [
  'DISCOVERED', 'CLASSIFIED', 'READY', 'ASSIGNED', 'RUNNING', 'IMPLEMENTED',
  'TESTING', 'REVIEW', 'APPROVED', 'REJECTED', 'REWORK', 'DONE', 'BLOCKED', 'FAILED',
];

function envKey(provider) {
  for (const k of provider.apiKeyEnv) {
    if (process.env[k]) return { key: k, value: process.env[k] };
  }
  return null;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    execSync(`mkdir -p "${LOG_DIR}"`);
    writeFileSync(path.join(LOG_DIR, 'worker.log'), line + '\n', { flag: 'a' });
  } catch { /* Logging best-effort */ }
}

async function chat(provider, messages, { maxTokens } = {}) {
  const cred = envKey(provider);
  if (!cred) throw new Error(`Kein API-Key für ${provider.name} (${provider.apiKeyEnv.join(' oder ')})`);
  const res = await fetch(provider.chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cred.value}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: provider.temperature,
      max_tokens: maxTokens ?? provider.maxTokens,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${provider.model} antwortete ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  return data.choices?.[0]?.message?.content ?? '';
}

function parseModelJson(content) {
  try {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}

function applyEdit(edit, changedFiles) {
  const file = path.join(ROOT, edit.path);
  if (!existsSync(file)) throw new Error(`Datei fehlt: ${edit.path}`);
  const src = readFileSync(file, 'utf8');
  const find = String(edit.find ?? '');
  if (!find) throw new Error('edit ohne find');
  const parts = src.split(find);
  if (parts.length !== 2) throw new Error(`find kommt ${parts.length - 1}x vor (erwartet 1x) in ${edit.path}`);
  const next = parts[0] + String(edit.replace ?? '') + parts[1];
  writeFileSync(file, next);
  changedFiles.add(file);
}

function runTsc() {
  try {
    execFileSync('npx', ['tsc', '--noEmit'], { cwd: ROOT, stdio: 'pipe', timeout: 120_000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, output: String(e.stdout || '') + String(e.stderr || '').slice(0, 2000) };
  }
}

function renderTodo(payload) {
  const tasks = payload.tasks;
  let md = `# AGENT_TODO – Background-Coder Pipeline\n\nErzeugt/Aktualisiert: ${new Date().toISOString()}\n\n`;
  for (const t of tasks) {
    md += `\n${t.taskId ?? 'TASK'}\nCLASS: ${t.class}\nDOMAIN: ${t.domain}\nDESCRIPTION: ${t.raw}\nIMPLEMENTATION_AGENT: ${t.agent}\nREVIEW_AGENT: ${t.reviewAgent ?? '-'}\nSERVER_REQUIRED: ${t.serverRequired ? 'YES' : 'NO'}\nHARDWARE_REQUIRED: ${t.hardwareRequired ? 'YES' : 'NO'}\nREVIEW_REQUIRED: ${t.reviewRequired}\nSTATUS: ${t.status}\n`;
    if (t.lastError) md += `ERROR: ${t.lastError}\n`;
  }
  writeFileSync(TODO_MD, md);
  writeFileSync(TODO_JSON, JSON.stringify({ ...payload, updated: new Date().toISOString() }, null, 2));
}

async function reviewWithPro(diffText, task) {
  const agent = CONFIG.agents[task.reviewAgent];
  if (!agent || !envKey(agent)) {
    return { approved: false, reason: `Review-Agent ${task.reviewAgent} nicht konfiguriert (Key fehlt)` };
  }
  const content = await chat(agent, [
    { role: 'system', content: 'Du bist unabhängiger Reviewer. Antworte NUR mit APPROVED oder REJECTED und einem kurzen Grund.' },
    { role: 'user', content: `Aufgabe: ${task.raw}\n\nDiff/Änderungen:\n${diffText}\n\nEntscheide: APPROVED oder REJECTED?` },
  ]);
  const approved = /APPROVED/i.test(content);
  const reason = content.replace(/APPROVED|REJECTED/gi, '').trim().slice(0, 300);
  return { approved, reason: reason || (approved ? 'ok' : 'review abgelehnt') };
}

async function processTask(task, dryRun) {
  task.status = 'ASSIGNED';
  const provider = CONFIG.agents[task.agent];
  if (!provider) {
    task.status = 'FAILED';
    task.lastError = `Unbekannter Agent ${task.agent}`;
    return;
  }
  if (!envKey(provider)) {
    task.status = 'BLOCKED';
    task.lastError = `Kein API-Key für ${provider.name} (${provider.apiKeyEnv.join(' oder ')}). Schlüssel in .env ergänzen.`;
    return;
  }
  task.status = 'RUNNING';
  if (dryRun) {
    task.status = task.reviewRequired === 'YES' ? 'REVIEW' : 'DONE';
    task.lastError = 'DRY-RUN: Modellaufruf übersprungen';
    return;
  }

  const prompt = `Du bist der Implementierungs-Worker "${provider.name}" in einer Coding-Pipeline.
Führe folgende Aufgabe im Repo audioMONASTRY aus:
${task.raw}

Antworte AUSSCHLIESSLICH als JSON-Objekt:
{"summary":"kurz was gemacht wurde","edits":[{"path":"relative/datei","find":"exakter alter Code (kommt genau 1x vor)","replace":"neuer Code"}]}
oder {"summary":"...","edits":[]}

Regeln:
- find muss EXAKT im Repo vorkommen und darf genau einmal vorkommen.
- Keine neuen Dateien erfinden, wenn nicht nötig.
- Keine Secrets/API-Keys.
- Wenn du die Aufgabe nicht automatisieren kannst, liefere edits:[] und summary mit Grund.`;
  let content;
  try {
    content = await chat(provider, [
      { role: 'system', content: 'Coding-Pipeline. Präzise JSON-Antworten.' },
      { role: 'user', content: prompt },
    ], { maxTokens: provider.maxTokens });
  } catch (e) {
    task.status = 'FAILED';
    task.lastError = String(e.message || e).slice(0, 500);
    return;
  }
  const parsed = parseModelJson(content);
  if (!parsed) {
    task.status = 'FAILED';
    task.lastError = 'Modell lieferte kein gültiges JSON';
    return;
  }
  task.lastSummary = String(parsed.summary ?? '').slice(0, 300);
  const changedFiles = new Set();
  let applied = 0;
  for (const edit of (parsed.edits ?? [])) {
    try {
      applyEdit(edit, changedFiles);
      applied += 1;
    } catch (e) {
      // Edit ablehnen, vorherige Änderungen zurücksetzen
      for (const f of changedFiles) {
        try { execSync(`git checkout -- "${f}"`, { cwd: ROOT, stdio: 'pipe' }); } catch { /* ignore */ }
      }
      task.status = 'FAILED';
      task.lastError = `Edit fehlgeschlagen: ${e.message}`;
      return;
    }
  }

  task.status = applied > 0 ? 'IMPLEMENTED' : 'IMPLEMENTED';
  task.status = 'TESTING';
  const tsc = runTsc();
  if (!tsc.ok) {
    for (const f of changedFiles) {
      try { execSync(`git checkout -- "${f}"`, { cwd: ROOT, stdio: 'pipe' }); } catch { /* ignore */ }
    }
    task.status = 'FAILED';
    task.lastError = `tsc fehlgeschlagen: ${tsc.output.slice(0, 500)}`;
    return;
  }

  if (task.reviewRequired === 'YES') {
    task.status = 'REVIEW';
    const diffText = [...changedFiles].map((f) => `${f}\n`).join('');
    const review = await reviewWithPro(diffText, task);
    if (review.approved) {
      task.status = 'APPROVED';
      task.status = 'DONE';
      task.lastError = '';
    } else {
      task.reworkCount = (task.reworkCount ?? 0) + 1;
      if (task.reworkCount <= 2) {
        task.status = 'REWORK';
        task.lastError = `Review: ${review.reason}`;
      } else {
        task.status = 'FAILED';
        task.lastError = `Review endgültig abgelehnt: ${review.reason}`;
      }
    }
  } else {
    task.status = 'DONE';
    task.lastError = '';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const daemon = args.includes('--daemon');
  const once = args.includes('--once') || !daemon;
  const dryRun = args.includes('--dry-run');

  if (!existsSync(TODO_JSON)) {
    log('AGENT_TODO.json fehlt. Bitte Orchestrator ausführen: node scripts/background-coder/orchestrator.mjs');
    process.exit(1);
  }

  do {
    const payload = JSON.parse(readFileSync(TODO_JSON, 'utf8'));
    const ready = payload.tasks.filter((t) => t.status === 'READY' || t.status === 'REWORK');
    if (ready.length === 0) {
      if (once) { log('Keine READY/REWORK-Aufgaben.'); break; }
    } else {
      for (const task of ready) {
        log(`Verarbeite ${task.taskId} (${task.class}/${task.domain}) → ${task.agent}`);
        await processTask(task, dryRun);
        renderTodo(payload);
      }
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, 20_000));
  } while (daemon);
}

main().catch((e) => { log(`Worker-Fehler: ${e.stack || e}`); process.exit(1); });
