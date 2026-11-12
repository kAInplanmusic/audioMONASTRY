/** Provider control plane only. Audio/model APIs retain their shared contract. */
import providerConfig from '../../../../deploy/gpu-provider.json';
function env(name: string): string {
  return typeof process === 'undefined' ? '' : (process.env[name] ?? '').trim();
}
export function usesVast(): boolean {
  const provider = env('AI_GPU_PROVIDER') || providerConfig.provider;
  if (provider !== 'vast') throw new Error('Unknown GPU provider');
  return true;
}
export function gpuControlKey(): string {
  return env('VAST_API_KEY');
}
export function gpuControlUrl(id: string, action = false): string {
  return `https://console.vast.ai/api/v0/instances/${encodeURIComponent(id)}/`;
}
export function gpuAction(action: 'start' | 'stop'): { method: string; body: string } {
  return usesVast() ? { method: 'PUT', body: JSON.stringify({ state: action === 'start' ? 'running' : 'stopped' }) }
    : { method: 'POST', body: JSON.stringify({ action }) };
}
