import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';
import { PRESET_SAMPLE_DATABASE, AudioSample } from '../data/samples';
import { persistFile, listSamples } from '../utils/opfs';
import { fetchCloudSamples, CloudSampleRow, isCloudAvailable, pushSampleToCloud as pushSampleToCloudApi, syncCloudDatabase as syncCloudDatabaseApi, CloudActionResult } from '../lib/supabaseClient';

interface SampleContextType {
  samples: AudioSample[];
  selectedSample: AudioSample | null;
  setSelectedSample: (sample: AudioSample | null) => void;
  getSampleById: (id: string) => AudioSample | undefined;
  addSample: (sample: AudioSample) => void;
  cloudEnabled: boolean;
  /** Einzelnes Sample in die externe Supabase-Datenbank upserten (via Server-API). */
  pushSampleToCloud: (sample: AudioSample) => Promise<CloudActionResult>;
  /** Eingebaute Preset-Daten in die externe Datenbank synchronisieren. */
  syncCloudDatabase: () => Promise<CloudActionResult>;
  /** Touch-Fallback: angetipptes Sample, das als Nächstes in eine Drop-Zone gesetzt wird. */
  pendingSample: AudioSample | null;
  setPendingSample: (sample: AudioSample | null) => void;
  /**
   * Einheitliche Action-Menu-Übernahme: Ein geöffnetes Plugin (sampler/drum)
   * wird aufgefordert, dieses Sample in seinen vorhandenen Audio-Eingang
   * (Pad/Step) zu übernehmen.
   */
  takeoverRequest: { pluginId: string; sample: AudioSample; token: number } | null;
  requestTakeover: (pluginId: string, sample: AudioSample) => void;
  clearTakeoverRequest: () => void;
}

const SampleContext = createContext<SampleContextType | undefined>(undefined);

/** Macht eine Supabase-Zeile zu einer vollständigen AudioSample. */
function rowToSample(row: CloudSampleRow): AudioSample {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    type: row.type,
    url: row.url ?? undefined,
    description: row.description ?? '',
    tags: row.tags ?? [],
    parameters: (row.parameters ?? {}) as AudioSample['parameters'],
  };
}

export const SampleProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [samples, setSamples] = useState<AudioSample[]>(PRESET_SAMPLE_DATABASE);
  const [selectedSample, setSelectedSample] = useState<AudioSample | null>(null);
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [pendingSample, setPendingSample] = useState<AudioSample | null>(null);
  const [takeoverRequest, setTakeoverRequest] = useState<{ pluginId: string; sample: AudioSample; token: number } | null>(null);

  const requestTakeover = useCallback((pluginId: string, sample: AudioSample) => {
    setTakeoverRequest({ pluginId, sample, token: Date.now() });
  }, []);

  const clearTakeoverRequest = useCallback(() => setTakeoverRequest(null), []);

  // Cloud: externe Sample-Metadaten von Supabase laden und mit den eingebauten
  // Presets zusammenführen. Fällt bei Nicht-Konfiguration/Fehler auf Presets zurück.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const available = isCloudAvailable();
      setCloudEnabled(available);
      if (!available) return;
      const result = await fetchCloudSamples();
      if (cancelled) return;
      if (result.ok && result.data.length > 0) {
        const cloud: AudioSample[] = result.data.map(rowToSample);
        setSamples((prev) => {
          const merged = new Map<string, AudioSample>();
          // eingebaute Presets zuerst (Fallback-Rang), dann Cloud überschreibt gleiche ids.
          prev.forEach((s) => merged.set(s.id, s));
          cloud.forEach((s) => merged.set(s.id, s));
          return Array.from(merged.values());
        });
      }
    })();
    return () => { cancelled = true; };
     
  }, []);

  // P7: OPFS-basierte Samples beim Provider-Mount laden und in den State
  // einbinden (nur neue, noch nicht vorhandene Einträge). Läuft deterministisch
  // und offline im Hintergrund; bei OPFS-Verfügbarkeit werden die Dateinamen
  // als nutzbare Samples ergänzt.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const names = await listSamples();
      if (cancelled) return;
      const existing = new Set(samples.map((s) => s.id));
      const news: AudioSample[] = names
        .filter((n) => !existing.has(n))
        .map((n) => ({
          id: n,
          name: n.replace(/\.(wav|mp3|ogg|flac|aiff)$/i, '').replace(/_/g, ' '),
          category: 'mids' as const,
          type: 'OPFS',
          description: 'Lokale OPFS-Datei',
          tags: ['local', 'opfs'],
          url: undefined,
          parameters: {},
        }));
      if (news.length > 0) setSamples((prev) => [...prev, ...news]);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // O(1)-Lookup statt O(n)-Suche (biblioMONK/Sampler fragen häufig nach IDs).
  const samplesById = useMemo(() => new Map(samples.map((s) => [s.id, s])), [samples]);
  const getSampleById = useCallback((id: string) => samplesById.get(id), [samplesById]);

  const addSample = useCallback((sample: AudioSample) => {
    setSamples(prev => [...prev, sample]);
    // Task 15: bei Blob-URLs das Sample zusätzlich im OPFS zwischenspeichern.
    if (sample.url && sample.url.startsWith('blob:')) {
      fetch(sample.url)
        .then(r => r.blob())
        .then(blob => persistFile(sample.id + '.wav', blob))
        .catch(() => { /* OPFS optional, Fehler ignorieren */ });
    }
  }, []);

  // Cloud-Schreibpfad: Einzel-Upsert über die Server-API (service_role bleibt
  // serverseitig). Kein Fehler-Wurf – der Aufrufer erhält { ok, error? }.
  const pushSampleToCloud = useCallback(async (sample: AudioSample): Promise<CloudActionResult> => {
    return pushSampleToCloudApi({
      id: sample.id,
      name: sample.name,
      category: sample.category,
      type: sample.type,
      url: sample.url ?? null,
      description: sample.description ?? '',
      tags: sample.tags ?? [],
      parameters: sample.parameters ?? {},
    });
  }, []);

  const syncCloudDatabase = useCallback(async (): Promise<CloudActionResult> => {
    return syncCloudDatabaseApi();
  }, []);

  const value = useMemo(() => ({
    samples,
    selectedSample,
    setSelectedSample,
    getSampleById,
    addSample,
    cloudEnabled,
    pushSampleToCloud,
    syncCloudDatabase,
    pendingSample,
    setPendingSample,
    takeoverRequest,
    requestTakeover,
    clearTakeoverRequest,
  }), [samples, selectedSample, getSampleById, addSample, cloudEnabled, pushSampleToCloud, syncCloudDatabase, pendingSample, takeoverRequest, requestTakeover, clearTakeoverRequest]);

  return (
    <SampleContext.Provider value={value}>
      {children}
    </SampleContext.Provider>
  );
};

export const useSamples = () => {
  const context = useContext(SampleContext);
  if (!context) throw new Error('useSamples must be used within a SampleProvider');
  return context;
};
