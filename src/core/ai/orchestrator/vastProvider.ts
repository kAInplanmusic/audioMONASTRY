/**
 * audioMONASTRY · Vast AI Provider
 * =================================
 * Führt AI-Tasks über Vast-gehostete Pod-Endpoints aus.
 */
import type { GpuRoleId } from '../../../config/aiInfrastructure';
import { AiProviderError, type AiProviderId, type AiTask, type IAiProvider } from './types';
import { fleetMode, podBaseUrl, podRoleFor, podToken, type PodRoleId } from './podRouting';
import { ensurePodForJob, markPodStale, notePodActivity, PodWakeBlockedError } from './podStartTriggers';
import { classifyPodJob, isPreemptionError, PodPreemption, podQueue } from './podJobQueue';
import { aiLogger } from './aiLogger';

export class VastProvider implements IAiProvider {
  readonly id: AiProviderId;
  private readonly roleId: GpuRoleId;

  constructor(roleId: GpuRoleId) {
    this.roleId = roleId;
    this.id = `vast-${roleId}` as AiProviderId;
  }

  get available(): boolean {
    const pod = podRoleFor(this.roleId);
    return Boolean(pod && podBaseUrl(pod) && podToken());
  }

  canRun(task: AiTask, _model?: string): boolean {
    // Vast provider supports all tasks mapped to roles in podRouting
    return true; 
  }

  estimateCostUsd(_task: AiTask, _model?: string): number {
    // Costs are managed at the fleet level for Vast
    return 0;
  }

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    this.assertConfigured(task, model, input);
    const pod = podRoleFor(this.roleId, task, model, input) as PodRoleId;
    
    try {
      await ensurePodForJob(pod, task, signal);
    } catch (error) {
      if (error instanceof PodWakeBlockedError) {
        throw new AiProviderError(this.id, `POD_WAKE_${error.block.toUpperCase().replace(/-/g, '_')}`, error.message, false);
      }
      if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
      throw error;
    }
    
    const exec = (s: AbortSignal) => this.runDirect(pod, task, model, input, s);
    const cls = classifyPodJob(task, model, input);
    
    try {
      return await podQueue(pod).run(cls, `${task}:${model}`, exec, signal, this.id);
    } catch (error) {
      if (isPreemptionError(error)) {
        aiLogger.warn('pod job preempted, caller must retry', { provider: this.id, pod, task, model, code: (error as AiProviderError).code });
      } else {
        markPodStale(pod, (error as Error).message);
      }
      throw error;
    } finally {
      notePodActivity(`job ${task} finished on ${pod}`);
    }
  }

  private async runDirect(pod: PodRoleId, task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const url = `${podBaseUrl(pod)}/run`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${podToken()}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ input: { task, model, input } }),
      signal: signal ?? AbortSignal.timeout(600_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new AiProviderError(this.id, `HTTP_${resp.status}`, text.slice(0, 300), resp.status >= 500);
    }
    return (await resp.json()) as unknown;
  }

  private assertConfigured(task?: AiTask, model?: string, input?: unknown): void {
    const pod = podRoleFor(this.roleId, task, model, input);
    if (!pod) {
      throw new AiProviderError(this.id, 'NO_POD_FOR_ROLE', `Für ${this.roleId} gibt es keinen Pod`, false);
    }
    if (!podBaseUrl(pod)) {
      throw new AiProviderError(this.id, 'POD_NOT_CONFIGURED', `Pod ${pod} fehlt`, false);
    }
    if (!podToken()) {
      throw new AiProviderError(this.id, 'NO_POD_TOKEN', 'AI_POD_TOKEN fehlt', false);
    }
  }
}
