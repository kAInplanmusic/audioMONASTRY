import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { POD_ROLE_IDS, POD_START_TRIGGERS, fleetMode, podBaseUrl, podRoleFor, podToken } from '../src/core/ai/orchestrator/podRouting';

const fleet = JSON.parse(readFileSync('deploy/runpod/pod-fleet.json', 'utf8'));
afterEach(() => {
  for (const p of POD_ROLE_IDS) {
    delete process.env[`RP_POD_ID_${p.toUpperCase().replace(/-/g, '_')}`];
    delete process.env[`RP_POD_URL_${p.toUpperCase().replace(/-/g, '_')}`];
  }
  delete process.env.AI_POD_TOKEN;
  delete process.env.AI_FLEET_MODE;
});

describe('SSOT Pod-Routing', () => {
  it('benutzt im freigegebenen Pod-Deploy die sieben A40 KI-Pods', () => {
    process.env.AI_FLEET_MODE = 'pods';
    expect(fleetMode()).toBe('pods');
    expect([...POD_ROLE_IDS]).toEqual(fleet.pods.map((p: any) => p.role));
    for (const p of POD_ROLE_IDS) expect(POD_START_TRIGGERS[p]).toBe('always');
  });
  it('ordnet Aufgaben eindeutigen Modellen und Pods zu', () => {
    expect(podRoleFor('brain')).toBe('brain');
    expect(podRoleFor('orchestrator')).toBe('brain');
    expect(podRoleFor('ears')).toBe('ears');
    expect(podRoleFor('voiceGen', 'tts')).toBe('voice');
    expect(podRoleFor('voiceGen', 'stem.separate')).toBe('studio');
    expect(podRoleFor('music', 'song', 'yue2-3b')).toBe('song');
    expect(podRoleFor('music', 'song', 'acestep-v15-xl-sft')).toBe('music');
    expect(podRoleFor('audioBrain')).toBe('audio-brain');
    expect(podRoleFor('audio-gen')).toBeNull();
  });
  it('bindestrichhaltige Rollen verwenden Unterstriche fuer Env-Keys', () => {
    process.env.RP_POD_ID_AUDIO_BRAIN = 'abc123xyz';
    expect(podBaseUrl('audio-brain')).toBe('https://abc123xyz-8000.proxy.runpod.net');
    process.env.AI_POD_TOKEN = 'kurz';
    expect(podToken()).toBe('');
  });
});
