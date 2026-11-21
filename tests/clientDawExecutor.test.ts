import { afterEach,expect,it,vi } from 'vitest';
import { requestDawPlan } from '../src/core/ai/clientDawExecutor';
afterEach(()=>vi.unstubAllGlobals());
it('uses the authenticated backend executor and validated canonical commands',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,provider:'vast-local',
    model:'qwen3-4b',commands:[{pluginId:'transport',command:'set_tempo(174)'}]})));
  vi.stubGlobal('fetch',fetch);
  const plan=await requestDawPlan('Stelle das Tempo auf 174 BPM');
  expect(fetch.mock.calls[0][0]).toBe('/api/ai/executor');
  expect(fetch.mock.calls[0][1].credentials).toBe('same-origin');
  expect(plan.steps).toEqual([{pluginId:'transport',command:'set_tempo(174)',prompt:'Stelle das Tempo auf 174 BPM'}]);
});
it('rejects invented commands before producing an executable plan',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,
    commands:[{pluginId:'system',command:'shell(arbitrary)'}]}))));
  await expect(requestDawPlan('test')).rejects.toThrow('keinen gültigen Befehl');
});

it.each([
  ['Equalizer Blitz Pass zwei höher', 'eq', 'shift_gain(1-3, 2)'],
  ['EQ Band 5 bis 8 um 1,5 dB tiefer', 'eq', 'shift_gain(5-8, -1.5)'],
  ['Master EQ Bass zwei höher', 'master', 'shift_gain(1-3, 2)'],
  ['Lokal Tempo 128 BPM', 'transport', 'set_tempo(128)'],
  ['Transport Stopp', 'transport', 'stop'],
  ['Mixer Pegel -6 dB', 'mixer', 'gain(-6)'],
])('resolves %s without a backend or simulator', async (task, pluginId, command) => {
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetch);
  const plan = await requestDawPlan(task);
  expect(plan.provider).toBe('local-rules');
  expect(plan.steps).toEqual([{ pluginId, command, prompt: task }]);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['EQ Band 37 drei höher', 'EQ Bass 15 höher', 'EQ Bass drei höher und abspielen',
  'Lokal beschreibe den Track', 'EQ Band 8 bis 3 zwei tiefer'])('rejects the invalid local intent %s', async task => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(requestDawPlan(task)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
