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
 * Grosse Gewichte gehen als Stream direkt an R2 (`put(key, stream)`) - der Worker kopiert
 * nichts und braucht kein CPU-Budget fuer die Dateigroesse. Kleine Nicht-LFS-Dateien werden
 * im Worker gehasht und dafuer vollstaendig in den Speicher geholt (Grenze MAX_INLINE).
 */

const HF = 'https://huggingface.co';
/** Nicht-LFS-Dateien werden komplett in den Speicher geholt - groessere brechen ab. */
const MAX_INLINE = 16 * 1024 * 1024;
/** Dateien, die nie auf einen Pod gehoeren. */
const SKIP = ['.gitattributes', '.gitignore', '.git/'];
/**
 * Doppelte Gewichtsformate: dieselben Gewichte liegen in Repos oft als `.bin`
 * (PyTorch), `.h5` (TensorFlow), `.msgpack` (Flax) UND `.safetensors` vor. Die Pods
 * laden mit transformers, das safetensors bevorzugt - die Kopien kosten nur Volumen,
 * R2-Speicher und im Worker CPU (ein 3-GB-Flax-Duplikat ist der Grund fuer Fehler 1102).
 * Weggelassen wird nur, wenn es im Repo ueberhaupt eine safetensors-Datei gibt.
 */
const WEIGHT_DUPLICATE = /(^|\/)(pytorch_model|model|tf_model|flax_model)(-\d+-of-\d+)?\.(bin|h5|msgpack|onnx|ot)$/;

/** Doppelte Gewichtsformate aussortieren; liefert die behaltenen und die weggelassenen Dateien. */
export function pruneDuplicateFormats(files) {
  if (!files.some((f) => f.path.endsWith('.safetensors'))) return { files, skipped: [] };
  const skipped = files.filter((f) => WEIGHT_DUPLICATE.test(f.path));
  return { files: files.filter((f) => !WEIGHT_DUPLICATE.test(f.path)), skipped };
}

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
  const all = entries
    .filter((e) => e && e.type === 'file' && typeof e.path === 'string' && !SKIP.some((s) => e.path === s || e.path.startsWith(s)))
    .map((e) => ({
      path: e.path,
      size: Number(e.size ?? e.lfs?.size ?? 0),
      sha256: typeof e.lfs?.oid === 'string' ? e.lfs.oid : null,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const { files, skipped } = pruneDuplicateFormats(all);
  return {
    files,
    skipped: skipped.map((f) => f.path),
    skippedBytes: skipped.reduce((sum, f) => sum + f.size, 0),
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
  };
}

/**
 * Eine Datei streamend nach R2 schreiben - ohne sie im Worker zu kopieren.
 *
 * Vorher lief hier ein eigener Multipart-Aufbau (Teile im JS zusammensetzen). Das kostet
 * je Byte eine Kopie und sprengte bei ~5-GB-Scherben das CPU-Budget (Cloudflare-Fehler 1102).
 * `put(key, stream)` uebergibt den Antwort-Stream direkt an R2 - der Worker kopiert nichts.
 * Den SHA-256 liefert HuggingFace je Datei (`lfs.oid`), es wird also nichts gehasht.
 */
async function putStreamed(res, key, env, file) {
  await env.R2_BUCKET.put(key, res.body, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  await env.R2_BUCKET.put(`${key}.sha256`, `${file.sha256}  ${file.path}\n`, {
    httpMetadata: { contentType: 'text/plain' },
  });
  return { key, parts: null, bytes: file.size, sha256: file.sha256 };
}

/** Eine Datei spiegeln; kleine Nicht-LFS-Dateien werden dabei im Worker gehasht. */
export async function mirrorFile(repo, rev, file, model, env) {
  const url = `${HF}/${repo}/resolve/${encodeURIComponent(rev)}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
  const key = `weights/${model}/${rev}/${file.path}`;
  const res = await fetch(url, { headers: hfHeaders(env) });
  if (!res.ok) throw new Error(`HF-Datei fehlgeschlagen: HTTP ${res.status} (${file.path})`);

  if (file.sha256) {
    // LFS-Datei: streamend nach R2, Hash kommt von HuggingFace.
    return putStreamed(res, key, env, file);
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

      // --- Direkt-URL-Modus (FLEET-P1-014) -------------------------------------
      // Gewichte ohne HuggingFace-Repo (z. B. beat_this final0.ckpt) lassen sich nicht
      // ueber die HF-API auflisten. Der Aufrufer nennt Quelle, R2-Schluessel und den
      // erwarteten SHA-256; der Worker streamt die Datei nach R2 (ohne sie in den
      // Speicher zu holen) und schreibt einen Manifest-Eintrag. Geprueft wird der Hash
      // beim Pod-Download - WebCrypto kann keinen schrittweisen Digest bilden.
      if (url.searchParams.has('direct')) {
        const source = url.searchParams.get('direct');
        const key = url.searchParams.get('key');
        const sha256 = url.searchParams.get('sha256') || '';
        const directModel = url.searchParams.get('model') || 'direct';
        if (!source || !key) return json({ ok: false, error: 'direct und key fehlen' }, 400);
        if (!/^weights\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(key) || key.includes('..'))
          return json({ ok: false, error: `unsicherer R2-Schluessel: ${key}` }, 400);
        let sourceUrl;
        try {
          sourceUrl = new URL(source);
        } catch {
          return json({ ok: false, error: 'direct ist keine gueltige URL' }, 400);
        }
        if (!['https:', 'http:'].includes(sourceUrl.protocol))
          return json({ ok: false, error: 'nur http(s)-Quellen erlaubt' }, 400);
        const upstream = await fetch(sourceUrl.toString(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; audiomonastry-weights-mirror)' },
          redirect: 'follow',
        });
        if (!upstream.ok) return json({ ok: false, error: `Quelle HTTP ${upstream.status}` }, 502);
        const size = Number(upstream.headers.get('content-length') || 0);
        const stored = await env.R2_BUCKET.put(key, upstream.body, {
          httpMetadata: { contentType: 'application/octet-stream' },
        });
        const entry = { path: key.split('/').slice(2).join('/'), key, size: stored ? stored.size : size, sha256 };
        await upsertManifest(directModel, 'direct', 'direct', entry, env);
        return json({
          ok: true,
          mode: 'direct',
          key,
          size: stored ? stored.size : size,
          sha256,
          hinweis: 'SHA-256 stammt vom Aufrufer und wird beim Pod-Download geprueft (pod_start.dest-Eintrag).',
        });
      }

      const repo = url.searchParams.get('repo');
      const rev = url.searchParams.get('rev') || 'main';
      const model = url.searchParams.get('model') || (repo ? repo.split('/').pop() : null);
      if (!repo || !model) return json({ ok: false, error: 'repo und model fehlen' }, 400);

      const { files, skipped, skippedBytes, totalBytes } = await listRepo(repo, rev, env);
      if (url.searchParams.has('list')) {
        return json({ ok: true, model, repo, revision: rev, files, totalBytes, skipped, skippedBytes });
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
