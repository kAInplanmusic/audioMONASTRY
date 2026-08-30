import type { VoiceIntent } from './SpeechToIntent';

/**
 * audioMONASTRY · Phase 4 – AI Automation Agent
 * =============================================
 * Generiert aus Sprachbefehlen Automation-Curves für Parameter.
 */

export interface AutomationCurve {
  parameterId: string;
  points: { time: number; value: number }[];
}

export interface AutomationPlan {
  intent: VoiceIntent;
  curves: AutomationCurve[];
  appliedAt: number;
}

export class AutomationAgent {
  /** Wandelt einen Intent in eine Automation-Curve um. */
  plan(intent: VoiceIntent, now = 0): AutomationPlan {
    const curves: AutomationCurve[] = [];

    if (intent.action === 'set_tempo' && typeof intent.parameters.bpm === 'number') {
      const bpm = Math.min(300, Math.max(30, intent.parameters.bpm));
      curves.push({
        parameterId: 'transport.bpm',
        points: [
          { time: now, value: bpm },
          { time: now + 0.25, value: bpm },
        ],
      });
    }

    if (intent.action === 'automate') {
      curves.push({
        parameterId: 'fx.cutoff',
        points: [
          { time: now, value: 800 },
          { time: now + 0.5, value: 4200 },
          { time: now + 1.0, value: 800 },
        ],
      });
    }

    return { intent, curves, appliedAt: now };
  }
}
