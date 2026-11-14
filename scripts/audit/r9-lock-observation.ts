/** Observe actual client requests and server state; does not inject lock events. */
import { chromium } from 'playwright';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const output=process.env.R9_OBSERVATION_OUTPUT;
if(!output)throw new Error('R9_OBSERVATION_OUTPUT required');
mkdirSync(output,{recursive:true,mode:0o700});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
try {
 const context=await browser.newContext({viewport:{width:1440,height:1200}});
 await context.addCookies([{name:'studio',value:'r8-local-functional',domain:'127.0.0.1',path:'/'}]);
 const page=await context.newPage();await page.goto('http://127.0.0.1:8188/?liveAudit=1');
 await page.getByRole('button',{name:/Studio betreten/}).click();
 await page.locator('#ai-monk-dock').waitFor({timeout:60000});
 await page.evaluate(()=>{
  const g=window as any;g.__r9Requests=[];const socket=g.__webRTCManager.socket;const original=socket.emit;
  socket.emit=function(event:string,...args:any[]){if(event==='plugin-lock'||event==='plugin-unlock')g.__r9Requests.push({event,args,at:new Date().toISOString(),stack:new Error().stack});return original.call(this,event,...args);};
 });
 await page.getByRole('button',{name:'biblioMONK An',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#rack-biblio')?.getAttribute('data-plugin-owner')==='me');
 // Include one normal heartbeat before OFF to exercise a real renewal.
 await page.waitForTimeout(20500);
 await page.getByRole('button',{name:'biblioMONK Aus',exact:true}).click();
 const offAt=Date.now();
 for(let i=0;i<=60;i++){
  const row=await page.evaluate(async()=>({at:new Date().toISOString(),userId:(window as any).__webRTCManager.userId,mode:document.querySelector('#rack-biblio')?.getAttribute('data-plugin-mode'),owner:document.querySelector('#rack-biblio')?.getAttribute('data-plugin-owner'),state:await fetch('/api/session/state').then(r=>r.json()),audit:await fetch('/api/audit').then(r=>r.json()),requests:(window as any).__r9Requests}));
  appendFileSync(output+'/observations.ndjson',JSON.stringify(row)+'\n',{mode:0o600});
  if(i<60)await page.waitForTimeout(1000);
 }
 const requests=await page.evaluate(()=>(window as any).__r9Requests);
 const postOffLocks=requests.filter((r:any)=>r.event==='plugin-lock'&&r.args[0]?.pluginId==='biblio'&&Date.parse(r.at)>offAt);
 const result={scope:'actual UI single Producer,60s observation after OFF; no injected events',offAt:new Date(offAt).toISOString(),postOffLocks,requests};
 writeFileSync(output+'/result.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({postOffLocks:postOffLocks.length,output}));
}finally{await browser.close();}
