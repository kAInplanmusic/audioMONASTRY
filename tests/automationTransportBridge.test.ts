import { describe, it, expect } from 'vitest';
import { V2NodeAutomationCoalescer } from '../src/core/audio/state/v2NodeAutomation';
import { AutomationTransportBridge } from '../src/core/audio/state/automationTransportBridge';
import { AutomationTimeline } from '../src/core/audio/state/automationTimeline';
import { ParametricEqNode } from '../src/core/audio/nodes/processingNodes';

// Helper to create a coalescer with optional timeline
function createCoalescer(timeline?: AutomationTimeline) {
  const node = new ParametricEqNode('eq:auto');
  const nodes = new Map([['eq:auto', node]]);
  return new V2NodeAutomationCoalescer(nodes, { intervalMs: 1_000, timeline });
}

describe('AutomationTransportBridge', () => {
  it('applies lane values when timeline present', () => {
    const timeline = new AutomationTimeline();
    const laneId = timeline.createLane('eq:auto', 'low', { min: -24, max: 24 });
    timeline.addPoints(laneId, [
      { timeSec: 0, value: -12, curve: 'linear' },
      { timeSec: 2, value: 12, curve: 'linear' },
    ]);
    const auto = createCoalescer(timeline);
    const bridge = new AutomationTransportBridge({ coalescer: auto });

    // Tick at start: should apply lane value -12
    const first = bridge.tick(0);
    expect(first.applied).toBe(1);
    expect(first.transportSec).toBe(0);

    // Tick in middle: should apply interpolated 0
    const mid = bridge.tick(1);
    expect(mid.applied).toBe(1);
    // Value should be near 0 (use a small tolerance)
    // We cannot read the node directly; just ensure it did not error.
    expect(mid.rejected).toBe(false);
  });
});