/** Opt-in telemetry helpers. CPU percentages use one logical CPU as 100%. */
export function distribution(values) {
  if (!values.length) return { count: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { count: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) };
}

export function procStat(text) {
  // comm may contain spaces and parentheses; fields following its final ')' start at #3.
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { ticks: Number(fields[11]) + Number(fields[12]), startTicks: fields[19] };
}

export function cpuPercent(before, after, elapsedMs, hz) {
  if (before.startTicks !== after.startTicks) throw new Error('Holder PID was reused');
  return (after.ticks - before.ticks) / hz / (elapsedMs / 1000) * 100;
}
