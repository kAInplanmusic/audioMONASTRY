// Deep-Audit-System – KI-Review-Pässe (DeepSeek + Hugging Face).

import { existsSync, readFileSync } from 'node:fs';
import type { AuditConfig, Finding, ProviderConfig, RawAiFinding, StageResult } from './types.js';
import { normalizeSeverity } from './types.js';
import { fingerprintFinding } from './pattern.js';
import { findEnvKey } from './config.js';
import { parseJsonLoose } from './process.js';
import type { FileBatch, SelectedFile } from './files.js';
import { readFileNumbered } from './files.js';

const SYSTEM_PROMPT = `Du bist ein unabhängiger, evidenzbasierter Code-Auditor für eine komplexe Echtzeit-Audio-Web-App (React/TypeScript, Node/Express, WebAudio-Worklets, Socket.io/WebRTC, Python/Rust-Services).

Prüfe den übergebenen Code auf:
1. Security: Injection, unsichere Deserialisierung, fehlende Auth/RBAC-Prüfung, unvalidierte Socket-/Relay-Ziele, Secrets, Path Traversal, Error-Leaks an Clients.
2. Korrektheit/Bugs: Race Conditions, falsche Owner-/Lock-Vergleiche, State-Desync, kaputte Async-/Cleanup-Pfade, fehlerhafte Audio-Graph-Verdrahtung.
3. Echtzeit-/Audio-Sicherheit: Allokationen oder I/O im Audio-Worklet-Prozess, NaN/Infinity-Risiken, Denormals, PDC/Latenzfehler.
4. React/TypeScript: Stale Closures, fehlende Dependencies, unsafe any, unkontrollierte Non-Null-Assertions, Memo-/Rerender-Probleme.
5. Wartbarkeit/Architektur: Boundary-Verstöße, tote Implementierungen, Parallel-Implementierungen derselben Logik.

Regeln:
- Melde NUR konkrete, am Code belegbare Befunde mit Datei und Zeile. Keine Allgemeinplätze.
- Der Code kommt mit Zeilennummern im Format \` 123| code\`. Nutze GENAU die Nummer aus dem Präfix — nicht eine geschätzte Position.
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
    signal: AbortSignal.timeout(provider.requestTimeoutMs ?? 300_000),
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
  lineCounts: Record<string, number> = {},
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
    const rawLine = typeof item.line === 'number' && Number.isFinite(item.line) ? Math.trunc(item.line) : null;
    // Gegen den TATSÄCHLICH gesendeten Text prüfen: eine Zeile außerhalb davon
    // ist eine Erfindung des Modells — und schlimmer als keine Angabe, weil sie
    // im Report wie ein Beleg aussieht. Ist die Zeilenzahl unbekannt (anderer
    // Aufrufer), bleibt der Wert stehen: ohne Gegenprobe wird nichts verworfen.
    const sentLines = lineCounts[normalizedFile];
    const lineInRange =
      rawLine === null || sentLines === undefined || (rawLine >= 1 && rawLine <= sentLines);
    const line = lineInRange ? rawLine : null;
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

/** Fortschritt eines Batches — ohne solche Zeilen sieht ein langer Lauf wie ein Hänger aus. */
export interface BatchProgress {
  done: number;
  total: number;
  file: string;
  ms: number;
}

export interface AiPassDeps {
  /** Für Tests injizierbar; Standard ist der echte HTTP-Aufruf. */
  chat?: typeof chatCompletion;
  onProgress?: (info: BatchProgress) => void;
  now?: () => number;
}

export async function runAiPass(
  label: string,
  provider: ProviderConfig,
  batches: FileBatch[],
  config: AuditConfig,
  extraContext = '',
  deps: AiPassDeps = {},
): Promise<StageResult> {
  const chat = deps.chat ?? chatCompletion;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const existingFiles = collectExistingFiles(batches);
  const findings: Finding[] = [];
  let batchesDone = 0;
  let budgetHit = false;
  const errors: string[] = [];
  for (const batch of batches) {
    // Gesamt-Budget: Ein Request-Timeout begrenzt nur EINEN Aufruf. Ohne diese
    // Schranke dauert der Pass rechnerisch `Batches x Request-Timeout` — bei 120
    // Dateien und 5 min also bis zu 10 h. Am 2026-10-03 wirkte genau das wie ein
    // Hänger, weil der Pass dabei keine Zeile Fortschritt ausgibt.
    const elapsed = now() - startedAt;
    if (elapsed >= config.maxAiTotalMs) {
      budgetHit = true;
      errors.push(
        `Zeitbudget ${Math.round(config.maxAiTotalMs / 1000)} s erschoepft nach ${Math.round(elapsed / 1000)} s - `
        + `${batches.length - batchesDone} von ${batches.length} Batches uebersprungen`,
      );
      break;
    }
    const batchStartedAt = now();
    const batchFiles = batch.files.map((file) => file.path).join(', ');
    const userContent = `${extraContext}\n\nAudit-Batch (${batchesDone + 1}/${batches.length}) – Dateien: ${batchFiles}\n\n${batch.content}\n\nPrüfe jetzt diesen Batch.`;
    try {
      const rawText = await chat(provider, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ]);
      const parsed = parseJsonLoose<RawAiFinding[] | { findings?: RawAiFinding[] }>(rawText);
      const batchFindings = parseAiFindings(
        parsed,
        label,
        batch.files[0]?.path ?? 'unbekannt',
        existingFiles,
        batch.lineCounts ?? {},
      );
      findings.push(...batchFindings);
    } catch (error) {
      errors.push(`${batchFiles}: ${(error as Error).message}`);
    }
    batchesDone += 1;
    deps.onProgress?.({
      done: batchesDone,
      total: batches.length,
      file: batchFiles,
      ms: now() - batchStartedAt,
    });
  }
  const status = findings.length ? 'warn' : errors.length ? 'error' : 'pass';
  // Die Zusammenfassung steht so in der Statuszeile des Laufs: sie muss sagen,
  // WIE VIEL fehlt, nicht nur DASS etwas fehlt.
  const skipped = batches.length - batchesDone;
  const summary = errors.length
    ? `${findings.length} Findings, ${errors.length} Batch-Fehler${budgetHit ? ` (Budget erschoepft: ${skipped} von ${batches.length} uebersprungen)` : ''}`
    : `${findings.length} Findings`;
  return { name: label, status, findings, summary, durationMs: now() - startedAt };
}

export function makeReviewBatchesForFiles(
  root: string,
  config: AuditConfig,
  files: SelectedFile[],
): FileBatch[] {
  // Pro Datei einzeln reviewen (kein zusammenlegen), damit Zeilen/Datei-Zuordnung
  // eindeutig bleibt. Der Inhalt geht NUMMERIERT raus: ohne Präfixe muss das
  // Modell Zeilennummern schätzen (gemessen am 2026-10-03: 6 von 6 Findings um
  // ~63 Zeilen daneben), und `lineCounts` erlaubt die Gegenprüfung danach.
  return files.map((file) => {
    const { text, lines } = readFileNumbered(root, file.path, config.maxFileChars);
    return {
      files: [file],
      content: `\n===== DATEI: ${file.path} (Risiko: ${file.risk}) =====\n${text}\n`,
      lineCounts: { [file.path]: lines },
    };
  });
}

export function addAgentsContext(root: string): string {
  const file = `${root}/AGENTS.md`;
  if (!existsSync(file)) return '';
  return `\nProjekt-Architektur-Regeln (gekürzt aus AGENTS.md):\n${readFileSync(file, 'utf8').slice(0, 4000)}\n`;
}

export function hasProviderError(stage: StageResult): boolean {
  return stage.status === 'error';
}
