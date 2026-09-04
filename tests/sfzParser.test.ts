import { describe, expect, it } from 'vitest';
import { matchRegion, parseSfz } from '../src/core/instrument/sfzParser';

const SFZ = `
// Piano-Test-SFZ
<global> volume=-6

<group> loop_mode=loop_continuous lovel=0 hivel=127

<region> sample=Kick.wav lokey=36 hikey=36 seq_length=2 seq_position=1
<region> sample=KickRR2.wav lokey=36 hikey=36 seq_length=2 seq_position=2
<region> sample=Snare.wav key=38 lovel=0 hivel=100
<region> sample=SnareRim.wav key=38 lovel=101 hivel=127
<region> sample=Hat.wav lokey=42 hikey=44 loop_mode=one_shot
`;

describe('SFZ-Parser (A-Klasse: LinuxSampler-Format-Referenz)', () => {
  it('parst Sektionen, Vererbung und Regionen', () => {
    const { globals, regions, errors } = parseSfz(SFZ);
    expect(errors).toEqual([]);
    expect(globals.volume).toBe('-6');
    expect(regions).toHaveLength(5);

    // Vererbung aus <group>: loop_mode + lovel/hivel
    const kick = regions[0];
    expect(kick.sample).toBe('Kick.wav');
    expect(kick.lokey).toBe(36);
    expect(kick.hikey).toBe(36);
    expect(kick.loopMode).toBe('loop_continuous');
    expect(kick.seqLength).toBe(2);
    expect(kick.seqPosition).toBe(1);

    // Region-spezifisches loop_mode überschreibt die Gruppe.
    expect(regions[4].loopMode).toBe('one_shot');
  });

  it('matchRegion: Velocity-Layer (Snare vs. SnareRim)', () => {
    const { regions } = parseSfz(SFZ);
    expect(matchRegion(regions, 38, 50)?.sample).toBe('Snare.wav');
    expect(matchRegion(regions, 38, 120)?.sample).toBe('SnareRim.wav');
    expect(matchRegion(regions, 37, 100)).toBeNull(); // kein Key-Range
  });

  it('matchRegion: Round-Robin wechselt deterministisch', () => {
    const { regions } = parseSfz(SFZ);
    expect(matchRegion(regions, 36, 100, { roundRobin: 0 })?.sample).toBe('Kick.wav');
    expect(matchRegion(regions, 36, 100, { roundRobin: 1 })?.sample).toBe('KickRR2.wav');
    expect(matchRegion(regions, 36, 100, { roundRobin: 2 })?.sample).toBe('Kick.wav');
  });

  it('unbekannte Opcodes bleiben als raw erhalten, Fehler werden gemeldet', () => {
    const { regions, errors } = parseSfz(`
<region> sample=X.wav custom_op=42
bogus_line_without_section
`);
    expect(regions[0]?.raw.custom_op).toBe('42');
    expect(errors.length).toBeGreaterThan(0);
  });
});
