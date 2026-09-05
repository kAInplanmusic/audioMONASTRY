#!/usr/bin/env node
/**
 * Background-Coder WORKER (Cerebras-/PublicAI-direkt, HF-Router optional)
 *
 * - Liest AGENT_TODO.json (von Orchestrator erzeugt)
 * - Verarbeitet PENDING/RETRY-Aufgaben sequenziell (keine blinde Parallelisierung)
 * - LLM-Aufrufe: Agents mit chatUrl="cerebras" → Cerebras-API (CB_API_KEY),
 *   chatUrl="publicai" → PublicAI (PUBLICAI_KEY), sonst hfRouter (HF Router)
 * - Sichere Patch-Anwendung: exakte Snippets, genau 1 Treffer, sonst Revert
 * - tsc-Gate nach Änderungen, Review für SECURITY/COMPLIANCE/HOTFIX
 * - Quota/Billing-Fehler (402/429) → BLOCKED, keine Endlosschleifen
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { hfRouter, QuotaPausedError } from './hfRouter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const CONFIG = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const TODO_JSON = path.join(ROOT, 'AGENT_TODO.json');
const TODO_MD = path.join(ROOT, 'AGENT_TODO.md');
const LOG_DIR = path.join(ROOT, 'logs', 'background-coder');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    execSync(`mkdir -p "${LOG_DIR}"`);
    writeFileSync(path.join(LOG_DIR, 'worker.log'), line + '\n', { flag: 'a' });
  } catch { /* Logging best-effort */ }
}

function modelFor(task) {
  if (task.agent === 'MOA') return CONFIG.orchestrator;
  return CONFIG.agents[task.agent];
}

/** OpenAI-kompatibler Direkt-Chat für Agents mit chatUrl="cerebras" bzw. "publicai". */
async function directChat(provider, messages, { maxTokens } = {}) {
  const isCerebras = provider.chatUrl === 'cerebras';
  const baseUrl = isCerebras
    ? 'https://api.cerebras.ai/v1'
    : (process.env.PUBLICAI_BASE_URL || 'https://api.publicai.co/v1').replace(/\/+$/, '');
  const apiKey = isCerebras
    ? process.env.CB_API_KEY?.trim()
    : process.env.PUBLICAI_KEY?.trim();
  if (!apiKey) throw new Error(isCerebras ? 'CB_API_KEY fehlt' : 'PUBLICAI_KEY fehlt');
  const modelId = isCerebras
    ? (process.env.CEREBRAS_MODEL?.trim() || provider.model)
    : (process.env.PUBLICAI_MODEL?.trim() || provider.model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({ model: modelId, messages, temperature: provider.temperature ?? 0.1, max_tokens: maxTokens ?? provider.maxTokens ?? 4096 }),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${isCerebras ? 'Cerebras' : 'PublicAI'} ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(text);
    const msg = data.choices?.[0]?.message ?? {};
    // Reasoning-Modelle (z. B. qwen) liefern manchmal leeren content;
    // dann auf den Reasoning-Text zurückfallen.
    return { content: (msg.content ?? '').trim() || (msg.reasoning ?? '') };
  } finally {
    clearTimeout(timeout);
  }
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

function resolveRepoFile(rel) {
  const candidates = [
    rel,
    path.join('services', rel),
    path.join('src', rel),
    path.join('public', rel),
  ];
  for (const cand of candidates) {
    const abs = path.join(ROOT, cand);
    if (existsSync(abs)) return abs;
  }
  return null;
}

function applyEdit(edit, changedFiles) {
  const file = resolveRepoFile(edit.path);
  if (!file) throw new Error(`Datei fehlt: ${edit.path}`);
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
  let md = `# AGENT_TODO – Background-Coder Pipeline (HF + Cerebras #7)\n\nAktualisiert: ${new Date().toISOString()}\n\n`;
  for (const t of payload.tasks) {
    md += `\n${t.taskId ?? 'TASK'}\nCLASS: ${t.class}\nDOMAIN: ${t.domain}\nDESCRIPTION: ${t.raw}\nIMPLEMENTATION_AGENT: ${t.agent}\nMODEL: ${modelFor(t)?.model ?? '-'}\nREVIEW_AGENT: ${t.reviewAgent ?? '-'}\nSERVER_REQUIRED: ${t.serverRequired ? 'YES' : 'NO'}\nHARDWARE_REQUIRED: ${t.hardwareRequired ? 'YES' : 'NO'}\nSTATUS: ${t.status}\n`;
    if (t.lastError) md += `ERROR: ${t.lastError}\n`;
  }
  writeFileSync(TODO_MD, md);
  writeFileSync(TODO_JSON, JSON.stringify({ ...payload, updated: new Date().toISOString() }, null, 2));
}

function markMasterDone(raw) {
  const masterPath = path.join(ROOT, 'MASTER_TODO.md');
  try {
    const lines = readFileSync(masterPath, 'utf8').split(/\r?\n/);
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('- [ ] ') && lines[i].slice(6).trim() === raw) {
        lines[i] = `- [x] ${raw}`;
        changed = true;
        break;
      }
    }
    if (changed) writeFileSync(masterPath, lines.join('\n'));
  } catch { /* MASTER_TODO nicht aktualisierbar */ }
}

