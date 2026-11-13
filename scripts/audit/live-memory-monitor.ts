import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, readdirSync } from 'node:fs';
/** Real RSS of the task's process tree; shared mappings can be counted twice. */
export function sampleSessionMemory(rootPid: number, file: string) {
  const processes: { pid: number; parent: number; rssBytes: number }[] = [];
  for (const name of readdirSync('/proc')) if (/^\d+$/.test(name)) {
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      processes.push({ pid: Number(name), parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),
        rssBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024 });
    } catch { /* Process exited between enumeration and read. */ }
  }
  const tree = new Set([rootPid]); let changed = true;
  while (changed) { changed = false; for (const p of processes) if (tree.has(p.parent) && !tree.has(p.pid)) { tree.add(p.pid); changed = true; } }
  const rssBytes = processes.filter(p => tree.has(p.pid)).reduce((n, p) => n + p.rssBytes, 0);
  const configured = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
  const capacityBytes = configured === 'max' ? Number(readFileSync('/proc/meminfo', 'utf8').match(/^MemTotal:\s+(\d+)/m)![1]) * 1024 : Number(configured);
  const row = { type: 'session-memory', at: new Date().toISOString(), monotonicMs: performance.now(), rootPid,
    processes: tree.size, rssBytes, capacityBytes, rssRatio: rssBytes / capacityBytes,
    capacitySource: configured === 'max' ? 'host MemTotal' : 'cgroup memory.max',
    cgroupCurrentBytes: Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim()),
    nodeHeapUsedBytes: process.memoryUsage().heapUsed, warningAbove80Percent: rssBytes / capacityBytes > .8,
    method: 'sum /proc task-tree VmRSS (shared pages may be counted twice); no forced GC' };
  appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
  const fd = openSync(file, 'a'); try { fsyncSync(fd); } finally { closeSync(fd); }
  if (row.warningAbove80Percent) console.warn('RSS_WARNING_OVER_80_PERCENT ' + JSON.stringify(row));
  return row;
}
