import { useEffect, useRef } from 'react';
import { moaAgent, type MoaStep } from '../core/ai/MoaAgent';
import { moaHistory } from '../core/ai/MoaHistory';
import { resolveCanonicalPluginId } from '../plugins/legacyAliases';
import { storageGetJson, storageSetJson } from '../utils/storage';
import { moaTaskForPlugin } from '../utils/prompts';
import { webRTCManager } from '../utils/WebRTCManager';

interface MoaAssistantProps {
  pluginId: string;
  placeholder?: string;
  onActivity?: (active: boolean) => void;
  /** Only enabled by the current holder in AUTO_AI mode. */
  autoMode?: boolean;
}

/** Existing per-plugin automation; its lifetime follows the holder's mode.
 * Planning cannot be cancelled at the provider, so late plans are discarded.
 * The existing executor cooperatively stops before subsequent commands.
 */
export function MoaAssistant({ pluginId, onActivity, autoMode = false }: MoaAssistantProps) {
  const activity = useRef(onActivity);
  useEffect(() => { activity.current = onActivity; }, [onActivity]);

  useEffect(() => {
    const canonicalId = resolveCanonicalPluginId(pluginId);
    const actorId = webRTCManager.userId;
    if (!autoMode || !canonicalId || !actorId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let busy = false;
    const current = () => !signal.aborted && webRTCManager.userId === actorId;
    const run = async () => {
      if (busy || !current()) return;
      busy = true;
      activity.current?.(true);
      const input = moaTaskForPlugin(pluginId);
      try {
        const plan = await moaAgent.plan(`${pluginId}: ${input}`);
        if (!current()) return;
        const proposed: MoaStep[] = plan.steps.length ? plan.steps : [{ pluginId, command: input, prompt: input }];
        // A plugin's KI switch delegates only this plugin, never the whole rack.
        const steps = proposed.filter(step => resolveCanonicalPluginId(step.pluginId) === canonicalId)
          .map(step => ({ ...step, pluginId: canonicalId }));
        const { results } = await moaAgent.executePlanGated({ ...plan, steps }, actorId,
          step => current() && resolveCanonicalPluginId(step.pluginId) === canonicalId, { signal });
        const entries = results.map(r => `${r.handled ? '✓' : '✗'} ${r.pluginId || r.step.pluginId}: ${r.step.command}${r.error ? ` (${r.error})` : ''}`);
        if (entries.length) {
          const key = `moa-log-${pluginId}`;
          storageSetJson(key, [...(storageGetJson<string[]>(key) ?? []), ...entries.map(e => `AUTO: ${e}`)].slice(-5));
          moaHistory.add({ pluginId, task: input, provider: plan.provider, results: entries, at: Date.now() });
        }
      } catch (error) {
        if (current()) {
          const msg = `Fehler: ${error instanceof Error ? error.message : String(error)}`;
          moaHistory.add({ pluginId, task: input, provider: 'error', results: [msg], at: Date.now() });
        }
      } finally {
        busy = false;
        if (current()) activity.current?.(false);
      }
    };
    const first = window.setTimeout(() => { void run(); }, 2500);
    const interval = window.setInterval(() => { void run(); }, 90000);
    return () => {
      controller.abort();
      window.clearTimeout(first);
      window.clearInterval(interval);
      // Activity is an indicator, never a write to the selected plugin mode.
      activity.current?.(false);
    };
  }, [autoMode, pluginId]);

  return null;
}
