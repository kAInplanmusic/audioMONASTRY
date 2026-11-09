import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POD_ROLE_IDS, POD_START_TRIGGERS, podsForTrigger, fleetMode } from '../src/core/ai/orchestrator/podRouting';

const fleet = JSON.parse(readFileSync('deploy/runpod/pod-fleet.json', 'utf8'));

describe('8×A40 Start-Regeln: sieben KI plus vis', () => {
  it('aktiviert alle sieben KI-Rollen immer zusammen mit der Studiositzung', () => {
    expect(fleetMode()).toBe('pods');
    expect(podsForTrigger('always')).toEqual([...POD_ROLE_IDS]);
    expect(podsForTrigger('aiGeneration')).toEqual([]);
    expect(podsForTrigger('stemMONK')).toEqual([]);
    expect(Object.values(POD_START_TRIGGERS).every(x => x === 'always')).toBe(true);
    expect(fleet.pods.every((p: any) => p.startTrigger === 'always')).toBe(true);
    expect(fleet.visPod.enabled).toBe(true);
    expect(fleet.visPod.startTrigger).toBe('always');
  });
});
