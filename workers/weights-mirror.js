/**
 * audioMONASTRY · Gewichte-Spiegel an der Edge (FLEET-P1-013 / AI-RUNPOD-SING-002)
 * =============================================================================
 * Warum es diese Fassung gibt
 * --------------------------
 * `scripts/weights-mirror.py` laedt bei HuggingFace herunter, packt lokal ein TAR
 * und schiebt es nach R2. Der Flaschenhals ist die Leitung der Werkbank: gemessen
 * ~1,1 MB/s, d.h. ~60 GB brauchen 12-15 Stunden. Dieser Worker holt die Dateien
 * direkt von HuggingFace und schreibt sie nach R2 - der Datenverkehr laeuft an der
 * Edge, die werkbankeigene Leitung ist unbeteiligt.
 *
 * Warum DATEIWEISE und nicht als TAR
 * ---------------------------------
 * Der Pod erwartet heute `weights/<modell>/<revision>.tar` und prueft dessen
 * SHA-256 ueber die GANZE Datei, bevor er entpackt (services/audiomonastry-ai-runtime/
 * pod_start.py, download()/safe_extract()). Diesen Hash kann ein Worker nicht
 * bilden: WebCrypto kennt keinen schrittweisen Digest, und eine 16-GB-Datei passt
 * weder in den Speicher noch in das CPU-Budget. HuggingFace liefert den SHA-256
 * aber JE DATEI mit (API-Feld `lfs.oid`) - also wird hier dateiweise gespiegelt und
 * je Datei genau der Hash hinterlegt, den HF nennt. Kleine Nicht-LFS-Dateien
 * (config.json, *.py) werden im Worker gehasht; das sind Kilobyte.
 *
 * Was der Pod dafuer noch braucht (offener Punkt, im Ticket vermerkt)
 * -----------------------------------------------------------------
 * `pod_start.py` muss dateiweise Eintraege annehmen (Pfad + sha256 + size, Ablage
 * unter HF_HOME/<repo-relativer Pfad>), und `runpod-pods.py` muss die presigned
 * Eintraege aus `_manifest.json` bauen koennen. Das TAR-Verfahren bleibt gueltig -
 * diese Fassung ergaenzt es, sie ersetzt es nicht.
 *
 * Aufrufe
 * -------
 *   GET /?model=<name>&repo=<org/name>&rev=<revision>          # alles + Manifest
 *   GET /?repo=<org/name>&rev=<revision>&list=1                # nur auflisten (Trockenlauf)
 *   GET /?model=<name>&repo=<org/name>&rev=<rev>&file=<pfad>   # EINE Datei (Nachziehen)
 *   Token: ?token=<MIRROR_TOKEN> oder Kopfzeile x-mirror-token
 *
 * Schluessel in R2
 * ----------------
 *   weights/<modell>/<revision>/<repo-relativer-pfad>   (die Datei selbst)
 *   weights/<modell>/<revision>/<pfad>.sha256           (je Datei)
 *   weights/<modell>/<revision>/_manifest.json          (Liste mit Groesse + SHA-256)
 *
 * Grenzen (ehrlich)
 * -----------------
 * Cloudflare erlaubt je Aufruf ~1000 Unteranfragen. Deshalb 32-MiB-Teile und ein
 * Sicherheitsnetz: laeuft ein Modell darueber, bricht der Worker mit klarer Meldung
 * ab und der Aufruf wird je Datei (`file=`) wiederholt - ein stiller Abbruch waere
 * schlimmer als eine Fehlermeldung.
 */

