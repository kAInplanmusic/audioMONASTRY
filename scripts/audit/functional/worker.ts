/** One actual agent executes one worker. Role labels alone do not attest agent count. */
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { existsSync,mkdirSync,readFileSync,writeFileSync,appendFileSync } from 'node:fs';
import type { FunctionalRole,AssertionResult,RoleContext } from './types';
const role=process.argv[2] as FunctionalRole;
if(!['producer','generator','mastering','eq'].includes(role))throw new Error('Fixed functional role required');
const directory='/workspace/work/r8-data/functional';mkdirSync(directory,{recursive:true,mode:0o700});
const journal=directory+'/'+role+'-journal.ndjson';
const assertions:AssertionResult[]=[];const errors:string[]=[];
let workerStartedAt: number | null = null;
for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal,()=>{writeFileSync(directory+'/'+role+'-result.json',JSON.stringify({role,executorAgent:process.env.R8_EXECUTOR_AGENT??'unattributed',status:'interrupted',phase:workerStartedAt===null?'startup':'running',startedAt:workerStartedAt,endedAt:Date.now(),durationSeconds:workerStartedAt===null?0:(Date.now()-workerStartedAt)/1000,assertions,errors:[...errors,'Actual worker interrupted by '+signal],scope:'incomplete functional smoke; never B3'},null,2),{mode:0o600});process.exit(143);});
process.on('uncaughtException',error=>{writeFileSync(directory+'/'+role+'-result.json',JSON.stringify({role,executorAgent:process.env.R8_EXECUTOR_AGENT??'unattributed',status:'blocked',phase:'startup',durationSeconds:0,assertions,errors:[error.stack??error.message],scope:'functional smoke not started; never B3'},null,2),{mode:0o600});console.error(error);process.exit(1);});
const record=(assertion:string,passed:boolean,detail?:unknown)=>{const row={assertion,passed,detail,at:new Date().toISOString()};assertions.push(row);appendFileSync(journal,JSON.stringify(row)+'\n',{mode:0o600});};
const browser=await chromium.connectOverCDP('http://127.0.0.1:9240');
const all=browser.contexts().flatMap(context=>context.pages());
const roles=['producer','generator','mastering','eq']as FunctionalRole[];
const pages=Object.fromEntries(roles.map(name=>[name,all.find(page=>new URL(page.url()).searchParams.get('r8Role')===name)]))as Record<FunctionalRole,import('playwright').Page>;
const page=pages[role],outputPage=all.find(page=>new URL(page.url()).searchParams.get('r8Role')==='output');
if(!page||!outputPage)throw new Error('Shared setup missing assigned role/output page');
page.on('pageerror',e=>{errors.push(e.message);appendFileSync(journal,JSON.stringify({type:'pageerror',error:e.message,at:new Date().toISOString()})+'\n');});
// Establish producer's first join, then synchronize ALL role actions at one barrier.
if(role!=='producer')for(let i=0;!existsSync(directory+'/producer-login.json')&&i<600;i++)await new Promise(r=>setTimeout(r,100));
if(role!=='producer'&&!existsSync(directory+'/producer-login.json'))throw new Error('Producer login prerequisite missing; shared smoke cannot start');
if(await page.getByRole('button',{name:/Studio betreten/}).isVisible())await page.getByRole('button',{name:/Studio betreten/}).click();
await expect(page.locator('#ai-monk-dock')).toBeVisible({timeout:60000});
const userId=await page.evaluate(()=>(window as any).__webRTCManager?.userId??null);
writeFileSync(directory+'/'+role+'-login.json',JSON.stringify({role,userId,at:new Date().toISOString()}),{mode:0o600});
record('real app open and login',true,{url:page.url(),userId});
writeFileSync(directory+'/'+role+'-ready.json',JSON.stringify({role,userId,at:new Date().toISOString()}),{mode:0o600});
for(let i=0;!existsSync(directory+'/start.json')&&i<6000;i++)await new Promise(r=>setTimeout(r,100));
if(!existsSync(directory+'/start.json'))throw new Error('Common start barrier missing; cannot claim synchronized10min');
const barrier:{startAt:number;durationSeconds:number}=JSON.parse(readFileSync(directory+'/start.json','utf8'));
if(barrier!.durationSeconds!==600)throw new Error('Functional smoke must run600 real seconds');
await new Promise(r=>setTimeout(r,Math.max(0,barrier!.startAt-Date.now())));
const startedAt=Date.now();workerStartedAt=startedAt;const deadline=barrier!.startAt+600000;
try{
 await expect(page.locator('#ai-monk-dock').getByRole('textbox')).toHaveCount(1);
 record('exactly one aiMONK input',true);
 const module=await import(`./role-${role}.ts`);
 const ctx:RoleContext={role,page,pages,outputPage,directory,startedAt,deadline,record};
 try{await module.runRole(ctx);}catch(error){const message=error instanceof Error?error.stack??error.message:String(error);errors.push(message);record('role action',false,message);}
 while(Date.now()<deadline){
  try{await expect(page.locator('#ai-monk-dock').getByRole('textbox')).toHaveCount(1);record('aiMONK remains one input',true);}catch(error){errors.push(String(error));record('aiMONK remains one input',false,String(error));}
  await new Promise(r=>setTimeout(r,Math.min(10000,Math.max(0,deadline-Date.now()))));
 }
 const outputTracks=await outputPage.evaluate(()=>{const stream=(document.querySelector('audio')as HTMLAudioElement)?.srcObject as MediaStream|null;return stream?stream.getTracks().map(track=>({kind:track.kind,readyState:track.readyState})):[];});
 record('Main-Out receives audio only',outputTracks.length>0&&outputTracks.every(track=>track.kind==='audio'),outputTracks);
}catch(error){errors.push(String(error));record('worker',false,String(error));}
const endedAt=Date.now();
const report={role,action:'role-specific UI action; see assertions',executorAgent:process.env.R8_EXECUTOR_AGENT??'unattributed',mode:'functional-smoke-not-B3',startedAt,endedAt,durationSeconds:(endedAt-startedAt)/1000,barrier,assertions,errors,status:assertions.every(a=>a.passed)&&errors.length===0?'pass':'fail',scope:'four local browser contexts; no human B3, WAN, input or PA latency proof'};
writeFileSync(directory+'/'+role+'-result.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
// Shared browser belongs to setup. Exiting this worker disconnects only its CDP client.
process.exit(report.status==='pass'?0:1);
