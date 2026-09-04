/**
 * dropMONK – Drop Profile & Style Library
 * =======================================
 * Definiert Drop-Charaktere und ihre Parameter-Transformationen
 */

export type CurveType = 'linear' | 'exponential' | 'logarithmic' | 's-curve' | 'stepped';
export type DropCategory = 'buildup' | 'breakdown' | 'transition' | 'fill' | 'custom';
export type QuantizationType = '1bar' | '2bar' | '4bar' | '1/2bar' | '1/4bar' | '1/8bar' | 'instant';

export interface ParameterTransformation {
  pluginId: string; // 'synth', 'reverb', 'drum', 'mixer', etc.
  parameterId: string; // 'cutoff', 'mix', 'drive', 'fader', etc.
  startValue: number; // 0..1 normalized
  endValue: number; // 0..1 normalized
  duration: number; // milliseconds
  curve: CurveType;
  delay?: number; // offset vom Drop-Start in ms
  smoothingTime?: number; // ms für Audio-Rate Safe smoothing
}

export interface SampleCriteria {
  category?: string; // 'mids', 'highs', 'lows', 'percussive', 'bass'
  tempo?: number;
  minLength?: number; // ms
  maxLength?: number; // ms
  count?: number; // how many samples to select
}

export interface DropProfile {
  id: string;
  name: string; // "Energy Buildup", "Ambient Space", "Techno Breakdown"
  description: string;
  category: DropCategory;

  // Parameter-Transformationen
  parameterSequence: ParameterTransformation[];

  // Sample-Auswahl-Regel
  sampleCriteria?: SampleCriteria;

  // Timing
  buildupTime: number; // ms vor Drop (für Quantized Mode)
  dropDuration: number; // ms Drop-Aktion dauert
  quantization: QuantizationType; // Standard-Quantisierung

  // Metadata
  tags?: string[];
  intensity?: number; // 0..1, für "subtle" bis "extreme"
  targetPlugins?: string[]; // Welche Plugins dieser Drop typically betrifft
}

export interface GeneratedDropProfile extends DropProfile {
  generatedAt: number;
  aiModel: 'deepseek' | 'huggingface' | 'local';
  confidence: number; // 0..1
  userPrompt?: string;
  generatedFrom?: DropProfile; // Falls basierend auf Suggestion
}

export interface DropPreset {
  id: string;
  name: string;
  profile: DropProfile;
  tags: string[];
  createdAt: number;
  modifiedAt: number;
  favorite: boolean;
  usageCount?: number;
}

/**
 * Built-in Drop Profile Library
 */
