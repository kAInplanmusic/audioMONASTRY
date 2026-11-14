import { expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { RoleContext } from './types';
export async function runRole(ctx: RoleContext) {
 const {page, outputPage, directory, record} = ctx;
 await expect(page.locator('#rack-mixer')).toHaveAttribute('data-plugin-owner','me',{timeout:30000});
 record('DJ/EQ owns mixerMONK',true);
 const row=ctx.page.locator('#rack-eq');
 await ctx.page.getByRole('button',{name:'eqMONK An',exact:true}).click();
 await expect(row).toHaveAttribute('data-plugin-mode','ON',{timeout:30000});
 await expect(row).toHaveAttribute('data-plugin-owner','me');
 ctx.record('EQ hold and ON',true,{owner:'me',mode:'ON'});
 const preset=ctx.page.getByLabel('EQ-Preset',{exact:true});
 await expect(preset).toBeVisible({timeout:30000});
 await expect(preset.locator('option')).not.toHaveCount(0,{timeout:30000});
 const options=await preset.locator('option').evaluateAll(items=>items.map(item=>({value:(item as HTMLOptionElement).value,text:item.textContent})).filter(item=>item.value));
 const selected=options.find(option=>!/flat|neutral/i.test(option.text??''))??options[0];
 if(!selected)throw new Error('No actual EQ preset available');
 await preset.selectOption(selected.value);
 await expect(row).toContainText(/Peak\s+[1-9]/,{timeout:15000});
 ctx.record('EQ preset applied through UI',true,selected);
 for(const [role,page]of Object.entries(ctx.pages))if(role!=='eq'){
  await expect(page.locator('#rack-eq')).toHaveAttribute('data-plugin-mode','ON',{timeout:20000});
  await expect(page.locator('#rack-eq')).toHaveAttribute('data-plugin-owner','other');
  for(const label of ['An','Aus','KI-gesteuert']){
   const button=page.getByRole('button',{name:`eqMONK ${label}`,exact:true});
   await expect(button).toBeDisabled();
   await button.evaluate((element:HTMLButtonElement)=>element.click());
  }
  await expect(row).toHaveAttribute('data-plugin-owner','me');
  await expect(row).toHaveAttribute('data-plugin-mode','ON');
  ctx.record(`EQ foreign controls blocked for ${role}`,true,{mode:'ON',owner:'other',disabledClickDidNotMutate:true});
 }
 // The Producer completes the unlocked observation before the DJ takes biblio.
 while(!existsSync(directory+'/producer-library-observed.json') && Date.now()<ctx.deadline) await page.waitForTimeout(200);
 if(!existsSync(directory+'/producer-library-observed.json') || !JSON.parse(readFileSync(directory+'/producer-library-observed.json','utf8')).healthy) throw new Error('Producer biblio observation failed or missing');
 await page.getByRole('button',{name:'biblioMONK An',exact:true}).click();
 await expect(page.locator('#rack-biblio')).toHaveAttribute('data-plugin-owner','me');
 // This client loads the same fixture through its own UI; the upload list is
 // loaded on mount, so this does not claim automatic library refresh.
 await page.locator('#rack-biblio input[type="file"]').first().setInputFiles(directory+'/fixture-song.wav');
 await page.getByPlaceholder('Suche Samples & Musik…').fill('fixture-song');
 const sample=page.getByRole('heading',{name:'fixture-song',exact:true}).first();
 await sample.waitFor({timeout:60000});
 const menu=page.getByRole('menu',{name:'Audio-Aktionen'});
 for(let attempt=0;attempt<5;attempt++) {
  await sample.click();
  try {
   await menu.getByRole('menuitem',{name:/Send to Track/}).click({timeout:5000});
   const target=menu.getByRole('menuitem').filter({hasText:/^CH 1 ·/}).first();
   await expect(target).toBeEnabled({timeout:5000}); await target.click({timeout:5000}); break;
  } catch(error) { if(attempt===4) throw error; }
 }
 await page.waitForFunction(()=>(window as any).__audioMonastry?.audioEngine?.isTrackLoaded('channel1')===true,undefined,{timeout:60000});
 await page.locator('#rack-mixer').getByRole('button',{name:/PLAY/i}).first().click();
 await page.getByRole('button',{name:'Kanal 1 auf Main spielen',exact:true}).click();
 record('DJ separately uploads same fixed WAV and loads CH1 through UI',true,{file:'fixture-song.wav',automaticLibraryRefresh:false});
 await page.getByRole('button',{name:'biblioMONK Aus',exact:true}).click();
 await expect(page.locator('#rack-biblio')).toHaveAttribute('data-plugin-owner','none');
 await outputPage.waitForFunction(()=>{const s=(document.querySelector('audio')as HTMLAudioElement)?.srcObject;return s instanceof MediaStream&&s.getAudioTracks().some(t=>t.readyState==='live');},undefined,{timeout:45000});
 const start=outputPage.getByRole('button',{name:/Main-Ausgabe aktivieren|Audio starten|Starten|Start audio|PLAY/i}).first();
 if(await start.isVisible().catch(()=>false))await start.click();
 const rms=await outputPage.evaluate(async()=>{
  const audio=document.querySelector('audio') as HTMLAudioElement,stream=audio.srcObject as MediaStream;
  await audio.play();const context=new AudioContext();await context.resume();
  const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);const silent=context.createGain();silent.gain.value=0;analyser.connect(silent);silent.connect(context.destination);
  const data=new Float32Array(analyser.fftSize);let squares=0,count=0,peak=0;const began=performance.now();
  while(performance.now()-began<5000){analyser.getFloatTimeDomainData(data);for(const v of data){squares+=v*v;count++;peak=Math.max(peak,Math.abs(v));}await new Promise(r=>setTimeout(r,40));}
  const result={rms:Math.sqrt(squares/Math.max(1,count)),peak,samples:count,windowMs:performance.now()-began,tracks:stream.getTracks().map(t=>t.kind)};
  await context.close();return result;
 });
 record('same fixed WAV reaches Main-Out over 5s',rms.rms>0,rms);
 expect(rms.rms).toBeGreaterThan(0);expect(rms.tracks.every(t=>t==='audio')).toBe(true);
 writeFileSync(directory+'/producer-rms.json',JSON.stringify(rms,null,2),{mode:0o600});
 writeFileSync(directory+'/producer-audio-ready.json',JSON.stringify({at:new Date().toISOString(),source:'same fixture separately uploaded by DJ via UI',automaticLibraryRefresh:false}),{mode:0o600});
 writeFileSync(directory+'/dj-audio-ready.json',JSON.stringify({at:new Date().toISOString()}),{mode:0o600});

}
