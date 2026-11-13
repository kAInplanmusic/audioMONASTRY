import { DawExecutor } from '../../src/core/ai/dawExecutor';
import { EXECUTOR_EVAL_SET } from '../../src/core/ai/orchestrator/executorEvalSet';
import { PLUGIN_COMMAND_CATALOG } from '../../src/utils/prompts';
import holdout from './executor-holdout-cases.json';
const base=process.env.EXECUTOR_POD_URL ?? '';
if (!base.startsWith('https://')) throw new Error('EXECUTOR_TLS_REQUIRED');
const executor=new DawExecutor(async request=>{
  const response=await fetch(base+'/infer',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.AI_POD_TOKEN},
    body:JSON.stringify({task:'gui.execute',model:'qwen3-4b',input:{instruction:request.prompt,
      format:'daw_commands',allowedPluginCommands:PLUGIN_COMMAND_CATALOG,maxTokens:request.maxTokens ?? 256}}),
    signal:AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error('EXECUTOR_HTTP_'+response.status);
  const body=await response.json() as {status?:string;model?:string;result?:{text?:string}};
  if (body.status!=='success' || typeof body.result?.text!=='string') throw new Error('EXECUTOR_RESPONSE_INVALID');
  return {provider:'vast-local',model:'qwen3-4b',text:body.result.text,latencyMs:0};
});
const rows=[];
const cases=[...EXECUTOR_EVAL_SET,...holdout];
const normalize=(value:unknown)=>String(JSON.stringify(value)).toLocaleLowerCase('de-DE').replace(/\s+/g,' ').trim();
for (const item of cases) {
  const started=Date.now();
  const result=await executor.run(item.task);
  rows.push({id:item.id,valid:result.ok,passed:result.ok && normalize(result.commands)===normalize(item.expected),
    exactLiteral:JSON.stringify(result.commands)===JSON.stringify(item.expected),
    observedCommands:result.commands,expectedCommands:item.expected,elapsedMs:Date.now()-started});
  if (rows.length>=3 && !rows.some(row=>row.valid)) break;
}
console.log(JSON.stringify({passed:rows.length===cases.length && rows.every(row=>row.passed),
  model:'qwen3-4b',cases:cases.length,completed:rows.length,
  baselineCases:EXECUTOR_EVAL_SET.length,holdoutCases:holdout.length,
  plugins:[...new Set(cases.flatMap(item=>item.expected.map(command=>command.pluginId)))].sort(),
  comparison:'same canonical commands, ignoring case and whitespace only',rows}));
