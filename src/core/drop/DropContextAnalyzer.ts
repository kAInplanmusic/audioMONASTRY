/**
 * dropMONK – Drop Context Analyzer
 * ================================
 * Analysiert aktuellen Mix-State und wählt beste Drop-Profile
 */

import type { DropProfile, DropCategory } from './types/DropProfile';
import {
  DROP_PROFILES,
  getDropProfilesByCategory,
  getDropProfilesForPlugins,
  getDropProfilesByIntensity,
} from './types/DropProfile';

export interface MixerChannel {
  id: string;
  level: number; // 0..1
  isMuted: boolean;
  isPanned?: number; // -1..1
  isSoloed?: boolean;
}

export interface AudioContext {
  bpm: number;
  key?: string;
  activePlugins: string[]; // z.B. ['synth', 'reverb', 'drum']
  mixerChannels: MixerChannel[];
  currentEnergy: number; // 0..1 (basierend auf Levels + Frequencies)
  timeSignature: '4/4' | '3/4' | '6/8' | '5/4' | string;
  analysisTimestamp: number; // when analyzed
}

export interface SuggestionScoring {
  profile: DropProfile;
  score: number; // 0..1
  reasons: string[];
}

/**
 * Drop Context Analyzer
 * Analysiert den aktuellen Mix-State und schlägt beste Drop-Profile vor
 */
export class DropContextAnalyzer {
  private lastContext: AudioContext | null = null;

  /**
   * Analysiere aktuellen Mix-State
   * (Wird von anderen Services mit aktuellen Daten gefüttert)
   */
  analyzeCurrentMix(
    bpm: number,
    activePluginIds: string[],
    mixerChannels: MixerChannel[],
    currentEnergy?: number,
    key?: string,
    timeSignature: string = '4/4'
  ): AudioContext {
    const energy = currentEnergy ?? this.calculateEnergyFromChannels(mixerChannels);

    const context: AudioContext = {
      bpm,
      key,
      activePlugins: activePluginIds,
      mixerChannels,
      currentEnergy: energy,
      timeSignature,
      analysisTimestamp: Date.now(),
    };

    this.lastContext = context;
    return context;
  }

  /**
   * Kalkuliere Energy-Level aus Mixer-Channels
   * (0=silence, 1=max energy)
   */
  private calculateEnergyFromChannels(channels: MixerChannel[]): number {
    if (channels.length === 0) return 0;

    const activeChannels = channels.filter((ch) => !ch.isMuted);
    if (activeChannels.length === 0) return 0;

    const avgLevel = activeChannels.reduce((sum, ch) => sum + ch.level, 0) / activeChannels.length;
    return Math.min(1, avgLevel);
  }

  /**
   * Wähle beste Drop-Profile für aktuellen Context
   * Gibt Top-N Vorschläge mit Begründung
   */
  suggestDropProfiles(context: AudioContext, limit: number = 5): SuggestionScoring[] {
    const scored: SuggestionScoring[] = [];

    // Bewerte alle verfügbaren Profile
    for (const profile of DROP_PROFILES) {
      const score = this.scoreProfile(profile, context);
      const reasons = this.scoringReasons(profile, context, score);

      scored.push({ profile, score, reasons });
    }

    // Sortiere nach Score (descending)
    scored.sort((a, b) => b.score - a.score);

    // Gebe Top-N
    return scored.slice(0, limit);
  }

