import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { POD_ROLE_IDS, POD_START_TRIGGERS, podsForTrigger, fleetMode } from '../src/core/ai/orchestrator/podRouting';

const fleet = JSON.parse(readFileSync('deploy/gpu/pod-fleet.json', 'utf8'));
afterEach(() => {
  delete process.env.AI_GPU_PROVIDER; delete process.env.AI_FLEET_MODE; });

describe('8×A40 Start-Regeln: sieben KI plus vis', () => {
  it('aktiviert im Pod-Deploy alle sieben KI-Rollen mit der Studiositzung', () => {
    process.env.AI_FLEET_MODE = 'pods';
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
