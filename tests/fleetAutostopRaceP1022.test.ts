// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetFleetAutostop, noteFleetActivity, runFleetAutostop, setAutostopMembersSource, setFleetAutostopHooks } from '../src/core/ai/orchestrator/fleetAutostop';
import { __resetPodQueues, podQueue } from '../src/core/ai/orchestrator/podJobQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const pods = [{ id: 'podabc1', name: 'audiomonastry-pod-brain', desiredStatus: 'RUNNING' }];
let members = 0;
let deletes: string[];
let env: NodeJS.ProcessEnv;

describe('AUDIT-2026-10-30-P1-022: asynchronous fleet autostop', () => {
  beforeEach(() => {
    env = { ...process.env };
    Object.assign(process.env, { AI_FLEET_MODE: 'pods', AI_FLEET_AUTOSTOP: '1', AI_FLEET_AUTOSTOP_DRYRUN: '0', AI_FLEET_AUTOSTOP_RETRIES: '1', RP_API_KEY: 'test', RUNPOD_REST_BASE: 'https://fake.invalid/v1' });
    members = 0;
    deletes = [];
    __resetFleetAutostop();
    __resetPodQueues();
    setAutostopMembersSource(() => members);
    setFleetAutostopHooks({ checkpoint: async () => ({ ok: true }) });
  });
  afterEach(() => {
    __resetFleetAutostop();
    __resetPodQueues();
    setAutostopMembersSource(() => 0);
    vi.unstubAllGlobals();
    process.env = env;
  });

  it('does not terminate when a member joins during the awaited list', async () => {
    const listed = deferred<Response>();
    const requested = deferred<void>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(input));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      requested.resolve();
      return listed.promise;
    }));
    const running = runFleetAutostop('presence-grace');
    await requested.promise;
    members = 1;
    listed.resolve(Response.json(pods));
    const report = await running;
    expect(report).toMatchObject({ ok: true, aborted: 'rejoined', steps: ['checkpoint', 'list'] });
    expect(deletes).toEqual([]);
  });

  it('defers when a job begins during the awaited list', async () => {
    const listed = deferred<Response>();
    const requested = deferred<void>();
    const jobDone = deferred<void>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(input));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      requested.resolve();
      return listed.promise;
    }));
    const running = runFleetAutostop('idle-no-jobs');
    await requested.promise;
    const job = podQueue('brain').run('default', 'new job', () => jobDone.promise);
    listed.resolve(Response.json(pods));
    const report = await running;
    jobDone.resolve();
    await job;
    expect(report).toMatchObject({ ok: true, aborted: 'jobs-running', steps: ['checkpoint', 'list'] });
    expect(deletes).toEqual([]);
  });

  it('stops issuing deletes if presence returns while the first delete is pending', async () => {
    const deleted = deferred<Response>();
    const requested = deferred<void>();
    const account = [...pods, { id: 'podabc2', name: 'audiomonastry-pod-ears', desiredStatus: 'RUNNING' }];
    let listCount = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(input));
        requested.resolve();
        return deleted.promise;
      }
      listCount += 1;
      return Promise.resolve(Response.json(listCount === 1 ? account : account.slice(1)));
    }));
    const running = runFleetAutostop('presence-grace');
    await requested.promise;
    members = 1;
    deleted.resolve(new Response(null, { status: 204 }));
    const report = await running;
    expect(deletes).toEqual(['https://fake.invalid/v1/pods/podabc1']);
    expect(report).toMatchObject({ ok: true, aborted: 'rejoined', terminated: ['audiomonastry-pod-brain'], remaining: 1, alarm: false });
  });

  it('does not retry a failed delete if a job starts before the retry', async () => {
    process.env.AI_FLEET_AUTOSTOP_RETRIES = '2';
    process.env.AI_FLEET_AUTOSTOP_RETRY_MS = '1';
    const jobDone = deferred<void>();
    let job: Promise<void> | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(input));
        if (deletes.length === 1) job = podQueue('brain').run('default', 'new job', () => jobDone.promise);
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return Promise.resolve(Response.json(pods));
    }));
    const report = await runFleetAutostop('idle-no-jobs');
    jobDone.resolve();
    await job;
    expect(deletes).toHaveLength(1);
    expect(report).toMatchObject({ aborted: 'jobs-running', ok: false, alarm: true });
    expect(report.failed).toEqual([{ id: 'podabc1', name: 'audiomonastry-pod-brain', error: 'Terminate HTTP 500' }]);
  });

  it('does not clear fleet state when a member joins during verification', async () => {
    const verification = deferred<Response>();
    const requested = deferred<void>();
    let lists = 0;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      lists += 1;
      if (lists === 1) return Promise.resolve(Response.json(pods));
      requested.resolve();
      return verification.promise;
    }));
    const running = runFleetAutostop('presence-grace');
    await requested.promise;
    members = 1;
    verification.resolve(Response.json([]));
    const report = await running;
    expect(report).toMatchObject({ ok: true, aborted: 'rejoined' });
  });

  it('defers while a new job is waking before entering its queue', async () => {
    const listed = deferred<Response>();
    const requested = deferred<void>();
    let listCount = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(input));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      listCount += 1;
      if (listCount === 1) { requested.resolve(); return listed.promise; }
      return Promise.resolve(Response.json([]));
    }));
    const running = runFleetAutostop('idle-no-jobs');
    await requested.promise;
    noteFleetActivity('job on brain');
    listed.resolve(Response.json(pods));
    const report = await running;
    expect(deletes).toEqual([]);
    expect(report.aborted).toBe('new-activity');
  });

  it('manual force still terminates despite presence and a job arriving during listing', async () => {
    const listed = deferred<Response>();
    const requested = deferred<void>();
    const jobDone = deferred<void>();
    let lists = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(input));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      lists += 1;
      if (lists === 1) { requested.resolve(); return listed.promise; }
      return Promise.resolve(Response.json([]));
    }));
    const running = runFleetAutostop('manual', { force: true });
    await requested.promise;
    members = 1;
    const job = podQueue('brain').run('default', 'job', () => jobDone.promise);
    noteFleetActivity('job on brain');
    listed.resolve(Response.json(pods));
    const report = await running;
    jobDone.resolve();
    await job;
    expect(deletes).toHaveLength(1);
    expect(report).toMatchObject({ ok: true, aborted: null });
  });
});