async function reviewWithModel(diffText, task) {
  const agent = CONFIG.agents[task.reviewAgent];
  if (!agent) return { approved: false, reason: `Review-Agent ${task.reviewAgent} fehlt` };
  try {
    const messages = [
      { role: 'system', content: 'Du bist unabhängiger Reviewer. Antworte NUR mit APPROVED oder REJECTED und einem kurzen Grund.' },
      { role: 'user', content: `Aufgabe: ${task.raw}\n\nDiff/Änderungen:\n${diffText}\n\nAPPROVED oder REJECTED?` },
    ];
    const res = agent.chatUrl
      ? await directChat(agent, messages)
      : await hfRouter.chat({ modelId: agent.model, messages });
    const approved = /APPROVED/i.test(res.content);
    const reason = res.content.replace(/APPROVED|REJECTED/gi, '').trim().slice(0, 300);
    return { approved, reason: reason || (approved ? 'ok' : 'review abgelehnt') };
  } catch (e) {
    return { approved: false, reason: `Review fehlgeschlagen: ${e.message}` };
  }
}

function taskFileContext(task) {
  const re = /([A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|cjs|py|rs|json|sh|sql|md))/g;
  const found = new Set();
  let m;
  while ((m = re.exec(task.raw)) !== null) found.add(m[1]);
  let ctx = '';
  for (const rel of [...found].slice(0, 6)) {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) continue;
    try {
      const content = readFileSync(abs, 'utf8').slice(0, 6000);
      ctx += `\n===== Datei: ${rel} =====\n${content}\n`;
    } catch { /* ignore */ }
  }
  return ctx;
}

