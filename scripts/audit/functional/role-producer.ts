import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import type { RoleContext } from './types';

/** Producer owns dropMONK and shares a fixture; the DJ owns mixerMONK. */
export async function runRole({page,pages,directory,record}:RoleContext) {
 await expect(page.locator('#rack-mixer')).toHaveAttribute('data-plugin-owner','other',{timeout:20000});
 record('Producer sees DJ-owned mixer',true);
 const fixture=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=650','-af','volume=0.5','-ar','8000','-ac','1','-c:a','pcm_s16le','-f','wav','pipe:1'],{maxBuffer:32*1024*1024});
 writeFileSync(directory+'/fixture-song.wav',fixture,{mode:0o600});
 record('fixed song fixture',true,{file:'fixture-song.wav',durationSeconds:650,sha256:createHash('sha256').update(fixture).digest('hex'),realInput:false,modelCall:false});
 await page.getByRole('button',{name:'biblioMONK An',exact:true}).click();
 await expect(page.locator('#rack-biblio')).toHaveAttribute('data-plugin-owner','me');
 await page.locator('#rack-biblio input[type="file"]').first().setInputFiles({name:'r8-fixed-song.wav',mimeType:'audio/wav',buffer:fixture});
 await page.getByPlaceholder('Suche Samples & Musik…').fill('r8-fixed-song');
 await page.getByRole('heading',{name:'r8-fixed-song',exact:true}).first().waitFor({timeout:90000});
 record('fixture uploaded through real shared library UI',true);
 await page.getByRole('button',{name:'dropMONK An',exact:true}).click();
 await expect(page.locator('#rack-drop')).toHaveAttribute('data-plugin-owner','me');
 for(const observer of Object.values(pages)) {
  await expect(observer.locator('#rack-drop')).toHaveAttribute('data-plugin-mode','ON');
  await expect(observer.locator('#rack-biblio')).toHaveAttribute('data-plugin-mode','ON');
 }
 record('Producer plugin modes replicated to all four',true);
 // Observe actual outgoing client calls, including requests that the server may deny.
 await page.evaluate(() => {
  const manager=(window as any).__webRTCManager;
  if(!manager) throw new Error('WebRTC manager unavailable for lock-send observation');
  const original=manager.sendPluginLock.bind(manager);
  (window as any).__r9LockSends=[];
  manager.sendPluginLock=(id:string)=>{(window as any).__r9LockSends.push({id,at:Date.now()});return original(id);};
 });
 await page.getByRole('button',{name:'biblioMONK Aus',exact:true}).click();
 await expect(page.locator('#rack-biblio')).toHaveAttribute('data-plugin-mode','OFF');
 await expect(page.locator('#rack-biblio')).toHaveAttribute('data-plugin-owner','none');
 const observedAt=Date.now();
 const journal=directory+'/producer-biblio-observation.ndjson';
 let healthy=true;
 do {
  const capture=async(path:string)=>{
   try {const response=await fetch(new URL(path,page.url()),{headers:{'x-studio-token':process.env.STUDIO_ACCESS_TOKEN ?? 'r8-local-functional'}});return {status:response.status,body:await response.text()};}
   catch(error){return {status:0,body:String(error)};}
  };
  const [state,audit]=await Promise.all([capture('/api/session/state'),capture('/api/audit')]);
  const ui=await page.locator('#rack-biblio').evaluate(el=>({mode:el.getAttribute('data-plugin-mode'),owner:el.getAttribute('data-plugin-owner')}));
  const mixer=await page.locator('#rack-mixer').getAttribute('data-plugin-owner');
  const sends=await page.evaluate(()=>(window as any).__r9LockSends.filter((event:any)=>event.id==='biblio'));
  appendFileSync(journal,JSON.stringify({at:new Date().toISOString(),state,audit,ui,mixer,sends})+'\n',{mode:0o600});
  if(state.status!==200||audit.status!==200||ui.mode!=='OFF'||ui.owner!=='none'||mixer!=='other'||sends.length)healthy=false;
  if(Date.now()-observedAt<60000)await new Promise(r=>setTimeout(r,Math.min(5000,60000-(Date.now()-observedAt))));
 } while(Date.now()-observedAt<60000);
 const sends=await page.evaluate(()=>(window as any).__r9LockSends.filter((event:any)=>event.id==='biblio'));
 if(sends.length)healthy=false;
 record('biblio OFF and unlocked 60s with no Producer lock sends; DJ retains mixer',healthy,{durationMs:Date.now()-observedAt,sends,journal:'producer-biblio-observation.ndjson'});
 writeFileSync(directory+'/producer-library-observed.json',JSON.stringify({at:new Date().toISOString(),healthy}),{mode:0o600});
 expect(healthy).toBe(true);
}
