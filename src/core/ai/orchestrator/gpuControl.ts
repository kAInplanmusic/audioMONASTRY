/** Provider control plane only. Audio/model APIs retain their shared contract. */
import providerConfig from '../../../../deploy/gpu-provider.json';
function env(name: string): string {
  return typeof process === 'undefined' ? '' : (process.env[name] ?? '').trim();
}
export function usesVast(): boolean {
  const provider = env('AI_GPU_PROVIDER') || providerConfig.provider;
  if (provider !== 'vast' && provider !== 'runpod') throw new Error('Unknown GPU provider');
  return provider === 'vast';
}
export function gpuControlKey(): string {
  return usesVast() ? env('VAST_API_KEY') : env('RP_AGENT_KEY') || env('RP_API_KEY') || env('RUNPOD_API_KEY');
}
export function gpuControlUrl(id: string, action = false): string {
  return usesVast() ? `https://console.vast.ai/api/v0/instances/${encodeURIComponent(id)}/`
    : `${(env('RUNPOD_REST_BASE') || 'https://api.runpod.io/v2').replace(/\/+$/, '')}/pods/${encodeURIComponent(id)}${action ? '/action' : ''}`;
}
export function gpuAction(action: 'start' | 'stop'): { method: string; body: string } {
  return usesVast() ? { method: 'PUT', body: JSON.stringify({ state: action === 'start' ? 'running' : 'stopped' }) }
    : { method: 'POST', body: JSON.stringify({ action }) };
}
