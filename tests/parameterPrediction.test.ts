import { describe, expect, it } from 'vitest';
import {
  rankAutomationCandidates,
  recencyWeight,
  suggestAutomationValue,
  suggestNextForPlugin,
} from '../src/core/ai/parameterPrediction';
import type { MoaHistoryEntry } from '../src/core/ai/MoaHistory';

const NOW = 1_800_000_000_000;

function entry(pluginId: string, task: string, result: string, ageMs: number): MoaHistoryEntry {
  return { pluginId, task, provider: 'mock', results: [result], at: NOW - ageMs };
}

describe('AM-E6-4: Heuristische Parameter-Vorhersage', () => {
  it('recencyWeight zerfällt exponentiell (Halbwertszeit)', () => {
    expect(recencyWeight(NOW, NOW)).toBe(1);
    expect(recencyWeight(NOW - 30 * 60 * 1000, NOW)).toBeCloseTo(0.5, 5);
    expect(recencyWeight(NOW - 60 * 60 * 1000, NOW)).toBeCloseTo(0.25, 5);
    // Zukunft wird nicht negativ gewichtet.
    expect(recencyWeight(NOW + 5000, NOW)).toBe(1);
  });

  it('rankAutomationCandidates: häufiger + aktueller gewinnt', () => {
    const entries = [
      entry('drum', 'pattern', 'four', 0),
      entry('drum', 'pattern', 'four', 5 * 60 * 1000),
      entry('drum', 'pattern', 'break', 60 * 60 * 1000), // alt → weniger Gewicht
      entry('drum', 'pattern', 'break', 120 * 60 * 1000),
    ];
    const ranked = rankAutomationCandidates(entries, 'drum', 'pattern', NOW);
    expect(ranked[0].value).toBe('four');
    expect(ranked[0].count).toBe(2);
    expect(ranked[1].value).toBe('break');
    expect(ranked[0].weight).toBeGreaterThan(ranked[1].weight);
  });

  it('filtert nach Plugin und Task', () => {
    const entries = [
      entry('drum', 'pattern', 'four', 0),
      entry('sampler', 'pattern', 'pad1', 0),
      entry('drum', 'kit', '909', 0),
    ];
    expect(rankAutomationCandidates(entries, 'drum', 'pattern', NOW)).toHaveLength(1);
    expect(rankAutomationCandidates(entries, 'drum', 'kit', NOW)[0].value).toBe('909');
    expect(rankAutomationCandidates(entries, 'unbekannt', 'pattern', NOW)).toHaveLength(0);
  });

  it('suggestAutomationValue liefert Konfidenz und basedOn', () => {
    const entries = [
      entry('mcp', 'pattern', 'four', 0),
      entry('mcp', 'pattern', 'four', 0),
      entry('mcp', 'pattern', 'random', 60 * 60 * 1000),
    ];
    const s = suggestAutomationValue(entries, 'mcp', 'pattern', NOW);
    expect(s).not.toBeNull();
    expect(s!.value).toBe('four');
    expect(s!.basedOn).toBe(3);
    expect(s!.confidence).toBeGreaterThan(0.5);
    expect(s!.confidence).toBeLessThanOrEqual(1);
    expect(suggestAutomationValue([], 'mcp', 'pattern', NOW)).toBeNull();
  });

  it('suggestNextForPlugin wählt den stärksten Task-Kandidaten', () => {
    const entries = [
      entry('synth', 'note', 'C3', 0),
      entry('synth', 'note', 'C3', 0),
      entry('synth', 'program', 'pad', 60 * 60 * 1000),
    ];
    const s = suggestNextForPlugin(entries, 'synth', NOW);
    expect(s).not.toBeNull();
    expect(s!.task).toBe('note');
    expect(s!.value).toBe('C3');
    expect(suggestNextForPlugin(entries, 'drum', NOW)).toBeNull();
  });
});
