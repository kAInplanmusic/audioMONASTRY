import { expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { RoleContext } from './types';

export async function runRole({page,pages,directory,record}:RoleContext) {
 for(let i=0;!existsSync(directory+'/dj-audio-ready.json')&&i<3000;i++)await new Promise(r=>setTimeout(r,100));
 if(!existsSync(directory+'/dj-audio-ready.json'))throw new Error('DJ audio prerequisite failed');
 await expect(page.locator('#rack-mixer')).toHaveAttribute('data-plugin-owner','other');
 await page.getByRole('button',{name:'masterMONK An',exact:true}).click();
 await expect(page.locator('#rack-master')).toHaveAttribute('data-plugin-owner','me',{timeout:20000});
 await expect(page.locator('#rack-master')).toHaveAttribute('data-plugin-mode','ON',{timeout:20000});
 // Observe, without injecting settings, whether selection invokes the DJ engine.
 await pages.eq.evaluate(()=>{const w=window as any;const engine=w.__audioMonastry?.audioEngine;if(!engine)throw new Error('DJ engine unavailable');const original=engine.updateMasterMe;w.__r9MasterCalls=[];engine.updateMasterMe=function(...args:unknown[]){w.__r9MasterCalls.push({at:Date.now(),args});return original.apply(this,args);};});
 const preset=page.getByLabel('Mastering-Preset',{exact:true});
 await expect(preset).toBeVisible({timeout:30000});
 const options=await preset.locator('option').evaluateAll(items=>items.map(item=>({value:(item as HTMLOptionElement).value,text:item.textContent})).filter(item=>item.value));
 const selected=options[1]??options[0];if(!selected)throw new Error('No mastering preset available');
 await preset.selectOption(selected.value);
 record('master held and preset selected independently of DJ mixer',true,selected);
 for(const [role,observer] of Object.entries(pages))if(role!=='mastering') {
  await expect(observer.locator('#rack-master')).toHaveAttribute('data-plugin-mode','ON',{timeout:20000});
  await expect(observer.locator('#rack-master')).toHaveAttribute('data-plugin-owner','other',{timeout:20000});
 }
 // Upload through the real UI because the existing library list does not live-refresh across clients.
 await page.getByRole('button',{name:'biblioMONK An',exact:true}).click();
 await expect(page.locator('#rack-biblio')).toHaveAttribute('data-plugin-owner','me');
 const fixture=readFileSync(directory+'/fixture-song.wav');
 await page.locator('#rack-biblio input[type="file"]').first().setInputFiles({name:'r9-master-song.wav',mimeType:'audio/wav',buffer:fixture});
 await page.getByRole('button',{name:'soundMONK An',exact:true}).click();
 await expect(page.locator('#rack-sound')).toHaveAttribute('data-plugin-owner','me');
 await page.getByPlaceholder('Suche Samples & Musik…').fill('r9-master-song');
 const sample=page.getByRole('heading',{name:'r9-master-song',exact:true}).first();
 await sample.waitFor({timeout:90000});
 const menu=page.getByRole('menu',{name:'Audio-Aktionen'});
 for(let attempt=0;attempt<5;attempt++) {
  await sample.click();
  try {
   await menu.getByRole('menuitem',{name:/Send to Track/}).click({timeout:5000});
   const target=menu.getByRole('menuitem').filter({hasText:/^CH 7 ·/}).first();
   await expect(target).toBeEnabled({timeout:5000});await target.click();break;
  } catch(error) { if(attempt===4)throw error; }
 }
 await page.waitForFunction(()=>(window as any).__audioMonastry?.audioEngine?.isTrackLoaded('channel7')===true,undefined,{timeout:60000});
 await page.getByRole('button',{name:'biblioMONK Aus',exact:true}).click();
 await expect(page.locator('#rack-biblio')).toHaveAttribute('data-plugin-owner','none');
 await page.getByRole('button',{name:'soundMONK spielen',exact:true}).click();
 record('sound held and fixture loaded on own channel 7',true);
 const djMasterCalls=await pages.eq.evaluate(()=>(window as any).__r9MasterCalls);
 const dj=await pages.eq.evaluate(()=>({channel7Loaded:(window as any).__audioMonastry?.audioEngine?.isTrackLoaded('channel7')===true,preset:(document.querySelector('[aria-label="Mastering-Preset"]') as HTMLSelectElement|null)?.value??null}));
 const state=await page.evaluate(async()=>{const r=await fetch('/api/store');return {status:r.status,body:await r.text()};});
 const detail={selected,state,djMasterCalls,dj,mixerOwner:await page.locator('#rack-mixer').getAttribute('data-plugin-owner'),reason:'DJ baseline audio cannot establish that the separate sound source reached Main-Out or that the DJ engine applied the selected preset. Capture relay carries input events, not audio.'};
 writeFileSync(directory+'/mastering-integration-blocker.json',JSON.stringify(detail,null,2),{mode:0o600});
 const presetApplied=djMasterCalls.length>0;
 const sourceDelivered=dj.channel7Loaded;
 record('master preset applied to DJ engine',presetApplied,detail);
 record('own channel 7 source delivered to DJ engine',sourceDelivered,detail);
 expect(presetApplied && sourceDelivered).toBe(true);
}
