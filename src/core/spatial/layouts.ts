/**
 * audioMONASTRY · Spatial Output Layouts
 * ======================================
 * Zentrale Definition aller unterstützten Lautsprecher-Konfigurationen
 * von Stereo bis 24.2. Renderer kennen nur diese abstrakten Layouts.
 */

export interface OutputLayout {
  id: string;
  name: string;
  channelCount: number;
  channels: string[];
}

const rawLayouts: Array<[string, string, string[]]> = [
  ['stereo', 'Stereo', ['L', 'R']],
  ['4.0', 'Quad', ['L', 'R', 'Ls', 'Rs']],
  ['5.1', '5.1 Surround', ['L', 'C', 'R', 'Ls', 'Rs', 'LFE']],
  ['7.1', '7.1 Surround', ['L', 'C', 'R', 'Ls', 'Rs', 'Lb', 'Rb', 'LFE']],
  ['10.0', '10.0 (monkMONASTRY)', ['L', 'R', 'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw', 'Lh', 'Rh']],
  ['18.2', '18.2 Large', [
    'L', 'C', 'R', 'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw',
    'Lh', 'Rh', 'Ch', 'Lts', 'Rts', 'Ltb', 'Rtb', 'LFE1', 'LFE2', 'Lc', 'Rc',
  ]],
  ['24.2', '24.2 Cinema', [
    'L', 'LC', 'C', 'RC', 'R',
    'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw',
    'Lh', 'Rh', 'Ch', 'Cs',
    'Lts', 'Rts', 'Ltb', 'Rtb',
    'LFE1', 'LFE2',
    'Lc', 'Rc', 'Lv', 'Rv', 'Tv',
  ]],
];

export const OUTPUT_LAYOUTS: OutputLayout[] = rawLayouts.map(([id, name, channels]) => ({
  id,
  name,
  channels,
  channelCount: channels.length,
}));

export function getOutputLayout(id: string): OutputLayout | undefined {
  return OUTPUT_LAYOUTS.find((l) => l.id === id);
}

export function defaultOutputLayout(): OutputLayout {
  return OUTPUT_LAYOUTS[0];
}
