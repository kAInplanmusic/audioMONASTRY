// Deep-Audit-System – Konfiguration laden (Default + .deepaudit.json + CLI-Overrides).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AuditConfig, ProviderConfig, Severity } from './types.js';

const DEFAULT_CONFIG: AuditConfig = {
  exclusions: [
    'node_modules/**',
    'dist/**',
    'coverage/**',
    'logs/**',
    'test-results/**',
    'playwright-report/**',
    'public/models/**',
    'public/data/orchestral/**',
    'public/sfu-rtp-test.js',
    'public/worklets/**',
    '**/*.min.js',
    '**/*.map',
    '**/target/**',
    '**/__pycache__/**',
    'bun.lock',
    'package-lock.json',
  ],
  riskPatterns: [
    'server.ts',
    'server/**',
    'services/**',
    'database/**',
    'supabase/**',
    'src/core/**',
    'src/context/**',
    'src/hooks/**',
    'src/utils/WebRTCManager.ts',
    'src/utils/audioEngine.ts',
    'src/audio/**',
    '.github/**',
    'Dockerfile*',
    'docker-compose*.yml',
    'Caddyfile',
    'scripts/**',
  ],
  hotPatterns: [
    'server.ts',
    'server/**',
    'services/samplemonk-ai-runtime/**',
    'services/backend-core/**',
    'src/utils/audioEngine.ts',
    'src/utils/WebRTCManager.ts',
    'src/context/PluginManagerContext.tsx',
    'src/context/ModuleStateContext.tsx',
    'src/hooks/usePluginState.ts',
    'src/hooks/useSessionSync.ts',
    'src/App.tsx',
    'database/**/*.sql',
  ],
  smokeFiles: ['server.ts', 'src/context/PluginManagerContext.tsx'],
  maxFileChars: 60000,
  maxAiBatchChars: 40000,
  maxAiFiles: 120,
  providers: {
    deepseekFlash: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKeyEnv: ['DEEPSEEK_API_KEY', 'API_KEY'],
      temperature: 0.2,
      maxTokens: 4096,
    },
    deepseekPro: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      apiKeyEnv: ['DEEPSEEK_API_KEY', 'API_KEY'],
      temperature: 0.1,
      maxTokens: 8192,
    },
    hfQwen: {
      baseUrl: 'https://router.huggingface.co/v1',
      model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct:featherless-ai',
      apiKeyEnv: ['HF_API_KEY', 'HF_TOKEN'],
      temperature: 0.1,
      maxTokens: 4096,
    },
  },
  thresholds: {
    failOn: 'critical',
  },
};

function deepMerge<T>(base: T, override: unknown): T {
  if (Array.isArray(base) && Array.isArray(override)) {
    return override as T;
  }
  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
      if (key in out) {
        out[key] = deepMerge(out[key], value);
      } else {
        out[key] = value;
      }
    }
    return out as T;
  }
  return override === undefined ? base : (override as T);
}

export function findRepoRoot(start = process.cwd()): string {
  let current = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

export function loadConfig(root = findRepoRoot()): AuditConfig {
  const configPath = path.join(root, '.deepaudit.json');
  let fileConfig: unknown = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      console.error(`⚠️  .deepaudit.json konnte nicht gelesen werden: ${(error as Error).message}`);
    }
  }
  return deepMerge(structuredClone(DEFAULT_CONFIG), fileConfig) as AuditConfig;
}

export function findEnvKey(candidates: string[]): string | undefined {
  for (const key of candidates) {
    const value = process.env[key];
    if (value && value.length > 0) return value;
  }
  return undefined;
}

export function providerReady(config: ProviderConfig): boolean {
  return Boolean(findEnvKey(config.apiKeyEnv));
}

export function isFailSeverity(severity: Severity, failOn: Severity): boolean {
  const order: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  return order[severity] >= order[failOn];
}

export function resolveFailOn(value: string | undefined, fallback: Severity): Severity | 'none' {
  if (value === 'critical' || value === 'high' || value === 'none') return value;
  return fallback;
}
