/**
 * audioMONASTRY · Output Abstraction
 * ==================================
 * Flexible Output-Konfiguration von Stereo bis 24.2. Renderer kennen keine
 * Interface-spezifischen Details – nur Layout-IDs und Kanalnamen.
 */
import { getOutputLayout, OUTPUT_LAYOUTS } from '../spatial/layouts';

export interface OutputConfig {
  layoutId: string;
  sampleRate: number;
  bufferSize: number;
  channels: string[];
  spatialMode: 'stereo' | 'spatial';
}

export function createOutputConfig(
  layoutId = 'stereo',
  sampleRate = 48000,
  bufferSize = 128,
  spatialMode: 'stereo' | 'spatial' = 'stereo',
): OutputConfig {
  const layout = getOutputLayout(layoutId);
  if (!layout) throw new Error(`Unbekanntes Output-Layout: ${layoutId}`);
  return { layoutId, sampleRate, bufferSize, channels: layout.channels, spatialMode };
}

export function listSupportedLayoutIds(): string[] {
  return OUTPUT_LAYOUTS.map((l) => l.id);
}

export function supports24_2(layoutId: string): boolean {
  return layoutId === '24.2';
}
