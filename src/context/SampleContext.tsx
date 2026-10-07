import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';
import { PRESET_SAMPLE_DATABASE, AudioSample } from '../data/samples';
import { uploadFileInChunks } from '../utils/chunkedUpload';
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

  // Betreiber 2026-10-06: nichts auf den Geräten. Hochgeladene/erzeugte Audios
  // liegen auf dem Server (data/uploads, wenn keine Cloud-Ablage) – hier die
  // Liste für alle Nutzer laden, statt Dateien aus dem Gerät (früher OPFS).
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/library/uploads', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { samples?: AudioSample[] } | null) => {
        if (cancelled || !Array.isArray(body?.samples) || body.samples.length === 0) return;
        const server = body.samples.filter((x) => x && typeof x.id === 'string' && typeof x.url === 'string');
        setSamples((prev) => {
          const ids = new Set(prev.map((x) => x.id));
          return [...prev, ...server.filter((x) => !ids.has(x.id))];
        });
      })
      .catch(() => { /* Bibliothek ohne Server-Uploads */ });
    return () => { cancelled = true; };
  }, []);

  // O(1)-Lookup statt O(n)-Suche (biblioMONK/Sampler fragen häufig nach IDs).
  const samplesById = useMemo(() => new Map(samples.map((s) => [s.id, s])), [samples]);
  const getSampleById = useCallback((id: string) => samplesById.get(id), [samplesById]);

  const addSample = useCallback((sample: AudioSample) => {
    setSamples(prev => [...prev, sample]);
    // Betreiber 2026-10-06: nichts auf den Geräten. Neu erzeugtes Audio
    // (Aufnahme, Stimme, Stems …) geht still in die Bibliothek auf dem SERVER;
    // danach zeigt das Sample auf die Server-Adresse statt auf den Browser-Speicher.
    if (sample.url && sample.url.startsWith('blob:')) {
      const kind = /voice/i.test(sample.type) ? 'voice' : /record/i.test(sample.type) ? 'recording' : /stem/i.test(sample.type) ? 'stem' : 'sample';
      void fetch(sample.url)
        .then((r) => r.blob())
        .then((blob) => uploadFileInChunks(new File([blob], `${sample.id}.wav`, { type: blob.type || 'audio/wav' }), {
          kind,
          fields: { kind, name: sample.name, tags: (sample.tags ?? []).join(',') },
        }))
        .then((data) => {
          const stored = (data as { status?: string; sample?: AudioSample }).sample;
          if ((data as { status?: string }).status !== 'ok' || !stored?.url) throw new Error('Server meldete keinen Erfolg');
          setSamples((prev) => prev.map((x) => (x.id === sample.id ? { ...x, url: stored.url, description: `${x.description ?? ''} · auf dem Server gespeichert`.trim() } : x)));
        })
        .catch((e: Error) => {
          setSamples((prev) => prev.map((x) => (x.id === sample.id ? { ...x, description: `NICHT gespeichert (Server-Upload fehlgeschlagen: ${e.message}) – nur bis zum Neuladen` } : x)));
        });
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
