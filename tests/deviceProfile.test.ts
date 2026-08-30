import { describe, expect, it } from 'vitest';
import {
  DeviceProfileStore, buildProfileId, fingerprintMatches,
} from '../src/core/hardware/deviceProfile';

describe('Device-Profile-Identifikation', () => {
  it('baut stabile IDs aus VID/PID', () => {
    expect(buildProfileId({ vid: 0x1234, pid: 0xabcd })).toBe('vid_1234_pid_abcd');
  });

  it('matcht VID/PID exakt und Namens-Fingerprints weich', () => {
    expect(fingerprintMatches({ vid: 0x1234, pid: 0xabcd }, { vid: 0x1234, pid: 0xabcd })).toBe(true);
    expect(fingerprintMatches({ vid: 0x1234, pid: 0xabcd }, { vid: 0x1234, pid: 0x9999 })).toBe(false);
    expect(fingerprintMatches({ manufacturer: 'Akai', product: 'APC40' }, { manufacturer: 'akai', product: 'apc40' })).toBe(true);
    expect(fingerprintMatches({ manufacturer: 'Akai', product: 'APC40' }, { manufacturer: 'Novation', product: 'Launchpad' })).toBe(false);
  });
});

describe('DeviceProfileStore (In-Memory-Fallback ohne IndexedDB)', () => {
  it('speichert, findet und löscht Profile', async () => {
    const store = new DeviceProfileStore();
    await store.save({
      id: 'vid_1234_pid_abcd',
      fingerprint: { vid: 0x1234, pid: 0xabcd, product: 'Test' },
      deviceSettings: { preferredSampleRate: 96000, preferredBufferSize: 256 },
    });

    const found = await store.find({ vid: 0x1234, pid: 0xabcd });
    expect(found?.deviceSettings.preferredSampleRate).toBe(96000);

    await store.remove('vid_1234_pid_abcd');
    expect(await store.find({ vid: 0x1234, pid: 0xabcd })).toBeUndefined();
  });

  it('findet Profile auch über Namens-Match', async () => {
    const store = new DeviceProfileStore();
    await store.save({
      id: 'name_x',
      fingerprint: { manufacturer: 'Akai', product: 'APC40' },
      deviceSettings: { routing: { out12: 'main' } },
    });
    const found = await store.find({ manufacturer: 'Akai', product: 'APC40' });
    expect(found?.deviceSettings.routing).toEqual({ out12: 'main' });
  });
});
