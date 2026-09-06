/**
 * dropMONK – AI Server Integration Bridge
 * ======================================
 * Connect to DeepSeek/HF Inference API for drop generation
 */

import type { GeneratedDropProfile } from '../drop';

/**
 * AI Request/Response Types
 */
export interface AiGenerationRequest {
  bpm: number;
  activePlugins: string[];
  currentEnergy: number;
  userPrompt: string;
  style?: 'subtle' | 'moderate' | 'extreme';
}

export interface AiGenerationResponse {
  name: string;
  description: string;
  parameterSequence: Array<{
    pluginId: string;
    parameterId: string;
    startValue: number;
    endValue: number;
    duration: number;
    curve: 'linear' | 'exponential' | 'logarithmic' | 's-curve' | 'stepped';
  }>;
  confidence: number;
  buildupTime: number;
  dropDuration: number;
}

/**
 * AI Server Integration Bridge
 * Manages API communication with AI service
 */
export class AiServerBridge {
  private apiBaseUrl: string;
  private apiKey?: string;
  private requestQueue: Promise<any> = Promise.resolve();

  constructor(apiBaseUrl: string = '/api', apiKey?: string) {
    this.apiBaseUrl = apiBaseUrl;
    this.apiKey = apiKey;
  }

  /**
   * Generate drop profile via AI
   */
  async generateDropProfile(request: AiGenerationRequest): Promise<GeneratedDropProfile> {
    return new Promise((resolve, reject) => {
      // Serialize request to avoid parallel calls
      this.requestQueue = this.requestQueue
        .then(() => this._invokeAi(request))
        .then((response) => {
          const profile: GeneratedDropProfile = {
            id: `ai_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            name: response.name,
            description: response.description,
            category: 'transition',
            parameterSequence: response.parameterSequence,
            buildupTime: response.buildupTime,
            dropDuration: response.dropDuration,
            quantization: '4bar',
            generatedAt: Date.now(),
            aiModel: 'deepseek',
            confidence: response.confidence,
            tags: ['ai-generated', request.style || 'moderate'],
          };

          resolve(profile);
        })
        .catch(reject);
    });
  }

  /**
   * Internal AI invocation
   */
  private async _invokeAi(request: AiGenerationRequest): Promise<AiGenerationResponse> {
    const payload = {
      context: {
        bpm: request.bpm,
        activePlugins: request.activePlugins,
        currentEnergy: request.currentEnergy,
      },
      prompt: this._buildPrompt(request),
      style: request.style || 'moderate',
    };

    try {
      const response = await fetch(`${this.apiBaseUrl}/ai/generate-drop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { Authorization: this.apiKey }),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
      }

      const data = (await response.json()) as AiGenerationResponse;
      return data;
    } catch (err) {
      console.error('AI API call failed:', err);
      throw err;
    }
  }

  /**
   * Build prompt for LLM
   */
  private _buildPrompt(request: AiGenerationRequest): string {
    const pluginList = request.activePlugins.join(', ') || 'synthesizer, reverb, effects';
    const energyLevel = request.currentEnergy > 0.7 ? 'high' : request.currentEnergy > 0.4 ? 'medium' : 'low';

    return `
Generate a drop profile for a music production tool with the following constraints:

**Musical Context:**
- BPM: ${request.bpm}
- Current Energy Level: ${energyLevel} (${(request.currentEnergy * 100).toFixed(0)}%)
- Active Plugins: ${pluginList}
- User Request: "${request.userPrompt}"
- Style Intensity: ${request.style || 'moderate'}

**Output Format:**
Return ONLY valid JSON (no markdown, no code block) with this exact structure:
{
  "name": "descriptive drop name",
  "description": "brief description of the sound",
  "parameterSequence": [
    {
      "pluginId": "plugin_name",
      "parameterId": "parameter_name",
      "startValue": 0.0,
      "endValue": 1.0,
      "duration": 4000,
      "curve": "linear"
    }
  ],
  "confidence": 0.85,
  "buildupTime": 2000,
  "dropDuration": 3000
}

**Rules:**
- All values are normalized (0.0 to 1.0)
- Duration is in milliseconds
- Confidence is your certainty (0.0 to 1.0)
- Return realistic plugin parameter IDs
- Ensure drop fits within 4 bars at ${request.bpm} BPM
    `.trim();
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/health`, {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Set API key
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }
}

export const aiServerBridge = new AiServerBridge();
