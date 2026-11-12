import { validateExecutorOutput } from './dawExecutor';
import type { MoaPlan } from './MoaAgent';

/** Same-origin authenticated command proposals; execution keeps existing locks. */
export async function requestDawPlan(task:string):Promise<MoaPlan> {
  const response=await fetch('/api/ai/executor',{
    method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
    body:JSON.stringify({task}),signal:AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`DAW-Steuerung fehlgeschlagen (HTTP ${response.status})`);
  const body=await response.json() as Record<string,unknown>;
  const checked=validateExecutorOutput(JSON.stringify({commands:body.commands}));
  if (body.ok !== true || !checked.ok) throw new Error('DAW-Steuerung lieferte keinen gültigen Befehl');
  return {task,provider:String(body.provider ?? 'local'),createdAt:Date.now(),raw:checked.json,
    steps:checked.commands.map(command=>({...command,prompt:task}))};
}