const HF = 'https://huggingface.co';
/** Teilgroesse fuer den Multipart-Upload: 32 MiB (Speicherbedarf im Worker bleibt klein). */
const PART = 32 * 1024 * 1024;
/** Schutz vor dem Unteranfrage-Limit je Aufruf. */
const MAX_PARTS_PER_RUN = 900;
/** Nicht-LFS-Dateien werden komplett in den Speicher geholt - groessere brechen ab. */
const MAX_INLINE = 16 * 1024 * 1024;
/** Dateien, die nie auf einen Pod gehoeren. */
const SKIP = ['.gitattributes', '.gitignore', '.git/'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function hfHeaders(env) {
  const headers = { 'user-agent': 'audioMONASTRY-mirror-worker/2.0', accept: '*/*' };
  if (env.HF_TOKEN) headers.authorization = `Bearer ${env.HF_TOKEN}`;
  return headers;
}

/**
 * Dateiliste eines HF-Repos. `expand=true` liefert fuer LFS-Dateien den SHA-256
 * (`lfs.oid`) und die Groesse - damit braucht der Worker fuer grosse Gewichte
 * keinen eigenen Hash.
 */
export async function listRepo(repo, rev, env) {
  const res = await fetch(
    `${HF}/api/models/${repo}/tree/${encodeURIComponent(rev)}?recursive=true&expand=true`,
    { headers: hfHeaders(env) },
  );
  if (!res.ok) throw new Error(`HF-Liste fehlgeschlagen: HTTP ${res.status}`);
  const entries = await res.json();
  if (!Array.isArray(entries)) throw new Error(`HF-Antwort unerwartet: ${JSON.stringify(entries).slice(0, 200)}`);
  return entries
    .filter((e) => e && e.type === 'file' && typeof e.path === 'string' && !SKIP.some((s) => e.path === s || e.path.startsWith(s)))
    .map((e) => ({
      path: e.path,
      size: Number(e.size ?? e.lfs?.size ?? 0),
      sha256: typeof e.lfs?.oid === 'string' ? e.lfs.oid : null,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Einen Antwort-Stream in Teilen nach R2 schreiben (kein Hashing: der Hash kommt von HF). */
async function putStreaming(res, key, env, knownSha) {
  const upload = await env.R2_BUCKET.createMultipartUpload(key);
  const reader = res.body.getReader();
  const parts = [];
  // Anstehende Chunks werden NICHT zusammengefuegt, sondern als Liste gehalten und
  // erst beim vollen Teil einmal kopiert. Ein Zusammenfuegen je Lese-Chunk kostet
  // bei 1,7 GB hunderte GB Kopierarbeit und laeuft in das CPU-Limit (Fehler 1102).
  let chunks = [];
  let pending = 0;
  let partNumber = 1;
  let total = 0;

  const flush = async (force) => {
    while (pending >= PART || (force && pending > 0)) {
      const size = pending >= PART ? PART : pending;
      const part = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const head = chunks[0];
        const take = Math.min(head.length, size - offset);
        part.set(head.subarray(0, take), offset);
        offset += take;
        if (take === head.length) chunks.shift();
        else chunks[0] = head.subarray(take);
      }
      pending -= size;
      parts.push(await upload.uploadPart(partNumber, part));
      partNumber += 1;
      if (parts.length > MAX_PARTS_PER_RUN) {
        await upload.abort?.();
        throw new Error(`mehr als ${MAX_PARTS_PER_RUN} Teile in einem Aufruf - bitte je Datei mit &file=<pfad> nachziehen`);
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (value && value.length) {
      chunks.push(value);
      pending += value.length;
      total += value.length;
      await flush(false);
    }
    if (done) break;
  }
  await flush(true);
  await upload.complete();
  return { key, parts: parts.length, bytes: total, sha256: knownSha };
}

/** Eine Datei spiegeln; kleine Nicht-LFS-Dateien werden dabei im Worker gehasht. */
export async function mirrorFile(repo, rev, file, model, env) {
  const url = `${HF}/${repo}/resolve/${encodeURIComponent(rev)}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
  const key = `weights/${model}/${rev}/${file.path}`;
  const res = await fetch(url, { headers: hfHeaders(env) });
  if (!res.ok) throw new Error(`HF-Datei fehlgeschlagen: HTTP ${res.status} (${file.path})`);

  if (file.sha256) {
    const out = await putStreaming(res, key, env, file.sha256);
    await env.R2_BUCKET.put(`${key}.sha256`, `${file.sha256}  ${file.path}\n`, { httpMetadata: { contentType: 'text/plain' } });
    return out;
  }

  if (file.size > MAX_INLINE) {
    throw new Error(`Nicht-LFS-Datei ${file.path} ist ${file.size} Bytes gross (Grenze ${MAX_INLINE}) - Hash waere nicht bildbar`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.R2_BUCKET.put(key, bytes);
  await env.R2_BUCKET.put(`${key}.sha256`, `${sha}  ${file.path}\n`, { httpMetadata: { contentType: 'text/plain' } });
  return { key, parts: 1, bytes: bytes.length, sha256: sha };
}

/** Manifest lesen, ergaenzen und zurueckschreiben (auch fuer den Einzeldatei-Aufruf). */
async function upsertManifest(model, rev, repo, entry, env) {
  const key = `weights/${model}/${rev}/_manifest.json`;
  const existing = await env.R2_BUCKET.get(key);
  let doc = { model, repo, revision: rev, files: [] };
  if (existing) {
    try {
      doc = JSON.parse(await existing.text());
    } catch {
      /* defektes Manifest wird ersetzt */
    }
    if (!Array.isArray(doc.files)) doc.files = [];
  }
  doc.model = model;
  doc.repo = repo;
  doc.revision = rev;
  doc.updatedAt = new Date().toISOString();
  doc.files = doc.files.filter((f) => f.path !== entry.path).concat(entry).sort((a, b) => (a.path < b.path ? -1 : 1));
  doc.totalBytes = doc.files.reduce((sum, f) => sum + Number(f.size || 0), 0);
  await env.R2_BUCKET.put(key, JSON.stringify(doc, null, 2), { httpMetadata: { contentType: 'application/json' } });
  return doc;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const token = url.searchParams.get('token') ?? request.headers.get('x-mirror-token') ?? '';
      if (!env.MIRROR_TOKEN || token !== env.MIRROR_TOKEN) return json({ ok: false, error: 'nicht berechtigt' }, 401);
      if (!env.R2_BUCKET) return json({ ok: false, error: 'R2_BUCKET-Bindung fehlt' }, 500);

      const repo = url.searchParams.get('repo');
      const rev = url.searchParams.get('rev') || 'main';
      const model = url.searchParams.get('model') || (repo ? repo.split('/').pop() : null);
      if (!repo || !model) return json({ ok: false, error: 'repo und model fehlen' }, 400);

      const files = await listRepo(repo, rev, env);
      if (url.searchParams.has('list')) {
        return json({ ok: true, model, repo, revision: rev, files, totalBytes: files.reduce((s, f) => s + f.size, 0) });
      }

      const only = url.searchParams.get('file');
      const todo = only ? files.filter((f) => f.path === only) : files;
      if (only && todo.length === 0) return json({ ok: false, error: `Datei nicht im Repo: ${only}` }, 404);

      const written = [];
      for (const file of todo) {
        const out = await mirrorFile(repo, rev, file, model, env);
        const entry = { path: file.path, key: out.key, size: out.bytes, sha256: out.sha256 };
        written.push(entry);
        await upsertManifest(model, rev, repo, entry, env);
      }
      return json({
        ok: true,
        model,
        repo,
        revision: rev,
        files: written.length,
        totalBytes: written.reduce((s, f) => s + f.size, 0),
        written,
        hinweis: 'Der Pod braucht dateiweise Eintraege (pfad+sha256+size) - pod_start.py/runpod-pods.py, siehe Ticket.',
      });
    } catch (error) {
      const name = error && error.name ? `${error.name}: ` : '';
      return json({ ok: false, error: `${name}${error && error.message ? error.message : String(error)}` }, 500);
    }
  },
};
