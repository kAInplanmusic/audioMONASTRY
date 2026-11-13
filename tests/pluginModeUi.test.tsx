// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
vi.mock('../src/components/terminalShared', () => ({
  useMoaRun: () => ({ run: vi.fn(), results: [], meta: '', busy: false, live: '' }),
  useQuickActions: () => [], PluginPresetFileControls: () => null,
}));
vi.mock('../src/components/AgentRunPanel', () => ({ AgentRunPanel: () => <div>Agent details</div> }));
vi.mock('../src/utils/audioEngine', () => ({ audioEngine: { getIsPlaying: () => false } }));
import { RackRow } from '../src/components/RackRow';
import { AiMonkDock } from '../src/components/AiMonkDock';
import { AiMonkTerminal } from '../src/components/AiMonkTerminal';
afterEach(cleanup);
describe('Operator UI correction: independent aiMONK and three plugin choices', () => {
  const props = { id: 'eq', name: 'eqMONK', short: 'EQ', icon: () => null, mode: 'AI' as const,
    ownerLabel: 'me', ownedByMe: true, lockedByOther: false, panelOpen: true, onCycle: vi.fn() };
  it('offers exactly Aus / An / KI and sends the explicit selected mode', () => {
    const change = vi.fn(); render(<RackRow {...props} onModeChange={change}><div>Eq controls</div></RackRow>);
    const group = screen.getByRole('group', { name: 'eqMONK Betriebsmodus' });
    expect(within(group).getAllByRole('button').map(b => b.textContent)).toEqual(['Aus', 'An', 'KI']);
    expect(within(group).getByRole('button', { name: 'eqMONK KI-gesteuert' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(group).getByRole('button', { name: 'eqMONK An' })); expect(change).toHaveBeenLastCalledWith('ON');
    expect(screen.queryByText('STBY')).toBeNull(); expect(screen.getByText('Eq controls')).toBeTruthy();
  });
  it('keeps every foreign plugin mode locked', () => {
    const change = vi.fn(); render(<RackRow {...props} ownedByMe={false} lockedByOther panelOpen={false} onModeChange={change} />);
    const group = screen.getByRole('group', { name: 'eqMONK Betriebsmodus' });
    for (const button of within(group).getAllByRole('button')) { expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button); }
    expect(change).not.toHaveBeenCalled();
  });
  it('never gives aiMONK a power, mode, PRO or collapse control, including its legacy registry entry', () => {
    for (const Component of [AiMonkDock, AiMonkTerminal]) {
      const view = render(<Component />);
      expect(screen.getByText('aiMONK')).toBeTruthy();
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByRole('button', { name: /Modus|zuklappen|aufklappen|^OFF$|^PRO$/ })).toBeNull();
      expect(screen.getByPlaceholderText(/Aufgabe/)).toBeTruthy(); view.unmount();
    }
  });
});
