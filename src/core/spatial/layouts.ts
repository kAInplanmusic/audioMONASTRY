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
  ['stereo', 'Stereo (2.0)', ['L', 'R']],
  ['2.0', '2.0 Stereo', ['L', 'R']],
  ['2.1', '2.1 Stereo + Sub', ['L', 'R', 'LFE']],
  ['2.2', '2.2 Stereo + 2 Sub', ['L', 'R', 'LFE1', 'LFE2']],
  ['4.0', 'Quad', ['L', 'R', 'Ls', 'Rs']],
  ['4.1', '4.1 Quad + Sub', ['L', 'R', 'Ls', 'Rs', 'LFE']],
  ['4.2', '4.2 Quad + 2 Sub', ['L', 'R', 'Ls', 'Rs', 'LFE1', 'LFE2']],
  ['5.1', '5.1 Surround', ['L', 'C', 'R', 'Ls', 'Rs', 'LFE']],
  ['7.1', '7.1 Surround', ['L', 'C', 'R', 'Ls', 'Rs', 'Lb', 'Rb', 'LFE']],
  ['10.0', '10.0 (monkMONASTRY)', ['L', 'R', 'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw', 'Lh', 'Rh']],
  ['12.0', '12.0', ['L', 'C', 'R', 'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw', 'Lh', 'Rh', 'Ch']],
  ['12.1', '12.1', ['L', 'C', 'R', 'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw', 'Lh', 'Rh', 'Ch', 'LFE']],
  ['12.2', '12.2', ['L', 'C', 'R', 'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw', 'Lh', 'Rh', 'Ch', 'LFE1', 'LFE2']],
  ['18.0', '18.0', [
    'L', 'C', 'R', 'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw',
    'Lh', 'Rh', 'Ch', 'Lts', 'Rts', 'Ltb', 'Rtb', 'Lc', 'Rc',
  ]],
  ['18.1', '18.1', [
    'L', 'C', 'R', 'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw',
    'Lh', 'Rh', 'Ch', 'Lts', 'Rts', 'Ltb', 'Rtb', 'Lc', 'Rc', 'LFE',
  ]],
  ['18.2', '18.2 Large', [
    'L', 'C', 'R', 'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw',
    'Lh', 'Rh', 'Ch', 'Lts', 'Rts', 'Ltb', 'Rtb', 'LFE1', 'LFE2', 'Lc', 'Rc',
  ]],
  ['24.0', '24.0', [
    'L', 'LC', 'C', 'RC', 'R',
    'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw',
    'Lh', 'Rh', 'Ch', 'Cs',
    'Lts', 'Rts', 'Ltb', 'Rtb',
    'Lc', 'Rc', 'Lv', 'Rv', 'Tv',
  ]],
  ['24.1', '24.1', [
    'L', 'LC', 'C', 'RC', 'R',
    'Ls', 'Rs', 'Lb', 'Rb', 'Lw', 'Rw',
    'Lh', 'Rh', 'Ch', 'Cs',
    'Lts', 'Rts', 'Ltb', 'Rtb',
    'Lc', 'Rc', 'Lv', 'Rv', 'Tv', 'LFE',
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
