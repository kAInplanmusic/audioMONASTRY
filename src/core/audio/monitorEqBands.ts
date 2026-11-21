export const MONITOR_EQ_BAND_COUNT = 36;
export const MONITOR_EQ_GAIN_EVENT = 'monk:eq-gains-changed';

export const MONITOR_EQ_BANDS = Array.from({ length: MONITOR_EQ_BAND_COUNT }, (_, index) => {
  const freq = Math.round(20 * Math.pow(10, (index * 3) / (MONITOR_EQ_BAND_COUNT - 1)));
  const label = freq < 1000 ? `${freq}Hz` : `${(freq / 1000).toFixed(1).replace(/\.0$/, '')}kHz`;
  return { freq, label };
});

export function monitorEqBandType(index: number): 'lowshelf' | 'highshelf' | 'peaking' {
  if (index === 0) return 'lowshelf';
  return index === MONITOR_EQ_BAND_COUNT - 1 ? 'highshelf' : 'peaking';
}

export function monitorEqBands(gains: readonly number[], qs: readonly number[]) {
  return MONITOR_EQ_BANDS.map(({ freq }, index) => ({
    freq, gain: gains[index], q: qs[index], type: monitorEqBandType(index),
  }));
}

export function shiftEqGains(gains: readonly number[], range: string, delta: number, bandCount: number, limit: number): number[] {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(range);
  const first = Number(match?.[1]);
  const last = Number(match?.[2]);
  if (!match || first < 1 || last < first || last > bandCount
      || !Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 12) {
    throw new Error(`EQ erwartet Band 1–${bandCount} und eine Änderung von 0,1–12 dB.`);
  }
  return Array.from({ length: bandCount }, (_, index) => {
    const gain = Number.isFinite(gains[index]) ? gains[index] : 0;
    if (index + 1 < first || index + 1 > last) return gain;
    return Math.max(-limit, Math.min(limit, Math.round((gain + delta) * 10) / 10));
  });
}
