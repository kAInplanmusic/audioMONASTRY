// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { addLocalSample, listLocalSamples, readLocalMedia, saveLocalMedia, type LocalSampleEntry } from '../server/localMediaStore.ts';

const execFile = promisify(execFileCallback);

let dir: string;
let previousDir: string | undefined;
const entry = (id: string): LocalSampleEntry => ({
  id, name: id, category: 'mids', type: 'sample', url: `/api/media/uploads/${id}.wav`,
  description: '', tags: [], parameters: {}, createdAt: '2025-01-01T00:00:00.000Z',
});

beforeEach(async () => {
  previousDir = process.env.AUDIOMONASTRY_MEDIA_DIR;
  dir = await mkdtemp(path.join(process.env.TMPDIR!, 'local-media-regression-'));
  process.env.AUDIOMONASTRY_MEDIA_DIR = dir;
});
afterEach(async () => {
  if (previousDir === undefined) delete process.env.AUDIOMONASTRY_MEDIA_DIR;
  else process.env.AUDIOMONASTRY_MEDIA_DIR = previousDir;
  await rm(dir, { recursive: true, force: true });
});

describe('local media index', () => {
  it('propagates a real filesystem failure and permits the next write', async () => {
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    process.env.AUDIOMONASTRY_MEDIA_DIR = path.join(blocker, 'uploads');
    const failed = addLocalSample(entry('failed'));
    process.env.AUDIOMONASTRY_MEDIA_DIR = dir;
    const succeeding = addLocalSample(entry('success'));
    await expect(failed).rejects.toThrow();
    await expect(succeeding).resolves.toBeUndefined();
    expect((await listLocalSamples()).map((sample) => sample.id)).toEqual(['success']);
  });

  it('recovers acknowledged media and entries in a fresh process', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `restart-${i}`);
    await Promise.all(ids.map(async (id) => {
      await saveLocalMedia(`${id}.wav`, Buffer.from(id));
      await addLocalSample(entry(id));
    }));
    const moduleUrl = pathToFileURL(path.resolve('server/localMediaStore.ts')).href;
    const script = `import { listLocalSamples, readLocalMedia } from ${JSON.stringify(moduleUrl)};
      const list = await listLocalSamples();
      for (const sample of list) {
        if ((await readLocalMedia(sample.id + '.wav'))?.toString() !== sample.id) process.exit(2);
      }
      console.log(JSON.stringify(list.map(sample => sample.id).sort()));`;
    const result = await execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, AUDIOMONASTRY_MEDIA_DIR: dir }, timeout: 30000,
    });
    expect(JSON.parse(result.stdout)).toEqual(ids.sort());
  }, 40000);

  it('refuses to overwrite a corrupt index and preserves its bytes', async () => {
    const broken = '{"incomplete":';
    await writeFile(path.join(dir, 'index.json'), broken);
    await expect(addLocalSample(entry('new'))).rejects.toThrow();
    expect(await readFile(path.join(dir, 'index.json'), 'utf8')).toBe(broken);
  });

  it('never exposes a truncated index to concurrent filesystem readers', async () => {
    await addLocalSample({ ...entry('large'), description: 'x'.repeat(2_000_000) });
    let writing = true;
    const observedErrors: unknown[] = [];
    const reader = (async () => {
      while (writing) {
        try {
          const parsed = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
          if (!Array.isArray(parsed) || parsed[0]?.id !== 'large') throw new Error('lost existing entry');
        } catch (error) {
          observedErrors.push(error);
        }
      }
    })();
    try {
      for (let i = 0; i < 12; i++) await addLocalSample(entry(`next-${i}`));
    } finally {
      writing = false;
      await reader;
    }
    expect(observedErrors).toEqual([]);
  });

  it('retains all concurrent successful uploads and their media', async () => {
    await addLocalSample(entry('existing'));
    const ids = Array.from({ length: 48 }, (_, i) => `sample-${i}`);
    await Promise.all(ids.map(async (id) => {
      await saveLocalMedia(`${id}.wav`, Buffer.from(id));
      await addLocalSample(entry(id));
    }));
    const persisted = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8')) as LocalSampleEntry[];
    expect(persisted.map((sample) => sample.id).sort()).toEqual(['existing', ...ids].sort());
    expect((await listLocalSamples()).length).toBe(49);
    await Promise.all(ids.map(async (id) => expect((await readLocalMedia(`${id}.wav`))?.toString()).toBe(id)));
  });
});
