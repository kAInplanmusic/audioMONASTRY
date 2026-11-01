// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { V2Meters } from '../src/core/audio/live/V2Meters';

beforeAll(() => {
  console.log('V2Meters:', V2Meters);
  console.log('METER_LAYOUT:', V2Meters.METER_LAYOUT);
  console.log('COUNT:', V2Meters.METER_LAYOUT?.COUNT);
});

describe('debug', () => {
  it('checks V2Meters', () => {
    expect(V2Meters.METER_LAYOUT.COUNT).toBeDefined();
  });
});
