/**
 * dropMONK – Drop Preset Store
 * ===========================
 * Persistiere Presets in OPFS/IndexedDB
 */

import type { DropProfile, DropPreset, DropCategory } from './types/DropProfile';

const STORAGE_KEY = 'dropmonk_presets';
const OPFS_DIR = 'dropmonk';

/**
 * Drop Preset Store
 * Speichert & lädt Drop-Profile persistent
 */
export class DropPresetStore {
  private presets: Map<string, DropPreset> = new Map();
  private initialized = false;

  /**
   * Initialize Store
   * Laden aus IndexedDB oder OPFS
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Versuche aus IndexedDB zu laden
      await this.loadFromIndexedDb();
    } catch (err) {
      console.warn('IndexedDB loading failed, trying localStorage:', err);
      try {
        // Fallback zu localStorage
        await this.loadFromLocalStorage();
      } catch (err2) {
        console.warn('All persistence methods failed:', err2);
        // Leer starten, keine gespeicherten Presets verfügbar
      }
    }

    this.initialized = true;
  }

  /**
   * Save Preset
   */
  async savePreset(profile: DropProfile, name: string, tags?: string[]): Promise<DropPreset> {
    await this.initialize();

    const preset: DropPreset = {
      id: `preset_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      name,
      profile,
      tags: tags || [],
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      favorite: false,
      usageCount: 0,
    };

    this.presets.set(preset.id, preset);

    // Persistiere
    await this.persistToStorage();

    return preset;
  }

  /**
   * Load Preset by ID
   */
  async loadPreset(id: string): Promise<DropPreset | null> {
    await this.initialize();
    return this.presets.get(id) || null;
  }

  /**
   * List all Presets with optional filter
   */
  async listPresets(filter?: { category?: DropCategory; tags?: string[] }): Promise<
    DropPreset[]
  > {
    await this.initialize();

    let results = Array.from(this.presets.values());

    if (filter?.category) {
      results = results.filter((p) => p.profile.category === filter.category);
    }

    if (filter?.tags && filter.tags.length > 0) {
      results = results.filter((p) =>
        filter.tags!.some((tag) => p.tags.includes(tag))
      );
    }

    return results;
  }

  /**
   * Get Favorites
   */
  async getFavorites(): Promise<DropPreset[]> {
    await this.initialize();
    return Array.from(this.presets.values()).filter((p) => p.favorite);
  }

  /**
   * Toggle Favorite
   */
  async toggleFavorite(id: string): Promise<boolean> {
    await this.initialize();

    const preset = this.presets.get(id);
    if (!preset) throw new Error(`Preset ${id} not found`);

    preset.favorite = !preset.favorite;
    preset.modifiedAt = Date.now();
    await this.persistToStorage();

    return preset.favorite;
  }

  /**
   * Update Preset
   */
  async updatePreset(id: string, updates: Partial<DropPreset>): Promise<DropPreset> {
    await this.initialize();

    const preset = this.presets.get(id);
    if (!preset) throw new Error(`Preset ${id} not found`);

    Object.assign(preset, updates, { modifiedAt: Date.now() });
    await this.persistToStorage();

    return preset;
  }

  /**
   * Delete Preset
   */
  async deletePreset(id: string): Promise<void> {
    await this.initialize();

    if (!this.presets.has(id)) throw new Error(`Preset ${id} not found`);

    this.presets.delete(id);
    await this.persistToStorage();
  }

  /**
   * Increment Usage Counter
   */
  async recordUsage(id: string): Promise<void> {
    await this.initialize();

    const preset = this.presets.get(id);
    if (!preset) return;

    preset.usageCount = (preset.usageCount || 0) + 1;
    preset.modifiedAt = Date.now();
    await this.persistToStorage();
  }

  /**
   * Get Most Used Presets
   */
  async getMostUsed(limit: number = 5): Promise<DropPreset[]> {
    await this.initialize();

    return Array.from(this.presets.values())
      .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
      .slice(0, limit);
  }

  /**
   * Export all Presets as JSON
   */
  async exportAll(): Promise<string> {
    await this.initialize();
    const data = {
      version: '1.0',
      exportedAt: Date.now(),
      presets: Array.from(this.presets.values()),
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * Import Presets from JSON
   */
  async importFromJson(jsonString: string, mergeMode: 'replace' | 'merge' = 'merge'): Promise<number> {
    await this.initialize();

    try {
      const data = JSON.parse(jsonString);
      const importedPresets = data.presets || [];

      if (mergeMode === 'replace') {
        this.presets.clear();
      }

      let count = 0;
      for (const preset of importedPresets) {
        // Regeneriere ID (keine Duplikate)
        const newId = `preset_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const importedPreset: DropPreset = {
          ...preset,
          id: newId,
          modifiedAt: Date.now(),
        };

        this.presets.set(newId, importedPreset);
        count++;
      }

      await this.persistToStorage();
      return count;
    } catch (err) {
      throw new Error(`Failed to import presets: ${err}`);
    }
  }

  /**
   * Persist to Storage
   */
  private async persistToStorage(): Promise<void> {
    try {
      const data = JSON.stringify(Array.from(this.presets.values()));

      // Versuche IndexedDB
      if ('indexedDB' in globalThis) {
        await this.saveToIndexedDb(data);
      } else {
        // Fallback zu localStorage
        await this.saveToLocalStorage(data);
      }
    } catch (err) {
      console.error('Failed to persist presets:', err);
      // Non-critical: Presets werden zur Runtime behalten,
      // aber beim Reload verloren
    }
  }

  /**
   * Save to IndexedDB
   */
  private async saveToIndexedDb(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('audiomonastry', 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;

        // Stelle sicher, dass object store existiert
        if (!db.objectStoreNames.contains(STORAGE_KEY)) {
          const version = db.version + 1;
          db.close();

          const upgradeRequest = indexedDB.open('audiomonastry', version);
          upgradeRequest.onupgradeneeded = () => {
            upgradeRequest.result.createObjectStore(STORAGE_KEY);
          };
          upgradeRequest.onsuccess = () => {
            this.saveToIndexedDb(data).then(resolve).catch(reject);
          };
          upgradeRequest.onerror = () => reject(upgradeRequest.error);
          return;
        }

        const tx = db.transaction(STORAGE_KEY, 'readwrite');
        const store = tx.objectStore(STORAGE_KEY);
        store.put(data, 'presets');

        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  /**
   * Load from IndexedDB
   */
  private async loadFromIndexedDb(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('audiomonastry', 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(STORAGE_KEY)) {
          resolve(); // Keine Daten vorhanden
          return;
        }

        const tx = db.transaction(STORAGE_KEY, 'readonly');
        const store = tx.objectStore(STORAGE_KEY);
        const getRequest = store.get('presets');

        getRequest.onsuccess = () => {
          const data = getRequest.result;
          if (data) {
            try {
              const presets = JSON.parse(data) as DropPreset[];
              this.presets = new Map(presets.map((p) => [p.id, p]));
            } catch (err) {
              console.error('Failed to parse stored presets:', err);
            }
          }
          resolve();
        };

        getRequest.onerror = () => reject(getRequest.error);
      };
    });
  }

  /**
   * Save to LocalStorage (Fallback)
   */
  private async saveToLocalStorage(data: string): Promise<void> {
    try {
      localStorage.setItem(STORAGE_KEY, data);
    } catch (err) {
      throw new Error(`localStorage save failed: ${err}`);
    }
  }

  /**
   * Load from LocalStorage (Fallback)
   */
  private async loadFromLocalStorage(): Promise<void> {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        const presets = JSON.parse(data) as DropPreset[];
        this.presets = new Map(presets.map((p) => [p.id, p]));
      }
    } catch (err) {
      console.error('localStorage load failed:', err);
      throw err;
    }
  }

  /**
   * Clear all Presets
   */
  async clearAll(): Promise<void> {
    this.presets.clear();
    await this.persistToStorage();
  }

  /**
   * Get Statistics
   */
  async getStats(): Promise<{
    totalCount: number;
    favoriteCount: number;
    byCategory: Record<DropCategory, number>;
  }> {
    await this.initialize();

    const categories: Record<string, number> = {};

    for (const preset of this.presets.values()) {
      const cat = preset.profile.category;
      categories[cat] = (categories[cat] || 0) + 1;
    }

    return {
      totalCount: this.presets.size,
      favoriteCount: Array.from(this.presets.values()).filter((p) => p.favorite).length,
      byCategory: categories as Record<DropCategory, number>,
    };
  }
}

// Export singleton
export const dropPresetStore = new DropPresetStore();