async function processTask(task, dryRun) {
  const provider = modelFor(task);
  if (!provider) {
    task.status = 'FAILED';
    task.lastError = `Unbekannter Agent/Modell: ${task.agent}`;
    return;
  }
  if (provider.chatUrl) {
    const keyName = provider.chatUrl === 'cerebras' ? 'CB_API_KEY' : 'PUBLICAI_KEY';
    if (!(process.env[keyName] || '').trim()) {
      task.status = 'BLOCKED';
      task.lastError = `${keyName} fehlt`;
      return;
    }
  } else {
    if (!hfRouter.apiKey()) {
      task.status = 'BLOCKED';
      task.lastError = 'HF_TOKEN/HF_API_KEY fehlt';
      return;
    }
    if (hfRouter.isPaused()) {
      task.status = 'BLOCKED';
      task.lastError = `HF-Pipeline pausiert: ${hfRouter.pausedReason}`;
      return;
    }
  }
  task.status = 'RUNNING';
  if (dryRun) {
    task.status = 'TESTING';
    task.status = task.reviewRequired === 'YES' ? 'REVIEW' : 'COMPLETED';
    task.lastError = 'DRY-RUN: Modellaufruf übersprungen';
    return;
  }

  const prompt = `Du bist der Implementierungs-Agent "${provider.name}" in einer Coding-Pipeline.
Führe folgende Aufgabe im Repo audioMONASTRY aus:
${task.raw}

Repo-Kontext der betroffenen Dateien:
${taskFileContext(task) || '(keine eindeutigen Dateipfade erkannt)'}

Antworte AUSSCHLIESSLICH als JSON-Objekt:
{"summary":"...","edits":[{"path":"relative/datei","find":"exakter alter Code (kommt genau 1x vor)","replace":"neuer Code"}]}
oder {"summary":"...","edits":[]}

Regeln:
- find muss EXAKT im Repo vorkommen und genau einmal.
- Keine neuen Dateien ohne Notwendigkeit.
- Keine Secrets/API-Keys.
- Wenn nicht automatisierbar: edits:[] und Grund in summary.`;

  let content;
  try {
    const messages = [
      { role: 'system', content: 'Coding-Pipeline. Präzise JSON-Antworten.' },
      { role: 'user', content: prompt },
    ];
    const res = provider.chatUrl
      ? await directChat(provider, messages)
      : await hfRouter.chat({ modelId: provider.model, messages });
    content = res.content;
  } catch (e) {
    if (e instanceof QuotaPausedError) {
      task.status = 'BLOCKED';
      task.lastError = e.message;
      hfRouter.pause(e.message);
      return;
    }
    if (e?.status === 402 || e?.status === 429) {
      task.status = 'BLOCKED';
      task.lastError = e.message;
      return;
    }
    task.status = task.retryCount >= 2 ? 'FAILED' : 'RETRY';
    task.retryCount = (task.retryCount ?? 0) + 1;
    task.lastError = `Modellfehler: ${e.message}`;
    return;
  }

  const parsed = parseModelJson(content);
  if (!parsed) {
    task.status = task.retryCount >= 2 ? 'FAILED' : 'RETRY';
    task.retryCount = (task.retryCount ?? 0) + 1;
    task.lastError = 'Modell lieferte kein gültiges JSON';
    return;
  }

  task.lastSummary = String(parsed.summary ?? '').slice(0, 300);
  const changedFiles = new Set();
  for (const edit of (parsed.edits ?? [])) {
    try {
      applyEdit(edit, changedFiles);
    } catch (e) {
      for (const f of changedFiles) {
        try { execSync(`git checkout -- "${f}"`, { cwd: ROOT, stdio: 'pipe' }); } catch { /* ignore */ }
      }
      task.status = 'FAILED';
      task.lastError = `Edit fehlgeschlagen: ${e.message}`;
      return;
    }
  }

  task.status = 'TESTING';
  const tsc = runTsc();
  if (!tsc.ok) {
    for (const f of changedFiles) {
      try { execSync(`git checkout -- "${f}"`, { cwd: ROOT, stdio: 'pipe' }); } catch { /* ignore */ }
    }
    task.status = task.retryCount >= 2 ? 'FAILED' : 'RETRY';
    task.retryCount = (task.retryCount ?? 0) + 1;
    task.lastError = `tsc fehlgeschlagen: ${tsc.output.slice(0, 500)}`;
    return;
  }

  if (task.reviewRequired === 'YES') {
    task.status = 'REVIEW';
    const diffText = [...changedFiles].map((f) => `${f}\n`).join('');
    const review = await reviewWithModel(diffText, task);
    if (review.approved) {
      task.status = 'COMPLETED';
      task.lastError = '';
      markMasterDone(task.raw);
    } else {
      task.reworkCount = (task.reworkCount ?? 0) + 1;
      task.status = task.reworkCount <= 2 ? 'RETRY' : 'FAILED';
      task.lastError = `Review: ${review.reason}`;
    }
  } else {
    task.status = 'COMPLETED';
    task.lastError = '';
    markMasterDone(task.raw);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const daemon = args.includes('--daemon');
  const once = args.includes('--once') || !daemon;
  const dryRun = args.includes('--dry-run');

  if (!existsSync(TODO_JSON)) {
    log('AGENT_TODO.json fehlt. Orchestrator zuerst ausführen.');
    process.exit(1);
  }

  do {
    const payload = JSON.parse(readFileSync(TODO_JSON, 'utf8'));
    const pending = payload.tasks.filter((t) => t.status === 'PENDING' || t.status === 'RETRY');
    if (pending.length === 0) {
      if (once) { log('Keine PENDING/RETRY-Aufgaben.'); break; }
    } else {
      for (const task of pending) {
        log(`Verarbeite ${task.taskId} (${task.class}/${task.domain}) → ${task.agent}`);
        task.status = 'ASSIGNED';
        await processTask(task, dryRun);
        renderTodo(payload);
        if (hfRouter.isPaused()) break;
      }
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, 20_000));
  } while (daemon);
}

main().catch((e) => { log(`Worker-Fehler: ${e.stack || e}`); process.exit(1); });
