// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemorySessionMediaStore } from '../src/core/session/SessionMediaStore';
import { DeterministicTtsProvider, VoiceMonkService } from '../src/core/voice/VoiceMonkService';
import { VoiceMonkPanel } from '../src/components/VoiceMonkPanel';

afterEach(cleanup);

function createService() {
  return new VoiceMonkService(new MemorySessionMediaStore(), [new DeterministicTtsProvider()]);
}

describe('VoiceMonkPanel (jsdom)', () => {
  it('spricht Text und legt ihn in der Session-DB ab', async () => {
    const service = createService();
    render(<VoiceMonkPanel userId="User1" service={service} />);

    fireEvent.click(screen.getByRole('button', { name: /Sprechen/i }));
    await waitFor(() => {
      expect(screen.getByText(/1 Medium\/Medien/)).toBeTruthy();
    });
  });

  it('singt Text und legt ihn als singing ab', async () => {
    const service = createService();
    render(<VoiceMonkPanel userId="User2" service={service} />);

    fireEvent.click(screen.getByRole('button', { name: /Singen/i }));
    await waitFor(() => {
      expect(screen.getByText(/1 Medium\/Medien/)).toBeTruthy();
    });
    expect(service.listForUser('User2')[0].kind).toBe('singing');
  });

  it('generiert einen Song und legt ihn als song ab', async () => {
    const service = createService();
    render(<VoiceMonkPanel userId="User3" service={service} />);

    fireEvent.click(screen.getByRole('button', { name: /^Song$/i }));
    await waitFor(() => {
      expect(screen.getByText(/1 Medium\/Medien/)).toBeTruthy();
    });
    expect(service.listForUser('User3')[0].kind).toBe('song');
  });
});
