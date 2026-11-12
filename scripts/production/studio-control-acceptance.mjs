import { chromium } from 'playwright';
import { mkdir,writeFile } from 'node:fs/promises';
const base='https://hallerbans.de';
const token=process.env.STUDIO_ACCESS_TOKEN;
const expected=new Set(JSON.parse(process.env.EXPECTED_POD_IDS));
const report={stage:'failed',targetRunId:process.env.TARGET_RUN_ID,checks:{}};
let browser,page,initial;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  const proxyUrl=process.env.HTTPS_PROXY || process.env.https_proxy;
  let proxy;
  if (proxyUrl) { const url=new URL(proxyUrl);proxy={server:url.protocol+'//'+url.host,
    ...(url.username?{username:decodeURIComponent(url.username),password:decodeURIComponent(url.password)}:{})}; }
  browser=await chromium.launch({headless:true,...(proxy?{proxy}:{}),args:[
    '--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({permissions:['microphone'],viewport:{width:1440,height:1000},
    userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
  await context.addCookies([{url:base,name:'studio',value:encodeURIComponent(token),httpOnly:true,secure:true,sameSite:'Lax'}]);
  const deadline=Date.now()+20*60_000;
  let ready=false;
  while(Date.now()<deadline) {
    const response=await context.request.get(base+'/api/ai/fleet/status');
    if(response.ok()) {
      const state=await response.json();
      const ids=(state.roles||[]).map(role=>String(role.endpointId));
      ready=ids.length===8 && ids.every(id=>expected.has(id)) && state.aiEnabled===true;
      if(ready) break;
    }
    await delay(2000);
  }
  if(!ready) throw new Error('CONTROL_RUNTIME_NOT_PROMOTED');
  page=await context.newPage();
  await page.goto(base,{waitUntil:'domcontentloaded',timeout:30000});
  await page.getByRole('button',{name:'STUDIO BETRETEN'}).click();
  await page.locator('#ai-monk-dock').waitFor({state:'visible',timeout:40000});
  initial=await page.evaluate(()=>window.__audioMonastry.audioEngine.getBpm());
  report.checks.mixerOwnership=await page.locator('#rack-mixer').getAttribute('data-plugin-owner')==='me';
  if(!report.checks.mixerOwnership) throw new Error('CONTROL_MIXER_NOT_OWNED');
  const dock=page.locator('#ai-monk-dock');
  const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/ai/executor'
    && response.request().method()==='POST',{timeout:60000});
  await dock.locator('input').fill('Setz das Tempo auf 137 BPM');
  await dock.getByRole('button',{name:'AUSFÜHREN',exact:true}).click();
  const response=await responsePromise;
  const result=await response.json();
  report.checks.selectedExecutor=response.ok() && result.model==='qwen3-4b';
  report.checks.expectedCommand=JSON.stringify(result.commands)===JSON.stringify([{pluginId:'transport',command:'set_tempo(137)'}]);
  await page.waitForFunction(()=>window.__audioMonastry.audioEngine.getBpm()===137,null,{timeout:10000});
  report.checks.actualAudioEngineTempo=true;
  const health=await context.request.get(base+'/api/health');
  report.deployedCommit=(await health.json()).commit;
  report.stage=Object.values(report.checks).every(Boolean)?'passed':'failed';
} catch(error) {
  report.failureCode=['CONTROL_RUNTIME_NOT_PROMOTED','CONTROL_MIXER_NOT_OWNED'].includes(error.message)
    ?error.message:'CONTROL_BROWSER_OR_EXECUTION_FAILED';
} finally {
  if(page && Number.isFinite(initial)) {
    try {await page.evaluate(bpm=>window.__audioMonastry.audioEngine.setBpm(bpm),initial);report.tempoRestored=true;}
    catch {report.tempoRestored=false;report.stage='failed';}
  }
  await browser?.close();
  await mkdir('production-evidence',{recursive:true});
  await writeFile('production-evidence/control.json',JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report));
process.exitCode=report.stage==='passed'?0:2;
