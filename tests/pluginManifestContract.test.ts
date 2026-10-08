import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PLUGIN_CONTRACTS, CHANNEL_SOURCES, CONTRACT_BY_ID } from '../src/plugins/pluginContract';

/**
 * C1 – DIE VIERTE STELLE.
 *
 * Der Audio-Vertrag (B0) haelt Registry, Signalweg und Kanalbelegung zusammen.
 * Beim Bau von C1 fiel auf: `public/plugin-manifest.json` fuehrt die 16 Plugins
 * ein VIERTES Mal - mit eigener Reihenfolge, eigenem Namen, eigenem Kuerzel und
 * eigenem Symbol. Wer dort etwas aendert, merkt nichts von den anderen dreien.
 *
 * Dieser Test prueft das Manifest gegen den Vertrag. Er ist bewusst als
 * Datei-Test gebaut (das Manifest ist JSON im public/-Ordner, kein Modul) - so
 * faellt eine Aenderung ohne Gegenprobe im normalen Testlauf auf.
 */

interface ManifestPlugin {
  id: string;
  name: string;
  short: string;
  icon: string;
}
interface Manifest {
  worklets: { id: string; url: string }[];
  ui_plugins: ManifestPlugin[];
}

const manifest: Manifest = JSON.parse(
  readFileSync(new URL('../public/plugin-manifest.json', import.meta.url), 'utf8'),
);

describe('C1 – plugin-manifest.json deckt sich mit dem Vertrag', () => {
  it('fuehrt genau dieselben 16 Plugin-IDs', () => {
    const imManifest = manifest.ui_plugins.map((p) => p.id).sort();
    const imVertrag = PLUGIN_CONTRACTS.map((c) => c.id).sort();
    expect(imManifest).toEqual(imVertrag);
  });

  it('hat keine Doppel-Eintraege', () => {
    const ids = manifest.ui_plugins.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('nennt dieselben Anzeigenamen wie der Vertrag', () => {
    // Der Name steht in beiden Dateien. Laufen sie auseinander, zeigt die
    // Oberflaeche etwas anderes als das Audio-Modell meint.
    const namen: Record<string, string> = {};
    for (const p of manifest.ui_plugins) namen[p.id] = p.name;
    for (const c of PLUGIN_CONTRACTS) {
      expect(namen[c.id], `${c.id} Name im Manifest`).toBe(c.name);
    }
  });

  it('jedes Plugin hat Kuerzel und Symbol', () => {
    for (const p of manifest.ui_plugins) {
      expect(p.short, `${p.id} Kuerzel`).toBeTruthy();
      expect(p.icon, `${p.id} Symbol`).toBeTruthy();
    }
  });

  it('die Kanal-Quellen des Vertrags sind im Manifest als Plugins vorhanden', () => {
    // Gegenprobe fuer die Zuordnung: eine Quelle, die im Manifest fehlt, haette
    // in der Oberflaeche kein Bedienfeld - der Ton waere nicht erreichbar.
    const manifestIds = new Set(manifest.ui_plugins.map((p) => p.id));
    for (const c of CHANNEL_SOURCES) {
      expect(manifestIds.has(c.id), `${c.id} fehlt im Manifest`).toBe(true);
    }
  });

  it('die Worklet-Eintraege haben ID und URL', () => {
    expect(manifest.worklets.length).toBeGreaterThan(0);
    for (const w of manifest.worklets) {
      expect(w.id, 'Worklet-ID').toBeTruthy();
      expect(w.url, `Worklet ${w.id} URL`).toBeTruthy();
    }
  });
});

describe('C1 – die Nachbearbeitung hat je ein Worklet', () => {
  /** Prozessor-Name je Insert/FX-Knoten, den die Kette anspricht. */
  const WORKLET_OF: Record<string, string> = {
    eq: 'eq-processor',
    dsp: 'dsp-processor',
    master: 'mastering-processor',
    effect: 'effect-processor',
    spatial: 'spatial-processor',
  };

  it('fuer jede Nachbearbeitungs-Stufe existiert ein Worklet im Manifest', () => {
    const ids = new Set(manifest.worklets.map((w) => w.id));
    for (const [plugin, worklet] of Object.entries(WORKLET_OF)) {
      expect(CONTRACT_BY_ID[plugin], `${plugin} im Vertrag`).toBeTruthy();
      expect(ids.has(worklet), `${plugin} braucht ${worklet}`).toBe(true);
    }
  });
});
