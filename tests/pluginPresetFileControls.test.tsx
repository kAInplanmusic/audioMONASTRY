// @vitest-environment jsdom
/**
 * STORE-P1-001 · Preset-Datei-Knöpfe im gemeinsamen Terminal-Rahmen.
 * Export/Import pro Plugin, Import nur für den Halter (zentraler Lock), Import
 * schreibt über den bestehenden Plugin-Settings-Pfad (src/utils/pluginSettings.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { sent, picked, saveText, pick } = vi.hoisted(() => {
  const sent: Array<{ pluginId: string; settings: unknown }> = [];
  const picked: { text: string | null } = { text: null };
  return {
    sent,
    picked,
    saveText: vi.fn(async () => 'downloaded' as const),
    pick: vi.fn(async () => (picked.text === null ? null : { name: 'preset.json', text: picked.text })),
  };
});

vi.mock('../src/utils/WebRTCManager', () => ({
  webRTCManager: {
    userId: 'u1',
    isMainOutOwner: false,
    sendPluginSettings: (pluginId: string, settings: unknown) => sent.push({ pluginId, settings }),
    onSessionState: () => () => undefined,
    onPluginSettings: () => () => undefined,
  },
}));
vi.mock('../src/core/ai/MoaAgent', () => ({ moaAgent: {} }));
vi.mock('../src/core/ai/MoaHistory', () => ({ moaHistory: { add: () => undefined } }));
vi.mock('../src/core/pluginAudioRouter', () => ({ routeModuleState: () => undefined }));
vi.mock('../src/utils/audioEngine', () => ({ audioEngine: { getIsPlaying: () => false } }));
vi.mock('../src/components/MoaAssistant', () => ({ MoaAssistant: () => null }));
vi.mock('../src/utils/userExport', async (orig) => ({
  ...(await orig<typeof import('../src/utils/userExport')>()),
  saveTextToUserFile: saveText,
  pickUserTextFile: pick,
}));

import { PluginPresetFileControls } from '../src/components/terminalShared';
import { readPluginSettings, setPluginSettingsHolderCheck, writePluginSettings } from '../src/utils/pluginSettings';
import { buildPluginPresetFile, serializePluginPresetFile } from '../src/core/session/pluginPresetFile';

let holder = true;

beforeEach(() => {
  holder = true;
  sent.length = 0;
  picked.text = null;
  saveText.mockClear();
  pick.mockClear();
  setPluginSettingsHolderCheck(() => holder);
});
afterEach(cleanup);

const presetText = (pluginId: string, settings: Record<string, unknown>) =>
  serializePluginPresetFile(buildPluginPresetFile(pluginId, settings, { now: new Date('2026-10-13T00:00:00Z') }));

describe('PluginPresetFileControls', () => {
  it('ohne Lock keine Knöpfe', () => {
    const { container } = render(<PluginPresetFileControls pluginId="eq" ownedByMe={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('Export schreibt den Session-Stand als Preset-Datei', async () => {
    writePluginSettings('eq', { q: 3 });
    render(<PluginPresetFileControls pluginId="eq" name="eqMONK" ownedByMe />);
    fireEvent.click(screen.getByLabelText('eqMONK Preset als Datei exportieren'));
    await waitFor(() => expect(saveText).toHaveBeenCalledTimes(1));
    const [text, fileName] = saveText.mock.calls[0] as unknown as [string, string];
    expect(fileName).toMatch(/^audiomonastry-eq-preset-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse(text)).toMatchObject({ format: 'audiomonastry.plugin-preset', schemaVersion: 1, pluginId: 'eq', settings: { q: 3 } });
    expect((await screen.findByRole('status')).textContent).toMatch(/Preset exportiert/);
  });

  it('Import (Halter): Stand über den Plugin-Settings-Pfad, sofort an die Session, Terminal neu einlesen', async () => {
    const onImported = vi.fn();
    picked.text = presetText('dsp', { cutoff: 900 });
    render(<PluginPresetFileControls pluginId="dsp" name="dspMONK" ownedByMe onImported={onImported} />);
    fireEvent.click(screen.getByLabelText('dspMONK Preset aus Datei importieren'));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(readPluginSettings('dsp')).toEqual({ cutoff: 900 });
    expect(sent).toContainEqual({ pluginId: 'dsp', settings: { cutoff: 900 } });
  });

  it('Import mit falschem Schema wird abgelehnt, Stand bleibt', async () => {
    writePluginSettings('voice', { style: 'a' });
    const onImported = vi.fn();
    picked.text = JSON.stringify({ format: 'something-else', settings: { style: 'b' } });
    render(<PluginPresetFileControls pluginId="voice" name="voiceMONK" ownedByMe onImported={onImported} />);
    fireEvent.click(screen.getByLabelText('voiceMONK Preset aus Datei importieren'));
    expect((await screen.findByRole('status')).textContent).toMatch(/Import abgelehnt: .*Schema/);
    expect(onImported).not.toHaveBeenCalled();
    expect(readPluginSettings('voice')).toEqual({ style: 'a' });
  });

  it('Import eines Presets für ein anderes Plugin wird abgelehnt', async () => {
    picked.text = presetText('eq', { q: 1 });
    render(<PluginPresetFileControls pluginId="master" name="masterMONK" ownedByMe />);
    fireEvent.click(screen.getByLabelText('masterMONK Preset aus Datei importieren'));
    expect((await screen.findByRole('status')).textContent).toMatch(/Import abgelehnt: Preset gehört zu/);
    expect(readPluginSettings('master')).toBeNull();
  });

  it('fremder Lock (zentral): keine Dateiauswahl, nichts geschrieben', async () => {
    holder = false;
    picked.text = presetText('stem', { mode: 'x' });
    render(<PluginPresetFileControls pluginId="stem" name="stemMONK" ownedByMe />);
    fireEvent.click(screen.getByLabelText('stemMONK Preset aus Datei importieren'));
    expect((await screen.findByRole('status')).textContent).toMatch('Import nur für den Halter des Plugins.');
    expect(pick).not.toHaveBeenCalled();
    expect(readPluginSettings('stem')).toBeNull();
    expect(sent.filter((s) => s.pluginId === 'stem')).toEqual([]);
  });
});

describe('RackRow – gemeinsamer Plugin-Streifen bekommt die Preset-Knöpfe', () => {
  const baseProps = {
    id: 'eq', name: 'eqMONK', short: 'EQ', icon: () => null, mode: 'ON' as const,
    ownerLabel: 'U1', panelOpen: true, onCycle: () => undefined,
  };

  it('Halter sieht Export/Import, andere nicht', async () => {
    const { RackRow } = await import('../src/components/RackRow');
    const { rerender } = render(<RackRow {...baseProps} ownedByMe lockedByOther={false}><div>panel</div></RackRow>);
    expect(screen.getByLabelText('eqMONK Preset als Datei exportieren')).toBeTruthy();
    rerender(<RackRow {...baseProps} ownedByMe={false} lockedByOther><div>panel</div></RackRow>);
    expect(screen.queryByLabelText('eqMONK Preset als Datei exportieren')).toBeNull();
  });

  it('nach dem Import wird die Bedienfläche neu eingehängt (liest den importierten Stand)', async () => {
    const { RackRow } = await import('../src/components/RackRow');
    const mounts = vi.fn();
    const Panel = () => {
      mounts(readPluginSettings('eq'));
      return <div>panel</div>;
    };
    picked.text = presetText('eq', { q: 42 });
    render(<RackRow {...baseProps} ownedByMe lockedByOther={false}><Panel /></RackRow>);
    const before = mounts.mock.calls.length;
    fireEvent.click(screen.getByLabelText('eqMONK Preset aus Datei importieren'));
    await waitFor(() => expect(mounts.mock.calls.length).toBeGreaterThan(before));
    expect(mounts.mock.calls.at(-1)?.[0]).toEqual({ q: 42 });
  });
});
