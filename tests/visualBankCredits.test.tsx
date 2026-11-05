// @vitest-environment jsdom
/**
 * MEDIA-2026-11-04-005 — Namensnennung der in der Session gezeigten Bank-Clips.
 *
 * Die Lizenzdaten stehen vollstaendig in `importedBank.generated.ts`; die App
 * hat sie bisher nirgends angezeigt. Diese Tests halten fest:
 *  - Nachschlag ueber die tatsaechliche Show-`src` (auch Varianten und R2-URLs),
 *  - Zusammenfassen der Session-Szenen (Reihenfolge, Duplikate, Varianten),
 *  - Exporttext mit Autor, Lizenz, Quell-URL und Bearbeitungshinweis,
 *  - die Credits-Ansicht im Visualizer exportiert nur auf Klick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  bankClipKey,
  buildCreditsText,
  creditsFileName,
  lookupClipCredit,
  sessionCredits,
} from '../src/visuals/bankCredits';
import { CreditsPanel } from '../src/components/visual/CreditsPanel';

const M01A_SRC = '/api/ai/vision/bank/m01a';
const M01A_URL =
  'https://commons.wikimedia.org/wiki/File%3A2.8%20hours%20later%20-%20Zombie%20Apocalypse%20%2814128762940%29.jpg';

describe('bankCredits · Nachschlag in der generierten Bank', () => {
  it('findet Autor, Lizenz und Quell-URL ueber die Show-src', () => {
    const credit = lookupClipCredit(M01A_SRC);
    expect(credit).not.toBeNull();
    expect(credit?.id).toBe('m01a');
    expect(credit?.attribution).toBe('marsupium photography');
    expect(credit?.license).toBe('CC BY-SA 2.0');
    expect(credit?.sourceUrl).toBe(M01A_URL);
    expect(credit?.variants).toEqual([]);
  });

  it('erkennt Varianten als Bearbeitung des Originals', () => {
    const credit = lookupClipCredit('/api/ai/vision/bank/m01a_fast');
    expect(credit?.id).toBe('m01a');
    expect(credit?.variants).toEqual(['fast']);
    expect(lookupClipCredit('/api/ai/vision/bank/m01a_unbekannt')).toBeNull();
  });

  it('loest auch oeffentliche R2-URLs und Query-Strings auf', () => {
    expect(bankClipKey('https://pub-663ece9f219d4704b826b80715e82034.r2.dev/visuals/bank/m01a.mp4')).toBe('m01a');
    expect(bankClipKey('/api/ai/vision/bank/m01a?token=x#t=1')).toBe('m01a');
  });

  it('meldet fremde Quellen (Vorlagen, KI-Bilder) als ohne Fremdlizenz', () => {
    expect(lookupClipCredit('/api/ai/vision/bank/neon_stage')).toBeNull();
    expect(lookupClipCredit('data:image/png;base64,AAAA')).toBeNull();
  });
});

describe('bankCredits · Session-Zusammenfassung', () => {
  it('fuehrt Szenen in Anzeige-Reihenfolge zusammen und gruppiert Varianten', () => {
    const result = sessionCredits([
      '/api/ai/vision/bank/m01a',
      '/api/ai/vision/bank/m12d',
      '/api/ai/vision/bank/m01a_fast',
      '/api/ai/vision/bank/m01a',
      '/api/ai/vision/bank/m01a_grau',
    ]);
    expect(result.entries.map((e) => e.id)).toEqual(['m01a', 'm12d']);
    expect(result.entries[0].variants).toEqual(['fast', 'grau']);
    expect(result.uncredited).toBe(0);
  });

  it('zaehlt Szenen ohne Bank-Lizenz (eigene Vorlagen/KI) gesondert', () => {
    const result = sessionCredits([
      '/api/ai/vision/bank/neon_stage',
      'data:image/png;base64,AAAA',
      'data:image/png;base64,AAAA',
      M01A_SRC,
    ]);
    expect(result.entries.map((e) => e.id)).toEqual(['m01a']);
    expect(result.uncredited).toBe(2);
  });
});

describe('bankCredits · Textdatei', () => {
  it('nennt Autor, Lizenz, Quell-URL und ShareAlike-/Bearbeitungshinweis', () => {
    const { entries, uncredited } = sessionCredits([M01A_SRC, '/api/ai/vision/bank/m01a_fast']);
    const text = buildCreditsText(entries, {
      uncredited,
      generatedAt: new Date('2026-11-05T10:00:00Z'),
    });
    expect(text).toContain('VISUAL · NAMENSNENNUNG (Session)');
    expect(text).toContain('marsupium photography');
    expect(text).toContain('CC BY-SA 2.0');
    expect(text).toContain(M01A_URL);
    expect(text).toContain('ShareAlike');
    expect(text).toContain('Bearbeitung');
    expect(text).toContain('"fast"');
    expect(text).toContain('2026-11-05T10:00:00.000Z');
  });

  it('kennzeichnet CC0 als gemeinfrei und nennt die Quelle trotzdem', () => {
    const { entries } = sessionCredits(['/api/ai/vision/bank/m06e']);
    const text = buildCreditsText(entries);
    expect(text).toContain('CC0');
    expect(text).toContain('Gemeinfrei');
    expect(text).toContain('https://clevelandart.org/art/1990.144');
    // Ohne Autor in der Bank steht dort ehrlich "nicht angegeben".
    expect(text).toContain('Autor: nicht angegeben');
  });

  it('sagt bei leerer Session, dass keine fremdlizenzierten Clips gezeigt wurden', () => {
    const text = buildCreditsText([], { uncredited: 4 });
    expect(text).toContain('Keine fremdlizenzierten Clips');
    expect(text).toContain('4 Szenen ohne Fremdlizenz');
  });

  it('bildet den Dateinamen aus dem Datum', () => {
    expect(creditsFileName(new Date('2026-11-05T23:30:00Z'))).toBe('visual-credits-2026-11-05.txt');
  });
});

describe('CreditsPanel · Ansicht und Nutzer-Export', () => {
  const { entries, uncredited } = sessionCredits([M01A_SRC, '/api/ai/vision/bank/m01a_fast']);
  const now = () => new Date('2026-11-05T10:00:00Z');
  let createdParts: string[] = [];
  let downloadName = '';
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createdParts = [];
    downloadName = '';
    class FakeBlob {
      constructor(parts: BlobPart[]) {
        createdParts.push(parts.map((p) => String(p)).join(''));
      }
    }
    vi.stubGlobal('Blob', FakeBlob);
    const createObjectURL = vi.fn(() => 'blob:credits');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });
  });

  afterEach(() => {
    cleanup();
    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('zeigt die Liste erst auf Klick und nennt Autor, Lizenz und Quelle', () => {
    render(<CreditsPanel credits={entries} uncredited={uncredited} now={now} />);
    const toggle = screen.getByRole('button', { name: /CREDITS \(1\)/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Namensnennung' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('region', { name: 'Namensnennung' });
    expect(panel.textContent).toContain('Zombie 1');
    expect(panel.textContent).toContain('marsupium photography');
    expect(panel.textContent).toContain('CC BY-SA 2.0');
    const link = screen.getByRole('link', { name: M01A_URL });
    expect(link.getAttribute('href')).toBe(M01A_URL);
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('exportiert erst auf Klick eine Textdatei mit dem Session-Inhalt', () => {
    render(<CreditsPanel credits={entries} uncredited={uncredited} now={now} />);
    fireEvent.click(screen.getByRole('button', { name: /CREDITS \(1\)/ }));
    expect(clickSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /ALS TEXTDATEI EXPORTIEREN/ }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(downloadName).toBe('visual-credits-2026-11-05.txt');
    expect(createdParts).toHaveLength(1);
    expect(createdParts[0]).toContain('marsupium photography');
    expect(createdParts[0]).toContain(M01A_URL);
    expect(createdParts[0]).toContain('ShareAlike');
  });

  it('erklaert die leere Liste, ohne etwas zu speichern', () => {
    render(<CreditsPanel credits={[]} uncredited={3} now={now} />);
    fireEvent.click(screen.getByRole('button', { name: /CREDITS \(0\)/ }));
    const panel = screen.getByRole('region', { name: 'Namensnennung' });
    expect(panel.textContent).toContain('Keine fremdlizenzierten Clips');
    expect(panel.textContent).toContain('3 Szenen ohne Fremdlizenz');
    expect(panel.textContent).toContain('nichts wird gespeichert');
  });
});
