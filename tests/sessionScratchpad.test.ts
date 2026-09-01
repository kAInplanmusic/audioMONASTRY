// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createScratchpadId,
  loadSessionScratchpad,
  saveSessionScratchpad,
} from '../src/core/session/sessionScratchpad';

describe('P1-4: Session-Scratchpad (IndexedDB-Adapter)', () => {
  it('erzeugt stabile Scratchpad-IDs', () => {
    const id = createScratchpadId('Dark Warehouse Set');
    expect(id.startsWith('scratch-dark-warehouse-set-')).toBe(true);
    expect(createScratchpadId('!!!').startsWith('scratch-session-')).toBe(true);
  });

  it('lädt in Umgebungen ohne IndexedDB defensiv null', async () => {
    expect(await loadSessionScratchpad()).toBeNull();
  });

  it('speichern ist fire-and-forget (kein Wurf ohne IndexedDB)', async () => {
    await expect(
      saveSessionScratchpad({
        id: createScratchpadId('test'),
        name: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        snapshot: { bpm: 128, isPlaying: false, patterns: {}, moduleStates: {}, mixer: {}, routing: {} },
      }),
    ).resolves.toBeUndefined();
  });
});
