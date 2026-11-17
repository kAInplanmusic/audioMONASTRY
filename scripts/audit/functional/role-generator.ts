import { expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import type { RoleContext } from './types';

/** Deterministic TEST provider only. Delegation/locks are real server traffic. */
function fixtureWav(): Buffer {
 const rate=48000, samples=rate, data=Buffer.alloc(44+samples*2);
 data.write('RIFF',0);data.writeUInt32LE(36+samples*2,4);data.write('WAVEfmt ',8);
 data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);
 data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);
 data.write('data',36);data.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)data.writeInt16LE(Math.round(Math.sin(2*Math.PI*330*i/rate)*2500),44+i*2);
 return data;
}
export async function runRole(ctx: RoleContext) {
 const row=ctx.page.locator('#rack-song');
 const wav=fixtureWav();let requests=0;
 await ctx.page.route('**/api/ai/complete', async route=>{
  const body=route.request().postDataJSON();
  appendFileSync(ctx.directory+'/generator-provider-fixture.ndjson',JSON.stringify({kind:'planning',at:new Date().toISOString(),testFixture:true,promptContainsSong:String(body?.prompt??'').includes('song')})+'\n',{mode:0o600});
  await route.fulfill({json:{provider:'r8-deterministic-TEST-fixture-no-inference',model:'fixture',text:JSON.stringify([{pluginId:'song',command:'generate(R8 fixed functional fixture song)',prompt:'R8 fixed functional fixture song'}])}});
 });
 await ctx.page.route('**/api/song/generate',async route=>{
  requests++;const body=route.request().postDataJSON();
  appendFileSync(ctx.directory+'/generator-provider-fixture.ndjson',JSON.stringify({kind:'song-request',request:requests,at:new Date().toISOString(),testFixture:true,body})+'\n',{mode:0o600});
  ctx.record('song generation requested against deterministic TEST audio provider',true,{request:requests,provider:'fixture; no GPU or cloud inference',prompt:body?.prompt});
  await route.fulfill({status:200,contentType:'audio/wav',body:wav,headers:{'x-r8-test-provider':'deterministic-fixture-not-inference'}});
 });
 await ctx.page.getByRole('button',{name:'songMONK An',exact:true}).click();
 await expect(row).toHaveAttribute('data-plugin-mode','ON',{timeout:30000});
 await expect(row).toHaveAttribute('data-plugin-owner','me');
 ctx.record('songMONK acquired through real UI',true,{mode:'ON',owner:'me'});
 for(const [role,page]of Object.entries(ctx.pages))if(role!=='generator'){
  const foreign=page.locator('#rack-song');
  await expect(foreign).toHaveAttribute('data-plugin-mode','ON',{timeout:20000});
  await expect(foreign).toHaveAttribute('data-plugin-owner','other');
  const button=page.getByRole('button',{name:'songMONK An',exact:true});
  await expect(button).toBeDisabled();await button.evaluate((element:HTMLButtonElement)=>element.click());
  await expect(row).toHaveAttribute('data-plugin-owner','me');
  ctx.record(`song human foreign lock prevents mutation for ${role}`,true);
 }
 await ctx.page.getByRole('button',{name:'songMONK KI-gesteuert',exact:true}).click();
 await expect(row).toHaveAttribute('data-plugin-mode','AI',{timeout:30000});
 await expect(row).toHaveAttribute('data-plugin-owner','none');
 const grant=await ctx.page.evaluate(()=>{const manager=(window as any).__webRTCManager;return manager?.getPluginDelegation('song')??null;});
 expect(grant).not.toBeNull();expect(grant.pluginId).toBe('song');expect(grant.generationId).toBeTruthy();
 const userId=await ctx.page.evaluate(()=>(window as any).__webRTCManager.userId);
 expect(grant.delegatedBy).toBe(userId);
 ctx.record('real R5 delegation exists and human lock released',true,{pluginId:grant.pluginId,delegatedBy:grant.delegatedBy,generationId:grant.generationId,issuedAt:grant.issuedAt,expiresAt:grant.expiresAt,owner:'none'});
 for(const [role,page]of Object.entries(ctx.pages)){
  await expect(page.locator('#rack-song')).toHaveAttribute('data-plugin-mode','AI',{timeout:20000});
  await expect(page.locator('#rack-song')).toHaveAttribute('data-plugin-owner','none');
  ctx.record(`song KI mode replicated to ${role}`,true);
  if(role!=='generator'){
   const permitted=await page.evaluate(async record=>(window as any).__webRTCManager.validatePluginDelegation(record,'song'),grant);
   expect(permitted).toBe(false);
   ctx.record(`foreign actor cannot use generator delegation: ${role}`,true,{serverAuthorized:false});
  }
 }
 await expect.poll(()=>requests,{timeout:30000}).toBeGreaterThan(0);
 await expect(row).toContainText('✓ Song erzeugt',{timeout:20000});
 await expect(row.locator('[aria-label="Erzeugte Songs"] [role="option"]')).not.toHaveCount(0);
 ctx.record('delegated generation produces UI playlist result using fixture provider',true,{provider:'deterministic TEST WAV; no inference claim',humanLockReleased:true});
}
