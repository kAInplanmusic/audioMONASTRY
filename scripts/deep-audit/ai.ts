// Deep-Audit-System – KI-Review-Pässe (DeepSeek + Hugging Face).

import { existsSync, readFileSync } from 'node:fs';
import type { AuditConfig, Finding, ProviderConfig, RawAiFinding, Severity, StageResult } from './types.js';
import { normalizeSeverity } from './types.js';
import { fingerprintFinding } from './pattern.js';
import { findEnvKey } from './config.js';
import { parseJsonLoose } from './process.js';
import type { FileBatch, SelectedFile } from './files.js';
import { readFileContent } from './files.js';

const SYSTEM_PROMPT = `Du bist ein unabhängiger, evidenzbasierter Code-Auditor für eine komplexe Echtzeit-Audio-Web-App (React/TypeScript, Node/Express, WebAudio-Worklets, Socket.io/WebRTC, Python/Rust-Services).

Prüfe den übergebenen Code auf:
1. Security: Injection, unsichere Deserialisierung, fehlende Auth/RBAC-Prüfung, unvalidierte Socket-/Relay-Ziele, Secrets, Path Traversal, Error-Leaks an Clients.
2. Korrektheit/Bugs: Race Conditions, falsche Owner-/Lock-Vergleiche, State-Desync, kaputte Async-/Cleanup-Pfade, fehlerhafte Audio-Graph-Verdrahtung.
3. Echtzeit-/Audio-Sicherheit: Allokationen oder I/O im Audio-Worklet-Prozess, NaN/Infinity-Risiken, Denormals, PDC/Latenzfehler.
4. React/TypeScript: Stale Closures, fehlende Dependencies, unsafe any, unkontrollierte Non-Null-Assertions, Memo-/Rerender-Probleme.
5. Wartbarkeit/Architektur: Boundary-Verstöße, tote Implementierungen, Parallel-Implementierungen derselben Logik.

Regeln:
- Melde NUR konkrete, am Code belegbare Befunde mit Datei und Zeile. Keine Allgemeinplätze.
- Keine Style-Nits, die ein Linter ohnehin findet.
- Wenn du nichts Konkretes findest, liefere ein leeres Array.
- Antworte NUR mit einem JSON-Objekt dieser Form:
{"findings":[{"file":"<datei>","line":<zahl oder null>,"severity":"critical|high|medium|low|info","category":"security|bug|realtime-audio|react|architecture|dependency|performance|other","title":"<kurzer Titel>","message":"<konkrete Beschreibung>","evidence":"<Code/Zeile als Beweis>","suggestion":"<konkreter Fix>"}]}`;

export interface AiReviewOptions {
  batchLabel?: string;
}

export async function chatCompletion(
  provider: ProviderConfig,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<string> {
  const apiKey = findEnvKey(provider.apiKeyEnv);
  if (!apiKey) throw new Error(`Kein API-Key für ${provider.model} gefunden (${provider.apiKeyEnv.join(' oder ')})`);
  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: provider.temperature,
      max_tokens: provider.maxTokens,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM-API ${provider.model} antwortete ${response.status}: ${text.slice(0, 1000)}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '';
  return content;
}

export function parseAiFindings(
  raw: RawAiFinding[] | unknown,
  source: string,
  defaultFile: string,
  existingFiles: string[],
): Finding[] {
  const files = new Set(existingFiles);
  const findings: Finding[] = [];
  const items = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { findings?: RawAiFinding[] })?.findings)
      ? ((raw as { findings: RawAiFinding[] }).findings)
      : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const fileCandidate = typeof item.file === 'string' && item.file ? item.file : typeof item.path === 'string' && item.path ? item.path : defaultFile;
    const file = fileCandidate.replaceAll('\\', '/');
    const normalizedFile = files.has(file) ? file : defaultFile;
    const line = typeof item.line === 'number' && Number.isFinite(item.line) ? item.line : null;
    const severity = normalizeSeverity(item.severity, 'medium');
    const category = typeof item.category === 'string' && item.category ? item.category : 'other';
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'AI-Finding';
    const message = typeof item.message === 'string' && item.message.trim() ? item.message.trim() : title;
    findings.push({
      file: normalizedFile,
      line,
      severity,
      category,
      title,
      message,
      evidence: typeof item.evidence === 'string' ? item.evidence.slice(0, 2000) : undefined,
      suggestion: typeof item.suggestion === 'string' ? item.suggestion.slice(0, 2000) : undefined,
      source,
      fingerprint: fingerprintFinding({
        file: normalizedFile,
        line,
        category,
        message,
        source,
      }),
    });
  }
  return findings;
}

function collectExistingFiles(batches: FileBatch[]): string[] {
  return batches.flatMap((batch) => batch.files.map((file) => file.path));
}

export async function runAiPass(
  label: string,
  provider: ProviderConfig,
  batches: FileBatch[],
  config: AuditConfig,
  extraContext = '',
): Promise<StageResult> {
  const startedAt = Date.now();
  const existingFiles = collectExistingFiles(batches);
  const findings: Finding[] = [];
  let batchesDone = 0;
  let errors: string[] = [];
  for (const batch of batches) {
    const batchFiles = batch.files.map((file) => file.path).join(', ');
    const userContent = `${extraContext}\n\nAudit-Batch (${batchesDone + 1}/${batches.length}) – Dateien: ${batchFiles}\n\n${batch.content}\n\nPrüfe jetzt diesen Batch.`;
    try {
      const rawText = await chatCompletion(provider, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ]);
      const parsed = parseJsonLoose<RawAiFinding[] | { findings?: RawAiFinding[] }>(rawText);
      const batchFindings = parseAiFindings(parsed, label, batch.files[0]?.path ?? 'unbekannt', existingFiles);
      findings.push(...batchFindings);
    } catch (error) {
      errors.push(`${batchFiles}: ${(error as Error).message}`);
    }
    batchesDone += 1;
  }
  const status = findings.length ? 'warn' : errors.length ? 'error' : 'pass';
  const summary = errors.length ? `${findings.length} Findings, ${errors.length} Batch-Fehler` : `${findings.length} Findings`;
  return { name: label, status, findings, summary, durationMs: Date.now() - startedAt };
}

export function makeReviewBatchesForFiles(
  root: string,
  config: AuditConfig,
  files: SelectedFile[],
): FileBatch[] {
  // Pro Datei einzeln reviewen (kein zusammenlegen), damit Zeilen/Datei-Zuordnung eindeutig bleibt.
  return files.map((file) => ({
    files: [file],
    content: `\n===== DATEI: ${file.path} (Risiko: ${file.risk}) =====\n${readFileContent(root, file.path, config.maxFileChars)}\n`,
  }));
}

export function addAgentsContext(root: string): string {
  const file = `${root}/AGENTS.md`;
  if (!existsSync(file)) return '';
  return `\nProjekt-Architektur-Regeln (gekürzt aus AGENTS.md):\n${readFileSync(file, 'utf8').slice(0, 4000)}\n`;
}

export function hasProviderError(stage: StageResult): boolean {
  return stage.status === 'error';
}