  /**
   * Berechne Score (0..1) für ein Profile relativ zu Context
   */
  private scoreProfile(profile: DropProfile, context: AudioContext): number {
    let score = 0.5; // Base score

    // 1. Plugin-Kompatibilität (wichtig!)
    if (profile.targetPlugins && profile.targetPlugins.length > 0) {
      const matchCount = profile.targetPlugins.filter((pid) => context.activePlugins.includes(pid))
        .length;
      const pluginScore = matchCount / profile.targetPlugins.length;
      score += pluginScore * 0.3; // +30% wenn Plugins matched
    } else {
      score += 0.15; // Generic profiles bekommen leicht Bonus
    }

    // 2. Energy-Matching
    const profileIntensity = profile.intensity ?? 0.5;
    const energyDiff = Math.abs(profileIntensity - context.currentEnergy);
    const energyScore = 1 - Math.min(1, energyDiff);
    score += energyScore * 0.25; // +25% für Energy-Match

    // 3. BPM-Affinität (bestimmte Profiles besser für bestimmte Tempi)
    const bpmScore = this.scoreBpmAffinity(profile, context.bpm);
    score += bpmScore * 0.2; // +20% für BPM-Fit

    // 4. Key-Kompatibilität (wenn vorhanden)
    if (context.key && profile.tags?.includes(context.key)) {
      score += 0.1; // +10% für Key-Affinität
    }

    // Clamp zu 0..1
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Berechne BPM-Affinität
   * Bestimmte Drops passen besser zu bestimmten Tempi
   */
  private scoreBpmAffinity(profile: DropProfile, bpm: number): number {
    // Empirische Regeln
    if (profile.id.includes('ambient') && bpm < 100) return 1.0; // Ambient @ Slow
    if (profile.id.includes('techno') && bpm >= 120) return 1.0; // Techno @ Fast
    if (profile.id.includes('energy') && bpm >= 110) return 0.9;
    if (profile.id.includes('dj_transition') && (bpm >= 100 && bpm <= 140)) return 0.95;

    // Generischer Score basierend auf Bereich
    if (bpm < 90) return 0.3; // Sehr langsam
    if (bpm < 110) return 0.6; // Langsam
    if (bpm < 130) return 0.8; // Moderat
    if (bpm < 150) return 0.9; // Schnell
    return 0.7; // Sehr schnell
  }

  /**
   * Generiere Human-Readable Gründe für Scoring
   */
  private scoringReasons(profile: DropProfile, context: AudioContext, score: number): string[] {
    const reasons: string[] = [];

    if (score < 0.3) {
      reasons.push('Low compatibility with current mix');
    } else if (score >= 0.8) {
      reasons.push('Excellent match');
    }

    // Plugin-Gründe
    if (profile.targetPlugins && profile.targetPlugins.length > 0) {
      const matches = profile.targetPlugins.filter((p) => context.activePlugins.includes(p));
      if (matches.length === profile.targetPlugins.length) {
        reasons.push(`All target plugins active: ${matches.join(', ')}`);
      } else if (matches.length > 0) {
        reasons.push(`Partial plugin match: ${matches.join(', ')}`);
      }
    }

    // Energy-Grund
    const profileIntensity = profile.intensity ?? 0.5;
    if (profileIntensity >= 0.8 && context.currentEnergy >= 0.7) {
      reasons.push('High-energy profile for high-energy mix');
    } else if (profileIntensity <= 0.4 && context.currentEnergy <= 0.5) {
      reasons.push('Subtle profile for calm mix');
    }

    return reasons;
  }

  /**
   * Finde Profile für bestimmte Kategorie
   */
  getProfilesByCategory(category: DropCategory): DropProfile[] {
    return getDropProfilesByCategory(category);
  }

  /**
   * Finde Profile mit bestimmter Intensität
   */
  getProfilesByIntensity(min: number, max: number): DropProfile[] {
    return getDropProfilesByIntensity(min, max);
  }

  /**
   * Gebe zuletzt analysierten Context
   */
  getLastContext(): AudioContext | null {
    return this.lastContext;
  }

  /**
   * Finde Profile für Crossover/Transition zwischen zwei States
   */
  suggestTransitionProfiles(
    fromEnergy: number,
    toEnergy: number,
    context: AudioContext
  ): SuggestionScoring[] {
    // Bevorzuge Transition- und Breakdown-Profile
    const candidates = [
      ...getDropProfilesByCategory('transition'),
      ...getDropProfilesByCategory('breakdown'),
    ];

    const scored = candidates
      .map((profile) => {
        let score = 0.5;

        // Transitive Profile = nächster zu Breakdown
        if (profile.category === 'transition') score += 0.3;

        // Energy-Progression
        const energyRange = Math.abs(toEnergy - fromEnergy);
        if (energyRange > 0.3) score += 0.2; // Großer Jump

        return {
          profile,
          score,
          reasons: [`Suitable for transition from ${fromEnergy} to ${toEnergy}`],
        };
      })
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, 3);
  }
}

// Export singleton instance
export const dropContextAnalyzer = new DropContextAnalyzer();
