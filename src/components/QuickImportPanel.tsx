import React, { useRef, useState } from 'react';
import { FolderOpen, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useSamples } from '../context/SampleContext';
import { validateAudioFile, tagsFrom, localSampleId } from '../utils/sampleUpload';
import { persistFile } from '../utils/opfs';
import { buildQuickImportEntries } from '../core/library/quickImport';
import type { AudioSample } from '../data/samples';

type Status = 'idle' | 'importing' | 'done' | 'partial';

/**
 * QuickImportPanel – biblioMONK USB-/Stick-Import (AUDIO 7 / Quick-Import).
 * Wählt per Dateisystem-Picker einen Ordner (Stick) aus und importiert alle
 * Audio-Dateien: Dateiname → Titel/Artist, Auto-Tags → Cloud (/api/upload/sample)
 * mit lokalem OPFS-Fallback → Sample-Liste.
 */
export const QuickImportPanel: React.FC = () => {
  const { addSample } = useSamples();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setStatus('importing');
    let ok = 0;
    let skipped = 0;
    let failed = 0;

    const entries = buildQuickImportEntries(files.map((f) => ({ name: f.name, size: f.size })));
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const entry = entries[i];
      try {
        const validation = validateAudioFile(file.name, file.type);
        if (!validation.ok) { skipped++; continue; }
        const tags = tagsFrom((entry?.tags ?? []).join(','), 'sample', validation.ext);

        // Cloud-Pfad
        try {
          const form = new FormData();
          form.append('file', file);
          form.append('kind', 'sample');
          form.append('name', entry?.name ?? file.name.replace(/\.[^.]+$/, ''));
          form.append('tags', tags.join(','));
          const resp = await fetch('/api/upload/sample', { method: 'POST', body: form });
          const data = await resp.json().catch(() => ({})) as { status?: string; sample?: AudioSample; message?: string };
          if (resp.ok && data.status === 'ok' && data.sample) { addSample(data.sample); ok++; continue; }
          throw new Error(data.message || `HTTP ${resp.status}`);
        } catch {
          // Lokaler OPFS-Fallback
          const name = (entry?.name ?? file.name.replace(/\.[^.]+$/, '')) || 'Import';
          const id = localSampleId('sample', `${entry?.id ?? name}`);
          const blobUrl = URL.createObjectURL(file);
          const sample: AudioSample = {
            id,
            name,
            category: 'mids',
            type: tags[0] ?? 'sample',
            url: blobUrl,
            description: `Stick-Import (${entry?.artist || 'unbekannt'})`,
            tags,
            parameters: {},
          };
          addSample(sample);
          try { await persistFile(`${id}.${validation.ext || 'wav'}`, file); } catch { /* OPFS optional */ }
          ok++;
        }
      } catch { failed++; }
    }
    setStatus(failed > 0 ? 'partial' : 'done');
    setMessage(`Import fertig: ${ok} neu, ${skipped} übersprungen, ${failed} Fehler.`);
  };

  return (
    <div className="rounded-lg border border-blue-500/40 bg-blue-950/10 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-blue-300 uppercase tracking-widest flex items-center gap-1.5">
          <FolderOpen className="w-3.5 h-3.5" /> USB-/Stick-Import (Ordner)
        </span>
        {status === 'importing' && <Loader2 className="w-3.5 h-3.5 text-blue-300 animate-spin" />}
        {status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
        {(status === 'partial') && <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />}
      </div>
      <p className="text-[9px] text-neutral-500 mt-1">
        Wählt den Ordner vom Stick – alle Audio-Dateien werden benannt, getaggt und in die Bibliothek geladen.
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory ist ein Chromium/Electron-Extra
        webkitdirectory=""
        onChange={(e) => void handleFiles(e.target.files)}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={status === 'importing'}
        className="mt-2 w-full px-3 py-2 rounded border border-blue-500/60 bg-blue-500/10 text-blue-300 text-[10px] font-bold uppercase tracking-wider cursor-pointer hover:bg-blue-500/20 disabled:opacity-40"
      >
        Ordner vom Stick auswählen
      </button>
      {message && <p className="text-[9px] font-mono text-neutral-400 mt-1">{message}</p>}
    </div>
  );
};
