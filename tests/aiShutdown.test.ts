import { describe, expect, it, afterEach } from 'vitest';
import {
  HfEndpointProvider,
  setAiShutdownMode,
  isAiShutdownMode,
} from '../src/core/ai/orchestrator/providerRouter';

describe('NEW-D15-1: AI Server Shutdown (DevSettings)', () => {
  const originalUrl = process.env.HF_ENDPOINT_URL;

  afterEach(() => {
    setAiShutdownMode(false);
    if (originalUrl === undefined) delete process.env.HF_ENDPOINT_URL;
    else process.env.HF_ENDPOINT_URL = originalUrl;
  });

  it('HfEndpointProvider ist bei aktivem Shutdown nicht mehr verfügbar', () => {
    process.env.HF_ENDPOINT_URL = 'http://hf-endpoint.test';
    const provider = new HfEndpointProvider();

    expect(isAiShutdownMode()).toBe(false);
    expect(provider.available).toBe(true);

    setAiShutdownMode(true);
    expect(isAiShutdownMode()).toBe(true);
    expect(provider.available).toBe(false);
  });

  it('nach Deaktivierung des Shutdown ist der Endpoint wieder verfügbar', () => {
    process.env.HF_ENDPOINT_URL = 'http://hf-endpoint.test';
    const provider = new HfEndpointProvider();

    setAiShutdownMode(true);
    expect(provider.available).toBe(false);

    setAiShutdownMode(false);
    expect(provider.available).toBe(true);
  });
});
