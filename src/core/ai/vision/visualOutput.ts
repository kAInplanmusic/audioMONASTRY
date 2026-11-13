/**
 * audioMONASTRY · Visual-Worker-Ausgabe auswerten
 * ===============================================
 * Providerunabhängige Parser für die Ausgabe der Bild-/Video-Worker
 * (ComfyUI auf dem Vast-`vis`-Pod, siehe comfyui_adapter.py). Herkunft: die
 * reinen Hilfsfunktionen der früheren runpodVision/runpodVideo-Module (bis
 * 285ef5c); Netzwerk und Rollenwahl liegen jetzt im ProviderRouter.
 */

/** Sucht rekursiv das erste Bild (data-URI oder URL) in der Worker-Ausgabe. */
export function extractVisionImage(output: unknown): string | null {
  if (typeof output === 'string') {
    if (output.startsWith('data:image')) return output;
    if (/^https?:\/\/.+\.(png|jpe?g|webp)(\?.*)?$/i.test(output)) return output;
    return null;
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = extractVisionImage(item);
      if (found) return found;
    }
    return null;
  }
  if (output && typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    // Bevorzugt die bekannten FLUX-Felder, dann rekursiv.
    for (const key of ['image_url', 'image', 'url', 'images', 'output']) {
      if (key in rec) {
        const found = extractVisionImage(rec[key]);
        if (found) return found;
      }
    }
    // worker-comfyui (ab 5.x): { filename, type: 'base64', data: '<rohes base64>' }.
    // Das rohe base64 traegt kein "data:"-Praefix und wuerde unten durchfallen —
    // ohne diese Zeilen liefert der neue Worker scheinbar "kein Bild".
    if (typeof rec.data === 'string' && rec.data) {
      if (rec.type === 's3') return rec.data;
      return rec.data.startsWith('data:') ? rec.data : `data:image/png;base64,${rec.data}`;
    }
    for (const value of Object.values(rec)) {
      const found = extractVisionImage(value);
      if (found) return found;
    }
  }
  return null;
}

/** Entfernt ein evtl. vorhandenes `data:…;base64,`-Praefix. */
export function stripDataUri(value: string): string {
  const s = String(value ?? '').trim();
  const comma = s.indexOf('base64,');
  return comma >= 0 ? s.slice(comma + 7).replace(/\s+/g, '') : s.replace(/\s+/g, '');
}

/** Zieht das Video (rohes base64 oder data-URI) aus der Worker-Ausgabe. */
export function extractVideo(output: unknown): string | null {
  if (typeof output === 'string') {
    if (output.startsWith('data:video')) return output;
    if (/^https?:\/\/.+\.(mp4|webm|mov)(\?.*)?$/i.test(output)) return output;
    if (output.length > 100) return output;
    return null;
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = extractVideo(item);
      if (found) return found;
    }
    return null;
  }
  if (output && typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    for (const key of ['video', 'video_base64', 'output', 'videos', 'url', 'video_url']) {
      if (key in rec) {
        const found = extractVideo(rec[key]);
        if (found) return found;
      }
    }
    for (const value of Object.values(rec)) {
      const found = extractVideo(value);
      if (found) return found;
    }
  }
  return null;
}
