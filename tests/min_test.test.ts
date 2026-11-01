// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { V2Meters, METER_LAYOUT } from '../src/core/audio/live/V2Meters';

beforeAll(() => {
  console.log('V2Meters:', V2Meters);
  console.log('METER_LAYOUT:', METER_LAYOUT);
  console.log('COUNT:', METER_LAYOUT?.COUNT);
});

describe('debug', () => {
  it('checks V2Meters COUNT is defined', () => {
    expect(METER_LAYOUT.COUNT).toBeDefined();
    expect(METER_LAYOUT.COUNT).toBeGreaterThan(0);
  });
});
