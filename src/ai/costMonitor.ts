/**
 * audioMONASTRY · 4.2.4 – Kosten- und Ressourcen-Monitoring für KI
 * ================================================================
 * Zählt Inferenzen/Tokens, setzt Budget-Limits und warnt bei Überschreitung.
 */
export interface CostSnapshot {
  inferences: number;
  tokens: number;
  budget: number;
  /** 0..1 Anteil des verbrauchten Budgets. */
  usage: number;
  warnings: string[];
}

export class CostMonitor {
  private inferences = 0;
  private tokens = 0;
  private budget = 1_000_000;
  private warnings: string[] = [];
  private onWarning: (msg: string) => void = () => {};

  setBudget(tokens: number): void {
    this.budget = Math.max(1, tokens);
  }

  setWarningHandler(cb: (msg: string) => void): void {
    this.onWarning = cb;
  }

  record(inferences = 1, tokens = 0): void {
    this.inferences += Math.max(0, inferences);
    this.tokens += Math.max(0, tokens);
    if (this.tokens > this.budget * 0.8 && !this.warnings.includes('80%')) {
      this.warnings.push('80%');
      this.onWarning('KI-Budget zu 80% verbraucht');
    }
    if (this.tokens >= this.budget && !this.warnings.includes('100%')) {
      this.warnings.push('100%');
      this.onWarning('KI-Budget vollständig verbraucht');
    }
  }

  snapshot(): CostSnapshot {
    return {
      inferences: this.inferences,
      tokens: this.tokens,
      budget: this.budget,
      usage: Math.min(1, this.tokens / this.budget),
      warnings: [...this.warnings],
    };
  }

  reset(): void {
    this.inferences = 0;
    this.tokens = 0;
    this.warnings = [];
  }
}

export const costMonitor = new CostMonitor();
