import { describe,expect,it } from 'vitest';
import { VoiceControlService } from '../src/core/voice/VoiceControlService';
import { parseCatalogEntry } from '../src/core/ai/dawExecutor';
import { PLUGIN_COMMAND_CATALOG } from '../src/utils/prompts';
import { EXECUTOR_EVAL_SET } from '../src/core/ai/orchestrator/executorEvalSet';
import cases from '../scripts/production/executor-cases.json';

describe('validated executor commands reach plugin handlers with actual arguments',()=>{
  it('keeps the live 50-case acceptance data in sync with the canonical eval set',()=>{
    expect(cases).toEqual(EXECUTOR_EVAL_SET);
  });
  it('dispatches every canonical plugin family and preserves numeric/text arguments',async()=>{
    const service=new VoiceControlService();
    const captured:Array<{pluginId:string;action:string;parameters:Record<string,number|string>}>=[];
    for (const [pluginId,catalog] of Object.entries(PLUGIN_COMMAND_CATALOG)) {
      for (const spec of parseCatalogEntry(catalog)) service.registerPluginCommand(pluginId,spec.name,ctx=>{
        captured.push({pluginId,action:spec.name,parameters:ctx.intent.parameters});
      });
    }
    for (const entry of EXECUTOR_EVAL_SET) for (const command of entry.expected) {
      const result=await service.executePluginCommand('test-user',command.pluginId,command.command);
      expect(result.handled,entry.id).toBe(true);
    }
    expect(new Set(captured.map(row=>row.pluginId)).size).toBe(Object.keys(PLUGIN_COMMAND_CATALOG).length);
    expect(captured).toContainEqual({pluginId:'transport',action:'set_tempo',parameters:{bpm:174}});
    expect(captured).toContainEqual({pluginId:'mixer',action:'gain',parameters:{db:-6}});
    expect(captured).toContainEqual({pluginId:'voice',action:'speak',parameters:{text:'Willkommen im Kloster'}});
    expect(captured).toContainEqual({pluginId:'spatial',action:'setup',parameters:{id:'7.1'}});
  });
  it('rejects malformed catalog arguments before invoking a handler',async()=>{
    const service=new VoiceControlService();let invoked=false;
    service.registerPluginCommand('transport','set_tempo',()=>{invoked=true});
    expect((await service.executePluginCommand('test-user','transport','set_tempo(broken)')).handled).toBe(false);
    expect(invoked).toBe(false);
  });
});
