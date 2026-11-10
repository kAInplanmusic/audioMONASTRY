import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTIVE_RUNPOD_POD_IDS, AI_RESIDENT_FLEET, GPU_ROLE_IDS } from '../src/config/aiInfrastructure';
import { GPU_ROLE_LIST, GPU_ROLES } from '../src/core/ai/orchestrator/endpointRegistry';

const fleet = JSON.parse(readFileSync('deploy/runpod/pod-fleet.json', 'utf8'));
const manifest = JSON.parse(readFileSync('services/audiomonastry-ai-runtime/model_manifest.json', 'utf8'));
const pods = [...fleet.pods, fleet.visPod];
const modelMap = new Map<string, any>(manifest.models.map((m: any) => [m.id, m]));
const activeNames = ['brain', 'ears', 'voice', 'music', 'studio', 'audio-brain', 'song', 'vis'];
const canonicalApiNames: Record<string,string> = {
  brain:'brain', ears:'ears', voice:'voiceGen', music:'music',
  studio:'studio', 'audio-brain':'executor', song:'song', vis:'vis',
};

describe('SSOT: aktive RunPod-Pods ↔ Manifest ↔ TypeScript', () => {
  it('enthält genau die acht autorisierten Pods ohne retired Rollen', () => {
    expect([...ACTIVE_RUNPOD_POD_IDS]).toEqual(activeNames);
    expect(pods.map((p: any) => p.role)).toEqual(activeNames);
    for (const p of pods) {
      expect(fleet.retiredRoles).not.toContain(p.role);
      expect(p.aiRole).toBe(canonicalApiNames[p.role]);
    }
  });

  it('spiegelt jede Rolle, GPU und jedes aktive Modell vollständig', () => {
    expect(AI_RESIDENT_FLEET.map(i => i.id)).toEqual(activeNames);
    for (const pod of pods) {
      const role = manifest.roles[pod.aiRole];
      expect(role, pod.role).toBeDefined();
      expect(role.models, pod.role).toEqual(pod.models);
      expect(role.preloadModels, pod.role).toEqual(pod.models.filter((id:string) => modelMap.get(id).estimatedVRAM > 0));
      expect(role.gpuId, pod.role).toBe(pod.gpuPoolId);
      const ts = AI_RESIDENT_FLEET.find(i => i.id === pod.role)!;
      expect(ts.models.map(m => m.id), pod.role).toEqual(pod.models);
      for (const model of ts.models) {
        expect(model.vramGb, model.id).toBe(modelMap.get(model.id).estimatedVRAM);
        expect(modelMap.get(model.id).repository, model.id).toBeTruthy();
        expect(modelMap.get(model.id).task, model.id).toBeTruthy();
      }
    }
  });

  it('unterscheidet alte Serverless-API-Namen explizit von tatsächlichen Pods', () => {
    expect([...GPU_ROLE_IDS]).toEqual([
      'brain','ears','voiceGen','music','imageHq','videoReal','videoAbstract','orchestrator',
    ]);
    expect(GPU_ROLE_LIST.map(r => r.role)).toEqual([...GPU_ROLE_IDS]);
    expect(GPU_ROLES).not.toHaveProperty('audio-gen');
    for (const [legacy,active] of [['brain','brain'],['ears','ears'],['voiceGen','voice'],['music','music']]) {
      const pod = pods.find((p:any) => p.role === active)!;
      const role = GPU_ROLES[legacy as keyof typeof GPU_ROLES];
      expect(role.gpuId).toBe(pod.gpuPoolId);
      expect(role.idleTimeoutSeconds).toBe(manifest.roles[pod.aiRole].idleTimeoutSeconds);
      expect(role.preload).toEqual(manifest.roles[pod.aiRole].preloadModels);
    }
    for (const retired of ['imageHq','videoReal','videoAbstract','orchestrator']) {
      expect(activeNames).not.toContain(retired);
    }
  });

  it('respektiert geschätzte rollenindividuelle VRAM-Grenzen', () => {
    for (const pod of pods) {
      const candidates = fleet.gpuPools[pod.gpuPool];
      const modelGb = pod.models.reduce((sum:number,id:string) => sum + modelMap.get(id).estimatedVRAM, 0);
      const reserve = pod.vramReserveGb + pod.vramSafetyMarginGb;
      for (const id of pod.gpuPriority) {
        const gpu = candidates.find((g:any) => g.id === id);
        expect(gpu, pod.role+': '+id).toBeDefined();
        expect(modelGb + reserve, pod.role+': '+id).toBeLessThanOrEqual(gpu.vramGb);
      }
    }
  });

  it('behandelt unvollständige Pins explizit als Deployment-Blocker', () => {
    const bve = modelMap.get('mel-roformer-bve');
    expect(bve.revision).toBe('c73a679a87e568133b7e7387f58c9d3186a51ad4');
    // Known unsafe state is asserted, not misrepresented as a production pin.
    expect(bve.revision).toMatch(/^[a-f0-9]{40}$/);
    for (const pod of pods) for (const id of pod.models) {
      const m = modelMap.get(id);
      expect(m).toBeDefined();
      expect(m.revision).toMatch(/^[a-f0-9]{40}$|^cpu-only$/);
    }
  });
});
