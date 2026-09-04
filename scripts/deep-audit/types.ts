// Deep-Audit-System – gemeinsame Typen und Konstanten.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type StageStatus = 'pass' | 'warn' | 'fail' | 'skipped' | 'error';

export interface Finding {
  file: string;
  line: number | null;
  severity: Severity;
  category: string;
  title: string;
  message: string;
  evidence?: string;
  suggestion?: string;
  /** Quelle: tsc, eslint, knip, jscpd, npm-audit, semgrep, boundary, memo, bundle, deepseek-flash, hf-qwen, deepseek-pro ... */
  source: string;
  fingerprint: string;
}

export interface StageResult {
  name: string;
  status: StageStatus;
  findings: Finding[];
  summary?: string;
  durationMs: number;
}

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv: string[];
  temperature: number;
  maxTokens: number;
}

export interface AuditConfig {
  exclusions: string[];
  riskPatterns: string[];
  hotPatterns: string[];
  smokeFiles: string[];
  maxFileChars: number;
  maxAiBatchChars: number;
  maxAiFiles: number;
  providers: {
    deepseekFlash: ProviderConfig;
    deepseekPro: ProviderConfig;
    hfQwen: ProviderConfig;
  };
  thresholds: {
    failOn: Severity;
  };
}

export interface AuditReport {
  generatedAt: string;
  commit: string;
  branch: string;
  mode: string;
  scope: string[];
  providersUsed: string[];
  stages: StageResult[];
  findings: Finding[];
  passed: boolean;
  summary: string;
}

export interface RawAiFinding {
  file?: string;
  path?: string;
  line?: number | string | null;
  severity?: string;
  category?: string;
  title?: string;
  message?: string;
  evidence?: string;
  suggestion?: string;
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export function normalizeSeverity(value: unknown, fallback: Severity = 'medium'): Severity {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'critical' || v === 'kritisch' || v === 'p0') return 'critical';
    if (v === 'high' || v === 'hoch' || v === 'p1') return 'high';
    if (v === 'medium' || v === 'mittel' || v === 'p2') return 'medium';
    if (v === 'low' || v === 'niedrig' || v === 'p3') return 'low';
    if (v === 'info' || v === 'hinweis') return 'info';
  }
  return fallback;
}
