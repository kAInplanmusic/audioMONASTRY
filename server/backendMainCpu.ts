import { readFileSync } from 'node:fs';
/** Linux per-OS-thread CPU counters, not process-wide process.cpuUsage(). */
export function mainThreadCpu() {
  try {
    const stat = readFileSync('/proc/thread-self/stat', 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // Linux target host CLK_TCK=100; report ticks rather than assuming a portable rate.
    return { userTicks: Number(f[11]), systemTicks: Number(f[12]) };
  } catch { return null; }
}
export function mainCgroupCpu() {
  try { return readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'); } catch { return null; }
}
