// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob, pickUserTextFile, PRESET_FILE_TYPE, saveBlobToUserFile, saveTextToUserFile } from '../src/utils/userExport';

// ---------------------------------------------------------------------------
// STORE-P1-001: Nutzerexport nur per Datei (Nutzerwahl bzw. Download), die
// Blob-URL wird sofort freigegeben, kein Browser-Speicher.
// ---------------------------------------------------------------------------

type W = Window & { showSaveFilePicker?: unknown; showOpenFilePicker?: unknown };

afterEach(() => {
  delete (window as W).showSaveFilePicker;
  delete (window as W).showOpenFilePicker;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stubObjectUrls() {
  const create = vi.fn(() => 'blob:test/1');
  const revoke = vi.fn();
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
  return { create, revoke };
}

describe('userExport', () => {
  it('Fallback-Download: Anker mit Dateiname, Blob-URL danach freigegeben', () => {
    vi.useFakeTimers();
    const { create, revoke } = stubObjectUrls();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    downloadBlob(new Blob(['x']), 'take.wav');
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('take.wav');
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:test/1');
  });

  it('File System Access: Nutzer wählt den Speicherort', async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const picker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }));
    (window as W).showSaveFilePicker = picker;
    const r = await saveTextToUserFile('{"a":1}', 'p.json', PRESET_FILE_TYPE);
    expect(r).toBe('saved');
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'p.json', types: [PRESET_FILE_TYPE] });
    expect(write).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('Abbruch im Dialog ist kein Download', async () => {
    const { create } = stubObjectUrls();
    (window as W).showSaveFilePicker = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    expect(await saveBlobToUserFile(new Blob(['x']), 'a.wav')).toBe('cancelled');
    expect(create).not.toHaveBeenCalled();
  });

  it('Datei öffnen über showOpenFilePicker liefert Name und Text', async () => {
    (window as W).showOpenFilePicker = vi.fn(async () => [{ getFile: async () => new File(['{"ok":true}'], 'preset.json') }]);
    expect(await pickUserTextFile(PRESET_FILE_TYPE)).toEqual({ name: 'preset.json', text: '{"ok":true}' });
  });

  it('legt nichts im Browser-Speicher ab', async () => {
    stubObjectUrls();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await saveTextToUserFile('{}', 'p.json');
    expect(setItem).not.toHaveBeenCalled();
  });
});
