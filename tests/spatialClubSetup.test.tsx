// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SpatialClubSetup } from '../src/components/spatial/SpatialClubSetup';

vi.mock('../src/utils/storage', () => ({
  storageGetJson: () => null,
  storageSetJson: vi.fn(),
}));

afterEach(cleanup);

it('plans a rectangular 32-satellite room with two separate subs', () => {
  render(<SpatialClubSetup />);
  fireEvent.click(screen.getByRole('button', { name: /Raum & LS Setup/i }));
  fireEvent.change(screen.getByRole('spinbutton', { name: /Breite/ }), { target: { value: '4' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: /Tiefe/ }), { target: { value: '12' } });

  const counts = screen.getByRole('combobox', { name: 'Satelliten' });
  expect(within(counts).getAllByRole('option').map((item) => item.getAttribute('value')))
    .toEqual(['12', '16', '24', '32']);
  fireEvent.change(counts, { target: { value: '32' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Separate Subwoofer' }), { target: { value: '2' } });

  const room = screen.getByRole('img', { name: /4 mal 12 Meter, 32 Satelliten/ });
  const outline = room.querySelector('rect');
  expect(Number(outline?.getAttribute('width')) / Number(outline?.getAttribute('height'))).toBeCloseTo(1 / 3);
  expect(screen.getByText(/34 diskrete Ausgänge/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Setup übernehmen/i })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /Visualisieren/i }));
  expect(screen.getByRole('status').textContent).toContain('WARTET AUF PCM');
});
