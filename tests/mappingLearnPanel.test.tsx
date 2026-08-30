// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MappingLearnPanel } from '../src/components/midi/MappingLearnPanel';
import { mappingStore } from '../src/core/mapping/MappingStore';
import type { ControlEvent } from '../src/core/interfaces';

const ccEvent = (parameter = 21, value = 64): ControlEvent => ({
  sourceDevice: 'port-1',
  sourceProtocol: 'midi',
  channel: 1,
  parameter,
  value,
  resolution: 127,
  messageType: 'cc',
  timestamp: 0,
});

describe('MappingLearnPanel', () => {
  beforeEach(async () => {
    cleanup();
    await mappingStore.replaceAll([]);
  });

  afterEach(() => cleanup());

  it('rendert ohne Mappings und lernt ein ControlEvent im Learn-Modus', async () => {
    const { rerender } = render(<MappingLearnPanel lastEvent={null} />);
    expect(screen.getByText('Keine Mappings gespeichert.')).toBeTruthy();

    // Learn aktivieren, dann Event liefern.
    fireEvent.click(screen.getByRole('button', { name: /LEARN/i }));
    rerender(<MappingLearnPanel lastEvent={ccEvent(21, 64)} />);

    await waitFor(() => {
      expect(mappingStore.engineRef.listRules()).toHaveLength(1);
    });
    const rule = mappingStore.engineRef.listRules()[0];
    expect(rule.parameter).toBe(21);
    expect(rule.sourceProtocol).toBe('midi');
    expect(rule.target).toBe('mixer.channel1.volume');
    expect(rule.kind).toBe('absolute');
  });

  it('lernt nicht ohne Learn-Modus (kein ungewolltes Mapping)', async () => {
    render(<MappingLearnPanel lastEvent={ccEvent(7, 100)} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(mappingStore.engineRef.listRules()).toHaveLength(0);
  });

  it('löscht Mappings über die UI', async () => {
    const { rerender } = render(<MappingLearnPanel lastEvent={null} />);
    fireEvent.click(screen.getByRole('button', { name: /LEARN/i }));
    rerender(<MappingLearnPanel lastEvent={ccEvent(21, 64)} />);
    await waitFor(() => expect(mappingStore.engineRef.listRules()).toHaveLength(1));

    const deleteButton = screen.getByRole('button', { name: /löschen/i });
    fireEvent.click(deleteButton);
    await waitFor(() => expect(mappingStore.engineRef.listRules()).toHaveLength(0));
  });
});
