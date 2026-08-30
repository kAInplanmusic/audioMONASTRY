/**
 * Liefert die Vite-kompatible Worker-URL für den Compute-Worker.
 * Vite transformiert `new URL('...', import.meta.url)` zur realen Asset-URL.
 */
export const computeWorkerUrl: string | URL = new URL('./computeWorker.ts', import.meta.url);
