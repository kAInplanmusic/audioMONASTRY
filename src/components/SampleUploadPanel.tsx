import React, { useRef, useState } from 'react';
import { Upload, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useSamples } from '../context/SampleContext';
import {
  UPLOAD_KINDS, UploadKind, validateAudioFile, tagsFrom, localSampleId,
} from '../utils/sampleUpload';
import { persistFile } from '../utils/opfs';
import type { AudioSample } from '../data/samples';

type UploadStatus = 'idle' | 'uploading' | 'ok' | 'local' | 'error';

/**
 * SampleUploadPanel – Audio-Dateien hochladen (Cloud ODER lokaler Fallback).
 * ---------------------------------------------------------------
 * 1. Validiert Format (wav/mp3/flac/ogg/m4a/aac/aiff)
 * 2. Lädt über POST /api/upload/sample (R2 + Supabase inkl. Scan/Tagging)
 * 3. Fällt die Cloud aus (nicht konfiguriert/Fehler), wird die Datei lokal
 *    in OPFS persistiert und als lokales Sample eingereiht (kein Datenverlust).
 */
export const SampleUploadPanel: React.FC = () => {
  const { addSample } = useSamples();
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState<UploadKind>('sample');
  const [tagsInput, setTagsInput] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (status === 'uploading') return;
    setStatus('uploading');
    setMessage('');
    try {
      const validation = validateAudioFile(file.name, file.type);
      if (!validation.ok) {
        setStatus('error');
        setMessage(validation.error ?? 'Ungültige Datei');
        return;
      }
      const name = file.name.replace(/\.[^.]+$/, '') || 'Upload';
      const tags = tagsFrom(tagsInput, kind, validation.ext);

      // Cloud-Pfad: multipart → /api/upload/sample (Scan + R2 + Supabase).
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('kind', kind);
        form.append('name', name);
        form.append('tags', tags.join(','));
        const resp = await fetch('/api/upload/sample', { method: 'POST', body: form });
        const data = await resp.json().catch(() => ({})) as { status?: string; sample?: AudioSample; message?: string };
        if (resp.ok && data.status === 'ok' && data.sample) {
          addSample(data.sample);
          setStatus('ok');
          setMessage(`Cloud: ${data.sample.name} erkannt, getaggt und einsortiert.`);
          return;
        }
        throw new Error(data.message || `Server antwortete ${resp.status}`);
      } catch (cloudError) {
        // Lokaler Fallback: OPFS + Sample-Liste (Cloud optional).
        const id = localSampleId(kind, name);
        const blobUrl = URL.createObjectURL(file);
        const sample: AudioSample = {
          id,
          name,
          category: kind === 'voice' || kind === 'recording' ? 'highs' : 'mids',
          type: kind,
          url: blobUrl,
          description: `Lokaler Upload (${kind}) – Cloud nicht verfügbar: ${(cloudError as Error).message}`,
          tags,
          parameters: {},
        };
        addSample(sample);
        try { await persistFile(`${id}.${validation.ext || 'wav'}`, file); } catch { /* OPFS optional */ }
        setStatus('local');
        setMessage(`Lokal gespeichert (OPFS): ${name} – Cloud-Upload übersprungen.`);
      }
    } catch (e) {
      setStatus('error');
      setMessage((e as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-black/40 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold tracking-widest text-neutral-400 uppercase flex items-center gap-1.5">
          <Upload className="w-3.5 h-3.5 text-cyan-400" /> Audio-Upload
        </span>
        {status === 'ok' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
        {status === 'local' && <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />}
        {status === 'error' && <AlertTriangle className="w-3.5 h-3.5 text-red-400" />}
        {status === 'uploading' && <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as UploadKind)}
          aria-label="Upload-Kategorie"
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[10px] text-neutral-200"
        >
          {UPLOAD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="Tags (kommagetrennt)"
          aria-label="Upload-Tags"
          className="flex-1 min-w-[140px] bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[10px] text-neutral-200 placeholder:text-neutral-600"
        />
        <input
          ref={fileRef}
          type="file"
          accept=".wav,.mp3,.flac,.ogg,.m4a,.aac,.aiff,.aif,audio/*"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
          className="text-[10px] text-neutral-400 file:mr-2 file:px-2 file:py-1 file:rounded file:border file:border-neutral-700 file:bg-neutral-900 file:text-cyan-300 file:text-[10px]"
        />
      </div>
      {message && (
        <p className={`mt-2 text-[9px] font-mono leading-snug ${status === 'error' ? 'text-red-400' : status === 'local' ? 'text-amber-300' : 'text-emerald-300'}`}>
          {message}
        </p>
      )}
      <p className="mt-1 text-[8px] text-neutral-600 font-mono">
        Cloud (R2+Supabase) mit Scan · fällt sie aus, wird lokal in OPFS gespeichert.
      </p>
    </div>
  );
};
