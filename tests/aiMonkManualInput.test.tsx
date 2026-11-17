// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ run: vi.fn(), busy: false, results: [] as string[] }));
vi.mock('../src/components/terminalShared', () => ({ useMoaRun: () => fixture }));
import { AiMonkDock } from '../src/components/AiMonkDock';
import { AiMonkTerminal } from '../src/components/AiMonkTerminal';
beforeEach(() => { fixture.run.mockReset().mockResolvedValue(undefined); fixture.busy = false; fixture.results = []; });
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('operator clarification: aiMONK is one manual request field', () => {
  it('stays idle when mounted, rerendered and left unused, including the legacy alias', async () => {
    vi.useFakeTimers();
    for (const Component of [AiMonkDock, AiMonkTerminal]) {
      const view = render(<Component />);
      expect(screen.getAllByRole('textbox')).toHaveLength(1);
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      expect(screen.queryByRole('combobox')).toBeNull();
      view.rerender(<Component />);
      await act(async () => { await vi.advanceTimersByTimeAsync(180000); });
      expect(fixture.run).not.toHaveBeenCalled(); view.unmount();
    }
  });
  it('runs only an explicitly submitted nonempty request, not typing', async () => {
    render(<AiMonkDock />); const input = screen.getByRole('textbox');
    fireEvent.submit(input.closest('form')!); expect(fixture.run).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '  EQ Status anzeigen  ' } });
    expect(fixture.run).not.toHaveBeenCalled();
    await act(async () => { fireEvent.submit(input.closest('form')!); });
    expect(fixture.run).toHaveBeenCalledExactlyOnceWith('EQ Status anzeigen');
  });
  it('does not submit overlapping copies while the request is pending', async () => {
    let resolve!: () => void;
    fixture.run.mockReturnValue(new Promise<void>(r => { resolve = r; }));
    render(<AiMonkDock />); const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Status' } });
    fireEvent.submit(input.closest('form')!); fireEvent.submit(input.closest('form')!);
    expect(fixture.run).toHaveBeenCalledOnce(); await act(async () => { resolve(); });
    expect((input as HTMLInputElement).value).toBe('Status');
  });
  it('exposes pending state and execution errors accessibly without extra controls', () => {
    fixture.results = ['✗ Testfehler']; fixture.busy = true;
    const view = render(<AiMonkDock />); const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.readOnly).toBe(true); expect(input.getAttribute('aria-busy')).toBe('true');
    fireEvent.submit(input.closest('form')!); expect(fixture.run).not.toHaveBeenCalled();
    fixture.busy = false; view.unmount(); render(<AiMonkDock />);
    expect((screen.getByRole('textbox') as HTMLInputElement).title).toBe('✗ Testfehler'); expect(screen.getByRole('status').textContent).toBe('✗ Testfehler');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
