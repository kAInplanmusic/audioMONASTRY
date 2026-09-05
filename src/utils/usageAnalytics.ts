/**
 * audioMONASTRY · 6.1.3 – Anonymisierte Nutzungs-Analytik
 * ========================================================
 * Zählt Feature-Nutzung (Heatmap-Basis) ohne personenbezogene Daten.
 * Persistenz über den Storage-Adapter, Export als JSON.
 */
import { storageGetJson, storageSetJson } from './storage';

const KEY = 'audiomonastry_usage';

export interface UsageSnapshot {
  features: Record<string, number>;
  sessions: number;
}

const state: UsageSnapshot = storageGetJson<UsageSnapshot>(KEY) ?? { features: {}, sessions: 0 };

export function trackFeature(feature: string): void {
  state.features[feature] = (state.features[feature] ?? 0) + 1;
  persist();
}

export function trackSessionStart(): void {
  state.sessions += 1;
  persist();
}

export function usageSnapshot(): UsageSnapshot {
  return { features: { ...state.features }, sessions: state.sessions };
}

export function usageTop(n = 10): [string, number][] {
  return Object.entries(state.features)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function persist(): void {
  storageSetJson(KEY, state);
}
