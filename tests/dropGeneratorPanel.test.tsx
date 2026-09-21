// @vitest-environment jsdom
/**
 * dropMONK · DropGeneratorPanel - der Quantized-Schalter muss wirken.
 *
 * Befund (Restsuche 2026-09-21): im Panel stand ein Kaestchen „Quantized Recall",
 * dessen onChange ein `// TODO: Handle quantized mode toggle` war - und der
 * DROP-Knopf rief `executeDrop(profile, false)` fest verdrahtet. Die Engine kann
 * die Verzoegerung laengst (`dropEngine.triggerDrop(profile, 'quantized', '4bar')`,
 * siehe DropContext.executeDrop), der Schalter war also tote Oberflaeche: der
 * Nutzer klickt und es passiert nichts anderes als ohne.
 *
 * Der Test haelt fest, dass der Zustand wirklich bis in den Aufruf durchkommt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const executeDrop = vi.fn();
const profile = { id: 'preset_test', name: 'Test-Drop', category: 'house' };

vi.mock('../src/context/DropContext', () => ({
  useDropContext: () => ({
    selectedProfile: profile,
    selectProfile: vi.fn(),
    isExecuting: false,
    executionProgress: 0,
    executeDrop,
  }),
}));

import { DropGeneratorPanel } from '../src/components/drop/DropGeneratorPanel';

afterEach(() => {
  cleanup();
  executeDrop.mockClear();
});

describe('DropGeneratorPanel · Quantized Recall', () => {
  it('wirft ohne Schalter sofort ein (executeDrop(profile, false))', () => {
    render(<DropGeneratorPanel />);
    fireEvent.click(screen.getByRole('button', { name: /DROP GENERATE/ }));
    expect(executeDrop).toHaveBeenCalledWith(profile, false);
  });

  it('wirft mit gesetztem Schalter verzoegert ein (executeDrop(profile, true))', () => {
    render(<DropGeneratorPanel />);
    const toggle = screen.getByLabelText('Quantized Recall') as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /DROP GENERATE/ }));
    expect(executeDrop).toHaveBeenCalledWith(profile, true);
  });

  it('zeigt den Zustand sichtbar an (Knopf + Beschriftung)', () => {
    render(<DropGeneratorPanel />);
    expect(screen.getByText(/Wirft sofort ein/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Quantized Recall'));
    expect(screen.getByRole('button', { name: /4-BAR/ })).toBeTruthy();
    expect(screen.getByText(/4-Takt-Grenze/)).toBeTruthy();
  });

  it('schaltet wieder auf sofort zurueck', () => {
    render(<DropGeneratorPanel />);
    const toggle = screen.getByLabelText('Quantized Recall');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /DROP GENERATE/ }));
    expect(executeDrop).toHaveBeenCalledWith(profile, false);
  });
});
