/**
 * dropMONK – AI Drop Generator
 * ===========================
 * KI-gestützte Drop-Generierung via DeepSeek/HF
 */

import type { AudioContext } from './DropContextAnalyzer';
import type { DropProfile, GeneratedDropProfile, ParameterTransformation } from './types/DropProfile';
import { DROP_PROFILES } from './types/DropProfile';

export interface AiDropRequest {
  context: AudioContext;
  userPrompt: string; // z.B. "Techno Transition mit Bass-Drop"
  targetPlugins?: string[];
  style?: 'subtle' | 'moderate' | 'extreme';
  duration?: number; // in ms
  historyProfiles?: DropProfile[]; // vorherige Drops (für Kontrast)
}

/**
 * AI Drop Generator
 * Nutzt DeepSeek/HF für intelligente Drop-Generierung
 */
export class AiDropGenerator {
  private apiEndpoint: string = '/api/ai/generate-drop'; // Server-seitig
  private cacheMap: Map<string, GeneratedDropProfile> = new Map();
  private requestQueue: Promise<any> = Promise.resolve();

  /**
   * Generiere einen Custom Drop via KI
   * Kann lokal oder via Server-API arbeiten
   */
  async generateDropProfile(request: AiDropRequest): Promise<GeneratedDropProfile> {
    // Input-Validierung
    if (!request.userPrompt || request.userPrompt.trim().length === 0) {
      throw new Error('User prompt required for AI generation');
    }

    // Cache-Check (Hash des Prompts)
    const cacheKey = this.generateCacheKey(request);
    const cached = this.cacheMap.get(cacheKey);
    if (cached) return cached;

    // Queue den Request (serialisiert AI-Calls)
    this.requestQueue = this.requestQueue.then(() =>
      this.invokeAiService(request, cacheKey)
    );

    return this.requestQueue;
  }

  /**
   * Invoke AI Service (Server-seitig)
   * POST zu /api/ai/generate-drop mit Context + Prompt
   */
  private async invokeAiService(
    request: AiDropRequest,
    cacheKey: string
  ): Promise<GeneratedDropProfile> {
    const payload = {
      userPrompt: request.userPrompt,
      context: {
        bpm: request.context.bpm,
        key: request.context.key,
        activePlugins: request.context.activePlugins,
        currentEnergy: request.context.currentEnergy,
      },
      targetPlugins: request.targetPlugins || request.context.activePlugins.slice(0, 3),
      style: request.style || 'moderate',
      duration: request.duration || 4000,
      recentProfiles: request.historyProfiles
        ? request.historyProfiles.map((p) => ({ id: p.id, name: p.name }))
        : undefined,
    };

    try {
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`AI service error: ${response.statusText}`);
      }

      const data = await response.json();
      const generated = this.parseAiResponse(data, request);

      // Cache speichern
      this.cacheMap.set(cacheKey, generated);

      return generated;
    } catch (err) {
      console.error('AI generation failed:', err);
      // Fallback: returne ähnlichstes bestehendes Profile
      return this.generateFallbackDrop(request);
    }
  }

  /**
   * Parse AI Service Response zu DropProfile
   */
  private parseAiResponse(
    data: Record<string, any>,
    request: AiDropRequest
  ): GeneratedDropProfile {
    // Erwarte strukturierten JSON response mit parameterSequence
    if (!data.parameterSequence || !Array.isArray(data.parameterSequence)) {
      throw new Error('Invalid AI response format');
    }

    // Validiere Parameter-Ranges
    const validatedSequence = this.validateParameterSequence(data.parameterSequence);

    const generated: GeneratedDropProfile = {
      id: `ai_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      name: data.name || `AI ${request.style} Drop`,
      description: data.description || request.userPrompt,
      category: data.category || 'custom',
      parameterSequence: validatedSequence,
      buildupTime: data.buildupTime || 3000,
      dropDuration: data.dropDuration || request.duration || 3000,
      quantization: data.quantization || '4bar',
      tags: [...(data.tags || []), 'ai-generated'],
      intensity: data.intensity || this.inferIntensity(request.style),
      targetPlugins: data.targetPlugins || request.targetPlugins,
      generatedAt: Date.now(),
      aiModel: 'deepseek', // oder huggingface, wird vom Server gemeldet
      confidence: data.confidence || 0.75,
      userPrompt: request.userPrompt,
    };

    return generated;
  }

  /**
   * Validiere Parameter-Ranges (0..1 normalisiert)
   */
  private validateParameterSequence(seq: ParameterTransformation[]): ParameterTransformation[] {
    return seq.map((param) => ({
      ...param,
      startValue: Math.max(0, Math.min(1, param.startValue)),
      endValue: Math.max(0, Math.min(1, param.endValue)),
      duration: Math.max(100, param.duration),
      delay: Math.max(0, param.delay || 0),
    }));
  }

  /**
   * Infer Intensität aus Style
   */
  private inferIntensity(style?: string): number {
    switch (style) {
      case 'subtle':
        return 0.3;
      case 'extreme':
        return 0.95;
      default:
        return 0.65;
    }
  }

  /**
   * Fallback: Wähle ähnlichstes Profile + leichte Variation
   */
  private generateFallbackDrop(request: AiDropRequest): GeneratedDropProfile {
    // Versuche bestehendes Profile zu finden, das zum Prompt passt
    const baseProfile =
      DROP_PROFILES.find((p) =>
        request.userPrompt.toLowerCase().includes(p.name.toLowerCase())
      ) || DROP_PROFILES[Math.floor(Math.random() * DROP_PROFILES.length)];

    // Klone und füge variation hinzu
    const fallback: GeneratedDropProfile = {
      ...baseProfile,
      id: `fallback_${Date.now()}`,
      name: `${baseProfile.name} (AI interpretation)`,
      generatedAt: Date.now(),
      aiModel: 'local',
      confidence: 0.4,
      userPrompt: request.userPrompt,
      tags: [...(baseProfile.tags || []), 'fallback'],
    };

    return fallback;
  }

  /**
   * Vorschlag für nächsten Drop basierend auf Historie
   * (Vermeidung von Repetition)
   */
  async suggestNextDrop(
    context: AudioContext,
    history: DropProfile[]
  ): Promise<GeneratedDropProfile | null> {
    if (history.length === 0) {
      // Keine Historie: generiere beliebigen
      return this.generateDropProfile({
        context,
        userPrompt: 'Create an interesting drop that contrasts with the current energy',
      });
    }

    // Generiere Kontrast zur letzten Drop
    const lastDrop = history[history.length - 1];
    const energyDiff = 1 - (lastDrop.intensity ?? 0.5);

    const contrastPrompt =
      energyDiff > 0.3
        ? 'Create a high-energy drop'
        : 'Create a subtle, spacious drop with good contrast';

    try {
      return await this.generateDropProfile({
        context,
        userPrompt: contrastPrompt,
        historyProfiles: history.slice(-3), // Letzten 3 Drops für Context
        style: energyDiff > 0.3 ? 'extreme' : 'subtle',
      });
    } catch {
      return null;
    }
  }

  /**
   * Cache-Key Generator
   */
  private generateCacheKey(request: AiDropRequest): string {
    const key = `${request.userPrompt}_${request.context.bpm}_${request.style}`;
    return key.replace(/\s+/g, '_').toLowerCase();
  }

  /**
   * Clear Cache
   */
  clearCache(): void {
    this.cacheMap.clear();
  }

  /**
   * Get Cache Stats
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cacheMap.size,
      keys: Array.from(this.cacheMap.keys()),
    };
  }
}

// Export singleton
export const aiDropGenerator = new AiDropGenerator();
