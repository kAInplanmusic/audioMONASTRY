/**
 * MEDIA-2026-11-04-005 — kleine Credits-Ansicht im Visualizer.
 *
 * Zeigt ausschliesslich die in dieser Session tatsaechlich gezeigten Clips
 * (Autor, Lizenz, Quell-URL, Varianten) und bietet einen ausdruecklichen
 * Export als Textdatei an. Kein localStorage, kein IndexedDB, kein Download
 * ohne Klick — die Daten leben nur im React-State der laufenden Session.
 */
import { saveTextToUserFile, type UserFileType } from '../../utils/userExport';
import React, { useId, useState } from 'react';
import { buildCreditsText, creditsFileName, type ClipCredit } from '../../visuals/bankCredits';

export interface CreditsPanelProps {
  credits: readonly ClipCredit[];
  /** Szenen ohne Bank-Lizenz (eigene Vorlagen/KI) — nur als Anzahl. */
  uncredited?: number;
  /** Zeitquelle des Exports; im Test fest setzbar. */
  now?: () => Date;
}

/**
 * Textdatei an den Nutzer geben — ueber den freigegebenen Weg
 * `utils/userExport.ts` (File System Access mit Download-Fallback). Der
 * Boundary-Scan erlaubt Datei-Dialoge und `a.download` ausschliesslich dort;
 * ein eigener Blob-Download hier war ein Verstoss (Befund 2026-11-05).
 * Nur der Klick loest das aus, es wird nichts auf dem Geraet gespeichert.
 */
export const CREDITS_FILE_TYPE: UserFileType = {
  description: 'Namensnennung (Textdatei)',
  accept: { 'text/plain': ['.txt'] },
};

export async function downloadCreditsText(text: string, fileName: string): Promise<boolean> {
  try {
    const result = await saveTextToUserFile(text, fileName, CREDITS_FILE_TYPE);
    return result !== 'cancelled';
  } catch {
    return false;
  }
}

export const CreditsPanel: React.FC<CreditsPanelProps> = ({ credits, uncredited = 0, now }) => {
  const [open, setOpen] = useState(false);
  const [exportError, setExportError] = useState('');
  const panelId = useId();

  const exportCredits = async () => {
    const generatedAt = (now ?? (() => new Date()))();
    const text = buildCreditsText(credits, { uncredited, generatedAt });
    const ok = await downloadCreditsText(text, creditsFileName(generatedAt));
    setExportError(ok ? '' : 'Datei-Export in diesem Browser nicht möglich.');
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        title="Namensnennung der in dieser Session gezeigten Clips (CC BY/BY-SA)"
        className={`px-2 py-1 rounded-full text-[9px] font-bold tracking-widest border transition-colors ${open ? 'border-amber-400/70 text-amber-200 bg-amber-400/10' : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}
      >
        CREDITS ({credits.length})
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Namensnennung"
          className="fixed right-3 top-12 z-40 w-[min(26rem,calc(100vw-1.5rem))] max-h-[60vh] overflow-auto rounded-lg border border-white/15 bg-neutral-950/95 p-2.5 shadow-2xl backdrop-blur"
        >
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <div className="text-[9px] font-bold tracking-widest text-amber-300">NAMENSNENNUNG · SESSION</div>
              <div className="mt-0.5 text-[9px] text-neutral-500">
                Nur tatsächlich gezeigte Clips; Daten aus der Visual-Bank.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Credits schließen"
              className="shrink-0 text-neutral-500 hover:text-neutral-200 transition-colors"
            >
              ×
            </button>
          </div>

          {credits.length === 0 ? (
            <p className="mt-2 text-[10px] text-neutral-400">
              Keine fremdlizenzierten Clips in dieser Session gezeigt.
            </p>
          ) : (
            <ol className="mt-2">
              {credits.map((credit) => (
                <li key={credit.id} className="border-t border-white/5 py-1.5 first:border-t-0 first:pt-0">
                  <div className="text-[10px] text-neutral-200">{credit.label}</div>
                  <div className="text-[9px] text-neutral-400">
                    Autor: {credit.attribution || 'nicht angegeben'} · Lizenz: {credit.license || 'keine Angabe'}
                  </div>
                  {credit.variants.length > 0 && (
                    <div className="text-[9px] text-amber-300/90">
                      Bearbeitung: Variante {credit.variants.map((v) => `"${v}"`).join(', ')}
                      {' '}– Änderungen gegenüber dem Original.
                    </div>
                  )}
                  {credit.sourceUrl && (
                    <a
                      href={credit.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 block break-all text-[9px] text-cyan-300 underline"
                    >
                      {credit.sourceUrl}
                    </a>
                  )}
                </li>
              ))}
            </ol>
          )}

          {uncredited > 0 && (
            <p className="mt-1.5 text-[9px] text-neutral-500">
              {uncredited} {uncredited === 1 ? 'Szene' : 'Szenen'} ohne Fremdlizenz (eigene Vorlagen oder KI-Generierungen).
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2">
            <button
              type="button"
              onClick={exportCredits}
              className="px-2.5 py-1.5 rounded-full text-[10px] font-bold tracking-widest border border-amber-400/60 text-amber-200 hover:bg-amber-400/10 transition-colors"
            >
              ALS TEXTDATEI EXPORTIEREN
            </button>
            <span className="text-[9px] text-neutral-500">Export nur auf Klick – nichts wird gespeichert.</span>
          </div>
          {exportError && <p className="mt-1 text-[9px] text-red-400">{exportError}</p>}
        </div>
      )}
    </div>
  );
};
