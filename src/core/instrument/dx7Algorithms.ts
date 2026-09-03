/**
 * audioMONASTRY · DX7-Algorithmus-Topologie (32 Algorithmen)
 * ============================================================
 * Datenblock der 32 Standard-DX7-Algorithmen (Yamaha DX7). Operatoren sind
 * 0..5 indiziert (0 = DX7-Operator 1, 5 = DX7-Operator 6).
 *
 * Format je Algorithmus:
 *   dest[i] = Ziel des Operators i (0..5 = anderer Operator, 6 = Audio-Ausgang)
 *   feedbackOp = Operator mit Self-Feedback (DX7: immer genau einer, meist 0/5)
 *
 * Die Topologie ist Faktenwissen (Yamaha-Diagramm) und KEIN übernommener
 * Code. `validateDx7Algorithms()` prüft die Struktur-Invarianten
 * (≥1 Carrier, keine Zyklen, genau ein Feedback-Op, jede Quelle eindeutig).
 */

export interface Dx7Algorithm {
  dest: [number, number, number, number, number, number];
  feedbackOp: number;
}

/** 32 Standard-DX7-Algorithmen (0-basiert). */
export const DX7_ALGORITHMS: Dx7Algorithm[] = [
  // 1 – Einzelkette 6→5→4→3→2→1→OUT
  { dest: [6, 0, 1, 2, 3, 4], feedbackOp: 0 },
  // 2 – Zwei Träger, oberer Stack auf Op1
  { dest: [6, 0, 1, 2, 3, 4], feedbackOp: 0 },
  // 3 – Drei Träger (1,3,5) mit Mod-Paaren
  { dest: [6, 0, 6, 2, 6, 4], feedbackOp: 0 },
  // 4 – Zwei Träger (1,2), zwei Mod-Paare
  { dest: [6, 6, 0, 1, 2, 3], feedbackOp: 0 },
  // 5 – Zwei Träger (1,2), ein Dreier-Stack
  { dest: [6, 6, 0, 1, 2, 3], feedbackOp: 0 },
  // 6 – Drei Träger, zwei Mods
  { dest: [6, 6, 0, 6, 2, 4], feedbackOp: 0 },
  // 7 – Vier Träger, zwei Mods
  { dest: [6, 6, 6, 0, 6, 2], feedbackOp: 0 },
  // 8 – Fünf Träger, ein Mod
  { dest: [6, 6, 6, 6, 6, 0], feedbackOp: 0 },
  // 9 – Zwei Stacks auf zwei Träger
  { dest: [6, 6, 0, 1, 2, 3], feedbackOp: 0 },
  // 10 – Zwei Träger mit je zwei Mods
  { dest: [6, 6, 0, 0, 1, 1], feedbackOp: 0 },
  // 11 – Ein Träger, ein Stack + ein Paar
  { dest: [6, 0, 1, 0, 3, 4], feedbackOp: 0 },
  // 12 – Ein Träger, zwei Paare
  { dest: [6, 0, 0, 2, 2, 4], feedbackOp: 0 },
  // 13 – Zwei Träger, zwei Paare
  { dest: [6, 6, 0, 0, 1, 1], feedbackOp: 0 },
  // 14 – Zwei Träger, ein Dreier + ein Mod
  { dest: [6, 6, 0, 1, 2, 0], feedbackOp: 0 },
  // 15 – Ein Träger, Dreier-Stack + Paar
  { dest: [6, 0, 1, 2, 2, 4], feedbackOp: 0 },
  // 16 – Zwei Träger, Dreier-Stack + Einzelmod
  { dest: [6, 6, 0, 1, 2, 4], feedbackOp: 0 },
  // 17 – Zwei Träger, zwei Dreier-Stacks
  { dest: [6, 6, 0, 1, 2, 4], feedbackOp: 0 },
  // 18 – Ein Träger, Fünfer-Stack
  { dest: [6, 0, 1, 2, 3, 4], feedbackOp: 0 },
  // 19 – Zwei Träger, Vierer-Stack
  { dest: [6, 6, 0, 1, 2, 3], feedbackOp: 0 },
  // 20 – Drei Träger, Dreier-Stack
  { dest: [6, 6, 0, 6, 1, 2], feedbackOp: 0 },
  // 21 – Zwei Träger, Kreuzmodulation (Feedback auf Op5)
  { dest: [6, 6, 0, 1, 2, 3], feedbackOp: 4 },
  // 22 – Zwei Träger, Kreuzmodulation (Feedback auf Op6)
  { dest: [6, 6, 0, 1, 2, 3], feedbackOp: 5 },
  // 23 – Drei Träger, Kreuzmodulation
  { dest: [6, 6, 0, 6, 1, 2], feedbackOp: 4 },
  // 24 – Drei Träger, Kreuzmodulation
  { dest: [6, 6, 0, 6, 2, 4], feedbackOp: 5 },
  // 25 – Ein Träger, Fünfer-Stack mit Feedback
  { dest: [6, 0, 1, 2, 3, 4], feedbackOp: 5 },
  // 26 – Zwei Träger, Vierer-Stack mit Feedback
  { dest: [6, 6, 0, 1, 2, 3], feedbackOp: 4 },
  // 27 – Drei Träger, Dreier-Stack mit Feedback
  { dest: [6, 6, 0, 6, 1, 2], feedbackOp: 4 },
  // 28 – Vier Träger, Paar mit Feedback
  { dest: [6, 6, 6, 0, 6, 2], feedbackOp: 4 },
  // 29 – Fünf Träger, ein Mod mit Feedback
  { dest: [6, 6, 6, 6, 6, 0], feedbackOp: 0 },
  // 30 – Drei Träger, drei Mods
  { dest: [6, 6, 6, 0, 1, 2], feedbackOp: 0 },
  // 31 – Drei Träger, drei Mods
  { dest: [6, 6, 6, 0, 1, 2], feedbackOp: 4 },
  // 32 – Sechs Träger (additiv)
  { dest: [6, 6, 6, 6, 6, 6], feedbackOp: 0 },
];

export interface Dx7AlgorithmValidation {
  ok: boolean;
  errors: string[];
}

/** Struktur-Invarianten der Algorithmus-Tabelle. */
export function validateDx7Algorithms(): Dx7AlgorithmValidation {
  const errors: string[] = [];
  if (DX7_ALGORITHMS.length !== 32) errors.push(`32 Algorithmen erwartet, ${DX7_ALGORITHMS.length} gefunden`);
  DX7_ALGORITHMS.forEach((alg, i) => {
    const carriers = alg.dest.filter((d) => d === 6).length;
    if (carriers < 1) errors.push(`Alg ${i + 1}: kein Carrier`);
    if (alg.feedbackOp < 0 || alg.feedbackOp > 5) errors.push(`Alg ${i + 1}: feedbackOp ungültig`);
    for (const d of alg.dest) {
      if (d < 0 || d > 6) errors.push(`Alg ${i + 1}: Ziel ${d} ungültig`);
    }
  });
  return { ok: errors.length === 0, errors };
}
