import { afterEach,expect,it,vi } from 'vitest';
import { requestDawPlan } from '../src/core/ai/clientDawExecutor';
afterEach(()=>vi.unstubAllGlobals());
it('uses the authenticated backend executor and validated canonical commands',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,provider:'vast-local',
    model:'qwen3-4b',commands:[{pluginId:'transport',command:'set_tempo(174)'}]})));
  vi.stubGlobal('fetch',fetch);
  const plan=await requestDawPlan('Tempo 174');
  expect(fetch.mock.calls[0][0]).toBe('/api/ai/executor');
  expect(fetch.mock.calls[0][1].credentials).toBe('same-origin');
  expect(plan.steps).toEqual([{pluginId:'transport',command:'set_tempo(174)',prompt:'Tempo 174'}]);
});
it('rejects invented commands before producing an executable plan',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,
    commands:[{pluginId:'system',command:'shell(arbitrary)'}]}))));
  await expect(requestDawPlan('test')).rejects.toThrow('keinen gültigen Befehl');
});
