/**
 * VP-P1-001 · Prompt-Katalog des VisualMONK (Nachschub-Pfad)
 * ==========================================================
 * Der Katalog ist die Quelle für die generativen Aufrufe: `motiv` geht als
 * Startbild-Prompt an FLUX (`/api/ai/vision`), `motion` als Bewegungs-Kern an
 * Wan 2.2 (`/api/ai/vision/video`). Beide Felder müssen zusammenpassen — sonst
 * bewegt sich ein Bild anders, als es aussieht.
 *
 * Ohne diesen Wächter fällt ein fehlender Eintrag erst im laufenden Set auf, und
 * der Generierungs-Aufruf geht mit leerem Prompt raus (`if (!prompt) return`).
 */
import { describe, expect, it } from 'vitest';
import {
  PROMPT_KATALOG,
  TEXTZEILEN_TRIGGER,
  promptByTitel,
  promptForSet,
} from '../src/visuals/prompts';

describe('VP-P1-001 · Prompt-Katalog', () => {
  it('hält 63 Einträge, je 21 pro Stimmung', () => {
    expect(PROMPT_KATALOG.length).toBe(63);
    for (const mood of ['duester', 'cool', 'lustig'] as const) {
      expect(PROMPT_KATALOG.filter((p) => p.mood === mood).length).toBe(21);
    }
  });

  it('hat eindeutige Titel und vollständige Felder', () => {
    const titel = PROMPT_KATALOG.map((p) => p.titel);
    expect(new Set(titel).size).toBe(titel.length);

    for (const p of PROMPT_KATALOG) {
      // Kurze Prompts erzeugen Platzhalter-Bilder; die Regel aus
      // docs/VISUALVORLAGEN.md verlangt EINEN starken Bewegungs-Kern.
      expect(p.motiv.trim().length).toBeGreaterThan(10);
      expect(p.motion.trim().length).toBeGreaterThan(10);
      expect(p.tags.length).toBeGreaterThan(0);
      expect(['ruhig', 'mittel', 'hart']).toContain(p.energie);
    }
  });

  it('findet einen Titel und fällt sonst auf den ersten zurück', () => {
    expect(promptByTitel('Neon Altar').mood).toBe('duester');
    expect(promptByTitel('diesen Titel gibt es nicht')).toBe(PROMPT_KATALOG[0]);
  });

  it('wählt passend zur Bewegungsenergie und ist deterministisch', () => {
    const a = promptForSet({ energie: 'hart', seed: 3 });
    const b = promptForSet({ energie: 'hart', seed: 3 });
    expect(a).toBe(b);
    expect(a.energie).toBe('hart');
  });

  it('bleibt bei einer Kombination ohne Treffer beim ganzen Katalog', () => {
    // 'neutral' kommt im Katalog nicht vor: kein Treffer, aber ein Eintrag —
    // ein leeres Ergebnis würde den Aufrufer ohne Prompt zurücklassen.
    expect(promptForSet({ mood: 'neutral' })).toBe(PROMPT_KATALOG[0]);
    expect(promptForSet({ energie: 'hart', mood: 'neutral' }).energie).toBe('hart');
  });

  it('liefert Textzeilen für die Textschicht (L4)', () => {
    expect(TEXTZEILEN_TRIGGER.length).toBeGreaterThan(0);
    for (const zeile of TEXTZEILEN_TRIGGER) {
      expect(zeile).toBe(zeile.toUpperCase());
      expect(zeile.trim().length).toBeGreaterThan(2);
    }
  });
});
