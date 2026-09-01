// ============================================================================
// NEW-D1-3: AI-Modus-Flag
// ----------------------------------------------------------------------------
// Der "AI-Modus" ist aktiv, solange das aiMONK-Modul nicht OFF ist
// (AUTO_AI oder PRO). In diesem Modus darf der mixerMONK-Halter wechseln
// (Lock-Takeover). Außerhalb des AI-Modus gilt der normale Lock-Schutz.
// ============================================================================

let aiModeActive = false;

export function setAiModeActive(active: boolean): void {
  aiModeActive = active;
}

export function isAiModeActive(): boolean {
  return aiModeActive;
}
