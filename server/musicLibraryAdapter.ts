/**
 * LEGO-P1-001 · Server-Bibliothek fuer die Musik-Kontext-Werkzeuge
 * =================================================================
 * Verbindet `music.lego/extract/complete/repaint` (src/core/ai/orchestrator/
 * musicContextTools.ts) mit dem BESTEHENDEN Bibliothekspfad des Servers:
 *
 *   - Vorspuren aufloesen: Server-Ablage (`localMediaStore`, data/uploads +
 *     index.json). Eintraege, die nur in R2/Supabase liegen, sind hier noch
 *     nicht aufloesbar (offener Punkt im Ticket) – der Aufruf meldet das klar.
 *   - Ausgaben still speichern: `processSampleUpload` – dieselbe Verarbeitung
 *     wie ein Upload (validieren → scannen → R2 + Supabase, ohne R2 Server-Ablage).
 *
 * Nichts landet auf Nutzergeraeten (AGENTS.md "Nothing on user devices").
 */
import type { LibraryAudio, LibrarySaveEntry, MusicLibraryPort } from '../src/core/ai/orchestrator/musicContextTools';
import { listLocalSamples, readLocalMedia } from './localMediaStore.ts';
import { processSampleUpload, type UploadDeps } from './routes/uploadRoutes.ts';

const LOCAL_MEDIA_PREFIX = '/api/media/uploads/';

export interface MusicLibraryAdapterDeps extends Pick<UploadDeps, 'getMasterPlayerUrl'> {
  /** Test-Naht: Standard sind localMediaStore/processSampleUpload. */
  listSamples?: typeof listLocalSamples;
  readMedia?: typeof readLocalMedia;
  upload?: typeof processSampleUpload;
}

export function createMusicLibraryAdapter(deps: MusicLibraryAdapterDeps): MusicLibraryPort {
  const listSamples = deps.listSamples ?? listLocalSamples;
  const readMedia = deps.readMedia ?? readLocalMedia;
  const upload = deps.upload ?? processSampleUpload;

  return {
    async resolveAudio(id: string): Promise<LibraryAudio | null> {
      const entry = (await listSamples()).find((s) => s.id === id);
      if (!entry || !entry.url.startsWith(LOCAL_MEDIA_PREFIX)) return null;
      const file = decodeURIComponent(entry.url.slice(LOCAL_MEDIA_PREFIX.length));
      const data = await readMedia(file);
      if (!data) return null;
      return { id: entry.id, name: entry.name, audioBase64: data.toString('base64'), bytes: data.length };
    },

    async save(entry: LibrarySaveEntry): Promise<{ id: string; url?: string }> {
      const data = Buffer.from(entry.audioBase64, 'base64');
      const safe = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ai-audio';
      const fields: Record<string, string> = {
        kind: entry.kind,
        name: entry.name,
        tags: entry.tags.join(','),
        type: entry.kind,
      };
      if (entry.bpm !== undefined) fields.bpm = String(entry.bpm);
      if (entry.key) fields.key = entry.key;
      const result = await upload(
        { data, filename: `${safe}.${entry.format}`, contentType: `audio/${entry.format === 'mp3' ? 'mpeg' : entry.format}`, fields },
        { getMasterPlayerUrl: deps.getMasterPlayerUrl },
      );
      const sample = result.body.sample as { id?: string; url?: string } | undefined;
      if (result.httpStatus !== 200 || !sample?.id) {
        throw new Error(String(result.body.message ?? `Ablage fehlgeschlagen (HTTP ${result.httpStatus})`));
      }
      return { id: sample.id, url: sample.url };
    },
  };
}
