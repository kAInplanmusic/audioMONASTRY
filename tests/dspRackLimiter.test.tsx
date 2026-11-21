// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { readPluginSettings, writePluginSettings, setMasteringParams } = vi.hoisted(() => ({
  readPluginSettings: vi.fn(),
  writePluginSettings: vi.fn(),
  setMasteringParams: vi.fn(),
}));

vi.mock('../src/utils/pluginSettings', () => ({ readPluginSettings, writePluginSettings }));
vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: { setDspParam: vi.fn(), setMasteringParams },
}));

import { DspRack } from '../src/components/am/DspRack';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('dspMONK limiter ceiling', () => {
  it.each([
    { stored: null, expectedDb: -1 },
    { stored: { limOn: true, limCeiling: 0.98 }, expectedDb: -1 },
    { stored: { limOn: true, limCeiling: -6 }, expectedDb: -6 },
    { stored: { limOn: true, limCeiling: 0 }, expectedDb: 0 },
  ])('applies $expectedDb dB to the engine for $stored', ({ stored, expectedDb }) => {
    readPluginSettings.mockReturnValue(stored);
    render(<DspRack />);
    if (stored === null) {
      fireEvent.click(screen.getByRole('button', { name: 'Modul Limiter' }));
      fireEvent.click(screen.getByRole('button', { name: 'Limiter ein/aus' }));
    }

    expect(setMasteringParams).toHaveBeenLastCalledWith(expect.objectContaining({
      ceiling: 10 ** (expectedDb / 20),
      ratio: 20,
    }));
    expect(writePluginSettings).toHaveBeenLastCalledWith('dsp', expect.objectContaining({
      limCeiling: expectedDb,
      limOn: true,
    }));
  });
});
