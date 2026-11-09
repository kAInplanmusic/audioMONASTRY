import { describe, expect, it } from 'vitest';
import { createSpatialSceneV2 } from '../src/core/spatial/v2/model';
import { planSpatialPhysicalOutputs, applySpatialPhysicalCalibrationOffline } from '../src/core/spatial/v2/physicalRouting';

describe('Spatial V2 verified device mapping and offline calibration', () => {
  it('refuses to route any unassigned default speaker to hardware', () => {
    const scene = createSpatialSceneV2();
    const plan = planSpatialPhysicalOutputs(scene, {
      deviceId: 'interface', isVerified: true, verifiedDiscreteOutputs: 16,
    });
    expect(plan).toMatchObject({ ok: false, reason: 'Unassigned speaker: sat-01' });
  });

  it('refuses channels exceeding actual device capabilities', () => {
    const scene = createSpatialSceneV2();
    scene.speakers.forEach((speaker, index) => { speaker.outputChannel = index + 1; });
    const plan = planSpatialPhysicalOutputs(scene, {
      deviceId: 'interface', isVerified: true, verifiedDiscreteOutputs: 16,
    });
    expect(plan).toMatchObject({ ok: false, reason: 'Device channel out of range: sat-16' });
  });

  it('maps all 16 satellites to distinct verified output channels', () => {
    const scene = createSpatialSceneV2();
    scene.speakers.forEach((speaker, index) => { speaker.outputChannel = index; });
    const plan = planSpatialPhysicalOutputs(scene, {
      deviceId: 'interface', isVerified: true, verifiedDiscreteOutputs: 16,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.routes).toHaveLength(16);
    expect(plan.routes[15].deviceChannel).toBe(15);
  });

  it('applies known gain, polarity and delay without losing the tail', () => {
    const scene = createSpatialSceneV2();
    scene.speakers.forEach((speaker, index) => { speaker.outputChannel = index; });
    scene.speakers[0].trimDb = -6.020599913;
    scene.speakers[0].delayMs = 1;
    scene.speakers[0].polarity = -1;
    const plan = planSpatialPhysicalOutputs(scene, {
      deviceId: 'interface', isVerified: true, verifiedDiscreteOutputs: 16,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const input = scene.speakers.map((_, i) => new Float32Array(i === 0 ? [1, 0] : [0, 0]));
    const out = applySpatialPhysicalCalibrationOffline(scene, input, 1000, plan);
    expect(out).toHaveLength(16);
    expect(Array.from(out[0])).toHaveLength(3);
    expect(out[0][0]).toBe(0);
    expect(out[0][1]).toBeCloseTo(-0.5, 5);
    expect(out[0][2]).toBe(0);
    expect(out[1].every((sample) => sample === 0)).toBe(true);
  });

  it('refuses duplicate output assignments and unverified devices', () => {
    const scene = createSpatialSceneV2();
    scene.speakers.forEach((sp, i) => { sp.outputChannel = i; });
    scene.speakers[1].outputChannel = 0;
    const capabilities = { deviceId: 'd', isVerified: true, verifiedDiscreteOutputs: 16 };
    expect(planSpatialPhysicalOutputs(scene, capabilities).ok).toBe(false);
    scene.speakers[1].outputChannel = 1;
    expect(planSpatialPhysicalOutputs(scene, { ...capabilities, isVerified: false }).ok).toBe(false);
  });
});
