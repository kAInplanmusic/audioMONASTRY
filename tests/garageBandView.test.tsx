// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: {
    previewSynthesizedSample: vi.fn(),
  },
}));

import { GarageBandInstrumentView } from '../src/components/instrument/GarageBandInstrumentView';
import { audioEngine } from '../src/utils/audioEngine';

describe('GarageBandInstrumentView (Echtbild-UI, NEW-MONK-5)', () => {
  it('rendert Instrumenten-Kacheln mit Bildern (GarageBand-Picker)', () => {
    render(<GarageBandInstrumentView />);
    for (const name of ['Schlagzeug', 'Gitarre', 'Bass', 'Klavier']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    // Schlagzeug ist Standard → Drum-Pads sichtbar.
    expect(screen.getAllByText('Kick').length).toBeGreaterThan(0);
  });

  it('spielt eine Note beim Antippen einer Drum-Zone', () => {
    render(<GarageBandInstrumentView />);
    fireEvent.pointerDown(screen.getAllByText('Kick')[0]);
    expect((audioEngine.previewSynthesizedSample as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('wechselt per Kachel auf Klavier und zeigt Tasten', () => {
    render(<GarageBandInstrumentView />);
    fireEvent.click(screen.getAllByText('Klavier')[0]);
    // Klaviertasten-Labels C4..C11 werden angezeigt.
    expect(screen.getAllByText('C4').length).toBeGreaterThan(0);
  });
});
