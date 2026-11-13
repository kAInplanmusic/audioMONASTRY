import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** Append-only raw records. Each flush is durable before the test session is signaled. */
export class LiveJournal {
  private pending: string[] = [];
  private count = 0;
  private flushes = 0;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // A restart must not mix two sessions or overwrite an older checkpoint.
    closeSync(openSync(join(directory, 'raw.ndjson'), 'ax', 0o600));
  }
  record(event: unknown) { this.pending.push(JSON.stringify(event) + '\n'); }
  flush() {
    const fd = openSync(join(this.directory, 'raw.ndjson'), 'a', 0o600);
    try {
      // writeSync may be partial. Never drop a suffix after a short filesystem write.
      const buffer = Buffer.from(this.pending.join(''));
      let offset = 0;
      while (offset < buffer.length) { const written = writeSync(fd, buffer, offset); if (!written) throw new Error('Raw journal short write'); offset += written; }
      fsyncSync(fd); this.count += this.pending.length; this.pending = [];
    } finally { closeSync(fd); }
    const checkpoint = join(this.directory, 'checkpoint.json');
    const tmp = checkpoint + '.tmp';
    writeFileSync(tmp, JSON.stringify({ records: this.count, flushes: ++this.flushes, flushedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    const file = openSync(tmp, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(tmp, checkpoint);
    const directory = openSync(dirname(checkpoint), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
