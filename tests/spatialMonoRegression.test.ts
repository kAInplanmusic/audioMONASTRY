import { describe, expect, it } from 'vitest';
import { SpatialPluginAdapter } from '../src/plugins/adapters/SpatialPluginAdapter';

describe('SP-P0-01 mono spatial pan regression', () => {
  for (const pan of [-1, -0.5, 0, 0.5, 1]) {
    it('preserves mono audio at pan ' + pan, () => {
      const adapter = new SpatialPluginAdapter();
      adapter.restore({ pluginId: 'spatial', state: 'PRO', parameters: { pan, width: 1 } });
      const samples = Float32Array.from([0.7, -0.25, 0.11, 0, 0.9]);
      const expected = Array.from(samples);
      const result = adapter.process({
        channels: [samples], frameCount: 5, sampleRate: 48000, timestamp: 0,
      });
      expect(result.channels).toHaveLength(1);
      expect(Array.from(result.channels[0])).toEqual(expected);
    });
  }
});