export const DROP_PROFILES: DropProfile[] = [
  {
    id: 'energy_buildup',
    name: 'Energy Buildup',
    description: 'Classic exponential filter sweep with reverb buildup',
    category: 'buildup',
    parameterSequence: [
      {
        pluginId: 'synthesizer',
        parameterId: 'cutoff',
        startValue: 0.2,
        endValue: 0.95,
        duration: 4000,
        curve: 'exponential',
      },
      {
        pluginId: 'effect',
        parameterId: 'mix',
        startValue: 0.1,
        endValue: 0.6,
        duration: 4000,
        curve: 'linear',
      },
      {
        pluginId: 'drum',
        parameterId: 'drive',
        startValue: 0,
        endValue: 0.7,
        duration: 4000,
        curve: 's-curve',
        delay: 1000,
      },
    ],
    buildupTime: 4000,
    dropDuration: 2000,
    quantization: '4bar',
    tags: ['techno', 'progressive', 'energetic'],
    intensity: 0.8,
    targetPlugins: ['synthesizer', 'effect', 'drum'],
  },
  {
    id: 'ambient_space',
    name: 'Ambient Space',
    description: 'Subtle reverb and delay extension for spacious atmospheres',
    category: 'breakdown',
    parameterSequence: [
      {
        pluginId: 'effect',
        parameterId: 'mix',
        startValue: 0.3,
        endValue: 0.8,
        duration: 6000,
        curve: 'logarithmic',
      },
      {
        pluginId: 'effect',
        parameterId: 'size',
        startValue: 0.4,
        endValue: 0.9,
        duration: 6000,
        curve: 'linear',
      },
    ],
    buildupTime: 2000,
    dropDuration: 3000,
    quantization: '2bar',
    tags: ['ambient', 'atmospheric', 'spacious'],
    intensity: 0.4,
    targetPlugins: ['effect'],
  },
  {
    id: 'techno_drop',
    name: 'Techno Drop',
    description: 'Hard kick with sidechain compression and bass emphasis',
    category: 'buildup',
    parameterSequence: [
      {
        pluginId: 'drum',
        parameterId: 'density',
        startValue: 0.3,
        endValue: 0.95,
        duration: 3000,
        curve: 's-curve',
      },
      {
        pluginId: 'mixer',
        parameterId: 'bass_gain',
        startValue: 0,
        endValue: 0.8,
        duration: 3000,
        curve: 'exponential',
        delay: 500,
      },
    ],
    buildupTime: 3000,
    dropDuration: 1500,
    quantization: '4bar',
    tags: ['techno', 'hard', 'percussive'],
    intensity: 0.95,
    targetPlugins: ['drum', 'mixer'],
  },
  {
    id: 'breakdown',
    name: 'Breakdown',
    description: 'Filters close, reverb reduces – transition to new section',
    category: 'breakdown',
    parameterSequence: [
      {
        pluginId: 'synthesizer',
        parameterId: 'cutoff',
        startValue: 0.8,
        endValue: 0.1,
        duration: 2000,
        curve: 'exponential',
      },
      {
        pluginId: 'effect',
        parameterId: 'mix',
        startValue: 0.5,
        endValue: 0.1,
        duration: 2000,
        curve: 'linear',
      },
      {
        pluginId: 'drum',
        parameterId: 'drive',
        startValue: 0.6,
        endValue: 0,
        duration: 2000,
        curve: 'linear',
      },
    ],
    buildupTime: 1000,
    dropDuration: 2000,
    quantization: '4bar',
    tags: ['breakdown', 'reduction', 'transition'],
    intensity: 0.5,
    targetPlugins: ['synthesizer', 'effect', 'drum'],
  },
  {
    id: 'dj_transition',
    name: 'DJ Transition',
    description: 'Cross-channel fade with filter sweep for seamless transitions',
    category: 'transition',
    parameterSequence: [
      {
        pluginId: 'mixer',
        parameterId: 'channel_fade',
        startValue: 1.0,
        endValue: 0.0,
        duration: 4000,
        curve: 'linear',
      },
      {
        pluginId: 'synthesizer',
        parameterId: 'cutoff',
        startValue: 0.5,
        endValue: 0.95,
        duration: 3000,
        curve: 'exponential',
        delay: 500,
      },
    ],
    buildupTime: 1000,
    dropDuration: 4000,
    quantization: '4bar',
    tags: ['dj', 'transition', 'crossfade'],
    intensity: 0.7,
    targetPlugins: ['mixer', 'synthesizer'],
  },
  {
    id: 'fill_cymbal',
    name: 'Fill Cymbal',
    description: 'Cymbal fill with high-pass resonance for breaks',
    category: 'fill',
    parameterSequence: [
      {
        pluginId: 'drum',
        parameterId: 'cymbal_level',
        startValue: 0,
        endValue: 0.95,
        duration: 2000,
        curve: 's-curve',
      },
      {
        pluginId: 'effect',
        parameterId: 'cutoff',
        startValue: 0.3,
        endValue: 0.9,
        duration: 2000,
        curve: 'exponential',
      },
    ],
    buildupTime: 500,
    dropDuration: 1500,
    quantization: '1bar',
    tags: ['fill', 'cymbal', 'break'],
    intensity: 0.6,
    targetPlugins: ['drum', 'effect'],
  },
];

/**
 * Interpolation Functions für Curve-Typen
 */
export function interpolateValue(
  from: number,
  to: number,
  progress: number, // 0..1
  curve: CurveType
): number {
  if (progress <= 0) return from;
  if (progress >= 1) return to;

  const delta = to - from;

  switch (curve) {
    case 'linear':
      return from + delta * progress;

    case 'exponential':
      // Exponential curve: accelerate
      return from + delta * (Math.pow(2, progress) - 1) / (2 - 1);

    case 'logarithmic':
      // Logarithmic curve: decelerate
      return from + delta * Math.log(1 + progress) / Math.log(2);

    case 's-curve':
      // S-curve (smoothstep): slow start and end
      const eased = progress * progress * (3 - 2 * progress);
      return from + delta * eased;

    case 'stepped':
      // Stepped: quantize to 10 steps
      const steps = 10;
      const stepped = Math.floor(progress * steps) / steps;
      return from + delta * stepped;

    default:
      return from + delta * progress;
  }
}

/**
 * Get profile by ID
 */
export function getDropProfile(id: string): DropProfile | undefined {
  return DROP_PROFILES.find((p) => p.id === id);
}

/**
 * Filter profiles by category
 */
export function getDropProfilesByCategory(category: DropCategory): DropProfile[] {
  return DROP_PROFILES.filter((p) => p.category === category);
}

/**
 * Filter profiles by intensity range
 */
export function getDropProfilesByIntensity(min: number, max: number): DropProfile[] {
  return DROP_PROFILES.filter((p) => (p.intensity ?? 0.5) >= min && (p.intensity ?? 0.5) <= max);
}

/**
 * Get profiles suitable for given active plugins
 */
export function getDropProfilesForPlugins(activePluginIds: string[]): DropProfile[] {
  return DROP_PROFILES.filter((profile) => {
    if (!profile.targetPlugins || profile.targetPlugins.length === 0) return true;
    return profile.targetPlugins.some((target) => activePluginIds.includes(target));
  });
}
