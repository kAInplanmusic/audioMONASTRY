/**
 * audioMONASTRY · Device Profiles (VID/PID/Serial)
 * =================================================
 * Geräte-Wiedererkennung über Hardware-Fingerprint statt Namens-Substring.
 * Persistiert gerätespezifische Einstellungen (Sample-Rate, Buffer, Routing,
 * Mappings) transportagnostisch. Generic-Device-Support bleibt unabhängig.
 */
import { largeGetJson, largeSetJson } from '../../utils/indexedDB';

export interface DeviceFingerprint {
  /** USB Vendor ID (WebHID/nativ verfügbar; Web MIDI nicht). */
  vid?: number;
  /** USB Product ID. */
  pid?: number;
  manufacturer?: string;
  product?: string;
  /** Seriennummer, falls vom OS exponiert. */
  serial?: string;
}

export interface DeviceProfileSettings {
  preferredSampleRate?: number;
  preferredBufferSize?: number;
  /** Geräte-spezifische Routing-Konfiguration (JSON-serialisierbar). */
  routing?: Record<string, unknown>;
  /** Persistierte Mapping-Regeln (MappingEngine-Format). */
  mappings?: unknown[];
  /** Freie Hardware-Konfiguration (Kanalplan, Monitoring …). */
  extra?: Record<string, unknown>;
}

export interface DeviceProfile {
  /** Profil-ID (z. B. `vid_1234_pid_5678` oder Namens-Hash). */
  id: string;
  fingerprint: DeviceFingerprint;
  deviceSettings: DeviceProfileSettings;
  lastSeenAt?: number;
}

const PROFILES_KEY = 'audiomonastry_device_profiles';

/** Baut eine stabile Profil-ID aus dem Fingerprint. */
export function buildProfileId(fp: DeviceFingerprint): string {
  if (fp.vid !== undefined && fp.pid !== undefined) {
    return `vid_${fp.vid.toString(16)}_pid_${fp.pid.toString(16)}`.toLowerCase();
  }
  const name = `${fp.manufacturer ?? ''}:${fp.product ?? ''}:${fp.serial ?? ''}`.trim().toLowerCase();
  if (!name || name === '::') return 'generic';
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return `name_${(hash >>> 0).toString(36)}`;
}

/** Normalisiert Hersteller/Produktnamen für robustes Matching. */
export function normId(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Prüft, ob ein Fingerprint zu einem anderen passt (VID/PID exakt, Namen weich). */
export function fingerprintMatches(a: DeviceFingerprint, b: DeviceFingerprint): boolean {
  if (a.vid !== undefined && b.vid !== undefined) {
    if (a.vid !== b.vid) return false;
    if (a.pid !== undefined && b.pid !== undefined && a.pid !== b.pid) return false;
    return true;
  }
  const aName = `${normId(a.manufacturer)} ${normId(a.product)}`.trim();
  const bName = `${normId(b.manufacturer)} ${normId(b.product)}`.trim();
  if (aName && bName && aName !== bName) return false;
  if (a.serial && b.serial && a.serial !== b.serial) return false;
  return aName === bName || (!!aName && !!bName);
}

/**
 * Persistenter Device-Profile-Store. Nutzt den IndexedDB-Adapter; in
 * Umgebungen ohne IndexedDB (Node-Tests) arbeitet er mit In-Memory-Fallback.
 */
export class DeviceProfileStore {
  private memory = new Map<string, DeviceProfile>();

  async load(): Promise<DeviceProfile[]> {
    try {
      const stored = await largeGetJson<DeviceProfile[]>(PROFILES_KEY);
      if (Array.isArray(stored)) {
        this.memory = new Map(stored.map((p) => [p.id, p]));
        return stored;
      }
    } catch { /* Fallback unten */ }
    return [...this.memory.values()];
  }

  async save(profile: DeviceProfile): Promise<void> {
    profile.lastSeenAt = Date.now();
    this.memory.set(profile.id, { ...profile });
    await this.persist();
  }

  async remove(profileId: string): Promise<void> {
    this.memory.delete(profileId);
    await this.persist();
  }

  async find(fp: DeviceFingerprint): Promise<DeviceProfile | undefined> {
    const id = buildProfileId(fp);
    const direct = this.memory.get(id);
    if (direct) return direct;
    return [...this.memory.values()].find((p) => fingerprintMatches(p.fingerprint, fp));
  }

  async all(): Promise<DeviceProfile[]> {
    return [...this.memory.values()];
  }

  private async persist(): Promise<void> {
    const list = [...this.memory.values()];
    await largeSetJson(PROFILES_KEY, list).catch(() => { /* Quota – In-Memory bleibt aktiv */ });
  }
}

export const deviceProfileStore = new DeviceProfileStore();
