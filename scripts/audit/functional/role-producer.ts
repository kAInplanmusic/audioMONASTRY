import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { RoleContext } from './types';
/** Fixed WAV through the actual library upload + mixer UI. No model call. */
export async function runRole({page,outputPage,pages,directory,record,deadline}:RoleContext) {
 await expect(page.locator('#rack-mixer')).toHaveAttribute('data-plugin-owner','me',{timeout:20000});
 record('producer owns Main-Out mixer',true);
 const fixture=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=650','-af','volume=0.5','-ar','8000','-ac','1','-c:a','pcm_s16le','-f','wav','pipe:1'],{maxBuffer:32*1024*1024});
 writeFileSync(directory+'/fixture-song.wav',fixture,{mode:0o600});
 record('fixed song fixture',true,{file:'fixture-song.wav',durationSeconds:650,sha256:createHash('sha256').update(fixture).digest('hex'),realInput:false,modelCall:false});
 await page.getByRole('button',{name:'biblioMONK An',exact:true}).click();
 await expect(page.locator('#rack-biblio')).toHaveAttribute('data-plugin-owner','me');
 await page.locator('#rack-biblio input[type="file"]').first().setInputFiles({name:'r8-fixed-song.wav',mimeType:'audio/wav',buffer:fixture});
 await page.getByPlaceholder('Suche Samples & Musik…').fill('r8-fixed-song');
 const sample=page.getByRole('heading',{name:'r8-fixed-song',exact:true}).first();
 await sample.waitFor({timeout:90000});
 record('fixture uploaded through real library UI',true);
 await page.getByRole('button',{name:'dropMONK An',exact:true}).click();
 await expect(page.locator('#rack-drop')).toHaveAttribute('data-plugin-owner','me');
 await sample.click();
 const menu=page.getByRole('menu',{name:'Audio-Aktionen'});
 await menu.getByRole('menuitem',{name:/Send to Track/}).click();
 const target=menu.getByRole('menuitem').filter({hasText:/^CH 1 ·/}).first();
 await expect(target).toBeEnabled();await target.click();
 await page.locator('#rack-mixer').getByRole('button',{name:/PLAY/i}).first().click();
 await page.waitForFunction(()=>(window as any).__audioMonastry?.audioEngine?.isTrackLoaded('channel1')===true,undefined,{timeout:60000});
 await page.getByRole('button',{name:'Kanal 1 auf Main spielen',exact:true}).click();
 record('fixture assigned CH1 and real PLAY clicked',true);
 writeFileSync(directory+'/producer-audio-ready.json',JSON.stringify({at:new Date().toISOString(),source:'actual uploaded WAV, UI play'}),{mode:0o600});
 for(const observer of Object.values(pages)) {
  await expect(observer.locator('#rack-drop')).toHaveAttribute('data-plugin-mode','ON');
  await expect(observer.locator('#rack-biblio')).toHaveAttribute('data-plugin-mode','ON');
 }
 record('producer plugin modes replicated to all four',true);
 await outputPage.waitForFunction(()=>{const s=(document.querySelector('audio')as HTMLAudioElement)?.srcObject;return s instanceof MediaStream&&s.getAudioTracks().some(t=>t.readyState==='live');},undefined,{timeout:45000});
 const start=outputPage.getByRole('button',{name:/Main-Ausgabe aktivieren|Audio starten|Starten|Start audio|PLAY/i}).first();
 if(await start.isVisible().catch(()=>false))await start.click();
 const rms=await outputPage.evaluate(async()=>{
  const audio=document.querySelector('audio')as HTMLAudioElement;
  const stream=audio.srcObject as MediaStream;
  await audio.play();const context=new AudioContext();await context.resume();
  const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);const silent=context.createGain();silent.gain.value=0;analyser.connect(silent);silent.connect(context.destination);
  const data=new Float32Array(analyser.fftSize);let squares=0,count=0,peak=0;const began=performance.now();
  while(performance.now()-began<5000){analyser.getFloatTimeDomainData(data);for(const v of data){squares+=v*v;count++;peak=Math.max(peak,Math.abs(v));}await new Promise(r=>setTimeout(r,40));}
  const result={rms:Math.sqrt(squares/Math.max(1,count)),peak,samples:count,windowMs:performance.now()-began,tracks:stream.getTracks().map(t=>t.kind)};
  await context.close();return result;
 });
 record('Main-Out analyser RMS positive over 5s',rms.rms>0,rms);
 expect(rms.tracks.every(t=>t==='audio')).toBe(true);
 record('Main-Out audio-only',true,rms.tracks);
 writeFileSync(directory+'/producer-rms.json',JSON.stringify(rms,null,2),{mode:0o600});
 // The mastering UI requires the real Main-Out holder. Transfer only after our
 // own audio measurement; a red Producer must not prevent independent Mastering assertions.
 while(!existsSync(directory+'/mastering-mixer-request.json')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,200));
 if(existsSync(directory+'/mastering-mixer-request.json')) {
  const request=JSON.parse(readFileSync(directory+'/mastering-mixer-request.json','utf8'));
  await page.getByRole('button',{name:'biblioMONK Aus',exact:true}).click();
  await expect(page.locator('#rack-biblio')).toHaveAttribute('data-plugin-owner','none');
  await page.getByRole('button',{name:'dropMONK Aus',exact:true}).click();
  await expect(page.locator('#rack-drop')).toHaveAttribute('data-plugin-owner','none');
  await page.getByLabel('mixerMONK übergeben',{exact:true}).selectOption(request.userId);
  await expect(page.locator('#rack-mixer')).toHaveAttribute('data-plugin-owner','other');
  record('real UI mixer transfer to Mastering after producer RMS measurement',true,{to:request.userId,producerRms:rms.rms});
  writeFileSync(directory+'/producer-mixer-transferred.json',JSON.stringify({to:request.userId,at:new Date().toISOString()}),{mode:0o600});
 }
 // Preserve a failed measured RMS and still execute the real handover before marking this role red.
 expect(rms.rms).toBeGreaterThan(0);
}
