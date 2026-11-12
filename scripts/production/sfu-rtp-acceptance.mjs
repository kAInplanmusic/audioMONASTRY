// Real browser peers against the production SFU, without changing CORS policy.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const token = process.env.STUDIO_ACCESS_TOKEN;
if (!token || token.length < 32) throw new Error('RTP_STUDIO_AUTH_MISSING');
const bundle = await readFile('public/sfu-rtp-test.js','utf8');
const virtual = 'https://hallerbans.de/__production-rtp-acceptance';
const session = 'production-rtp-' + process.env.GITHUB_RUN_ID;
const proxyUrl=process.env.HTTPS_PROXY || process.env.https_proxy;
const report = { stage:'failed', commit:process.env.GITHUB_SHA, producers:[], consumers:[], echo:null,
  networkProxyConfigured:Boolean(proxyUrl) };
let browser;
for (const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{
  void (async()=>{await browser?.close();process.exit(143)})();
});
async function open(mode, producerId) {
  const context = await browser.newContext({permissions:['microphone']});
  const page = await context.newPage();
  const network=[];
  let phase='ticket';
  try {
  page.on('requestfailed',request=>{
    const failure=request.failure()?.errorText ?? '';
    network.push({failedHost:new URL(request.url()).hostname,
      failureCode:/^net::[A-Z_0-9]+$/.test(failure) ? failure : 'NETWORK_FAILURE'});
  });
  page.on('response',response=>{
    if (new URL(response.url()).hostname === 'sfu.hallerbans.de') network.push({
      httpStatus:response.status(),method:response.request().method(),
      allowOrigin:response.headers()['access-control-allow-origin'] ?? null});
  });
  const response = await context.request.get('https://hallerbans.de/api/sfu-ticket?sessionId='+encodeURIComponent(session),{
    headers:{'x-studio-token':token,'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}});
  if (!response.ok()) throw new Error('RTP_TICKET_FAILED');
  const issued = await response.json();
  if (typeof issued.ticket !== 'string') throw new Error('RTP_TICKET_FAILED');
  // Fulfil before network: neither the private token nor this diagnostic page
  // reaches the public web server. Its origin matches the production allowlist.
  await page.route(virtual+'**',route=>route.fulfill({status:200,contentType:'text/html',
    body:'<!doctype html><body><script>'+bundle.replaceAll('</script','<\\/script')+'</script></body>'}));
  const url = new URL(virtual);
  for (const [key,value] of Object.entries({server:'https://sfu.hallerbans.de',token:issued.ticket,session,mode,
    ...(producerId ? {producerId} : {})})) url.searchParams.set(key,value);
  phase='navigation';
  await page.goto(url.toString(),{waitUntil:'domcontentloaded',timeout:20000});
  phase='result';
  await page.waitForFunction(()=>window.__SFU_RTP_RESULT !== undefined,null,{timeout:45000});
  const result = await page.evaluate(()=>window.__SFU_RTP_RESULT);
  result.network=network.slice(-8);
  return {context,result};
  } catch(error) {
    let progress;
    try {progress=await page.evaluate(()=>({steps:window.__SFU_RTP_PROGRESS?.steps?.map(step=>step.split(' ')[0]) ?? []}));} catch {}
    report.failureContext={mode,phase,steps:progress?.steps ?? [],network:network.slice(-8),
      errorType:['TimeoutError','Error'].includes(error.name)?error.name:'BrowserError'};
    throw error;
  }
}
function received(result) {
  return {passed:result.ok === true && result.bytesReceived > 0 && result.packetsReceived > 0,
    bytesReceived:Number(result.bytesReceived)||0, packetsReceived:Number(result.packetsReceived)||0};
}
try {
  let proxy;
  if (proxyUrl) {
    const value=new URL(proxyUrl);
    proxy={server:value.protocol+'//'+value.host,
      ...(value.username ? {username:decodeURIComponent(value.username),password:decodeURIComponent(value.password)} : {})};
  }
  browser = await chromium.launch({headless:true,...(proxy ? {proxy} : {}),args:['--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const ids=[];
  for (let i=0;i<2;i++) {
    const {result} = await open('producer');
    const known = ['unauthorized-sfu','origin-not-allowed','sfu-auth-unconfigured','xhr poll error','websocket error','timeout'];
    report.producers.push({passed:result.ok === true && Boolean(result.producerId),
      ...(known.includes(result.error) ? {failureCode:result.error} : {}),stepsCompleted:result.steps?.length ?? 0,
      network:result.network});
    if (!report.producers.at(-1).passed) throw new Error('RTP_PRODUCER_FAILED');
    ids.push(result.producerId);
  }
  for (let i=0;i<2;i++) {
    const {context,result} = await open('consumer',ids[(i+1)%2]);
    report.consumers.push(received(result));
    await context.close();
  }
  const {context,result} = await open('echo');
  report.echo=received(result);
  await context.close();
  report.stage = report.producers.every(x=>x.passed) && report.consumers.every(x=>x.passed)
    && report.echo.passed ? 'passed' : 'failed';
  if (report.stage !== 'passed') report.failureCode='RTP_AUDIO_NOT_RECEIVED';
} catch (error) {
  // Playwright exceptions can include the token-bearing virtual URL.
  report.failureCode = ['RTP_PRODUCER_FAILED','RTP_TICKET_FAILED'].includes(error.message) ? error.message : 'RTP_BROWSER_OR_PROTOCOL_FAILED';
} finally {
  await browser?.close();
  await writeFile('production-evidence/rtp.json',JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report));
process.exitCode = report.stage === 'passed' ? 0 : 2;
