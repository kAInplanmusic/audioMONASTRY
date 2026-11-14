import { expect } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import type { RoleContext } from './types';
export async function runRole(ctx: RoleContext) {
 const { page, pages, outputPage, directory, record } = ctx;
 const userId=await page.evaluate(()=>(window as any).__webRTCManager?.userId);
 if(!userId)throw new Error('Mastering user identity missing');
 writeFileSync(directory+'/mastering-mixer-request.json',JSON.stringify({userId,at:new Date().toISOString(),reason:'masterMONK requires current mixer holder'}),{mode:0o600});
 for(let i=0;!existsSync(directory+'/producer-rms.json')&&i<1200;i++)await new Promise(r=>setTimeout(r,100));
 if(!existsSync(directory+'/producer-rms.json'))throw new Error('Producer fixture audio/RMS prerequisite failed; mastering cannot claim signal');
 await expect(page.locator('#rack-mixer')).toHaveAttribute('data-plugin-owner','me',{timeout:90000});
 record('server-authorized mixer transfer received',true,{userId});
 // A new Main-Out owner uses its own audio engine. Load the same persisted
 // fixture via the real shared library UI after Producer releases those locks.
 await page.getByRole('button',{name:'biblioMONK An',exact:true}).click();
 await expect(page.locator('#rack-biblio')).toHaveAttribute('data-plugin-owner','me');
 await page.getByRole('button',{name:'dropMONK An',exact:true}).click();
 await expect(page.locator('#rack-drop')).toHaveAttribute('data-plugin-owner','me');
 await page.getByPlaceholder('Suche Samples & Musik…').fill('r8-fixed-song');
 const sample=page.getByRole('heading',{name:'r8-fixed-song',exact:true}).first();
 await sample.waitFor({timeout:30000});await sample.click();
 const menu=page.getByRole('menu',{name:'Audio-Aktionen'});
 await menu.getByRole('menuitem',{name:/Send to Track/}).click();
 const target=menu.getByRole('menuitem').filter({hasText:/^CH 1 ·/}).first();
 await expect(target).toBeEnabled();await target.click();
 await page.waitForFunction(()=>(window as any).__audioMonastry?.audioEngine?.isTrackLoaded('channel1')===true,undefined,{timeout:60000});
 record('persisted producer fixture loaded into new owner via actual library UI',true);
 const row=page.locator('#rack-master');
 await page.getByRole('button',{name:'masterMONK An',exact:true}).click();
 await expect(row).toHaveAttribute('data-plugin-mode','ON',{timeout:20000});
 await expect(row).toHaveAttribute('data-plugin-owner','me');
 const preset=page.getByLabel('Mastering-Preset',{exact:true});
 await expect(preset).toBeVisible({timeout:30000});
 await expect(preset.locator('option')).not.toHaveCount(0,{timeout:30000});
 const options=await preset.locator('option').evaluateAll(items=>items.map(item=>({value:(item as HTMLOptionElement).value,text:item.textContent})).filter(item=>item.value));
 const selected=options[1]??options[0];if(!selected)throw new Error('No actual mastering preset available');
 await preset.selectOption(selected.value);
 record('mastering held and preset applied via UI',true,selected);
 for(const [role,observer]of Object.entries(pages))if(role!=='mastering'){
  await expect(observer.locator('#rack-master')).toHaveAttribute('data-plugin-mode','ON',{timeout:20000});
  await expect(observer.locator('#rack-master')).toHaveAttribute('data-plugin-owner','other');
  const foreign=observer.getByRole('button',{name:'masterMONK Aus',exact:true});await expect(foreign).toBeDisabled();
  await foreign.evaluate((button:HTMLButtonElement)=>button.click());
  await expect(row).toHaveAttribute('data-plugin-mode','ON');await expect(row).toHaveAttribute('data-plugin-owner','me');
  record(`master mode replicated and foreign write blocked for ${role}`,true);
 }
 await page.locator('#rack-mixer').getByRole('button',{name:/PLAY/i}).first().click();
 await page.getByRole('button',{name:'Kanal 1 auf Main spielen',exact:true}).click();
 await outputPage.waitForFunction(()=>{const stream=(document.querySelector('audio')as HTMLAudioElement)?.srcObject;return stream instanceof MediaStream&&stream.getAudioTracks().some(t=>t.readyState==='live');},undefined,{timeout:20000});
 const rms=await outputPage.evaluate(async()=>{
  const audio=document.querySelector('audio')as HTMLAudioElement;const stream=audio.srcObject as MediaStream;
  await audio.play();const context=new AudioContext();await context.resume();const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);const silent=context.createGain();silent.gain.value=0;analyser.connect(silent);silent.connect(context.destination);
  const data=new Float32Array(analyser.fftSize);let sum=0,count=0,peak=0;const start=performance.now();
  while(performance.now()-start<5000){analyser.getFloatTimeDomainData(data);for(const x of data){sum+=x*x;count++;peak=Math.max(peak,Math.abs(x));}await new Promise(r=>setTimeout(r,40));}
  const result={rms:Math.sqrt(sum/Math.max(1,count)),peak,samples:count,windowMs:performance.now()-start,tracks:stream.getTracks().map(t=>t.kind)};await context.close();return result;
 });
 writeFileSync(directory+'/mastering-rms.json',JSON.stringify(rms,null,2),{mode:0o600});
 record('Main-Out signal after mastering over5s',rms.rms>0,rms);expect(rms.rms).toBeGreaterThan(0);
}
