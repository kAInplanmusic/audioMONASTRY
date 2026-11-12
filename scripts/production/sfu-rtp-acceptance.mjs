// Real browser peers against the production SFU, without changing CORS policy.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const token = process.env.STUDIO_ACCESS_TOKEN;
if (!token || token.length < 32) throw new Error('RTP_STUDIO_AUTH_MISSING');
const bundle = await readFile('public/sfu-rtp-test.js','utf8');
const virtual = 'https://hallerbans.de/__production-rtp-acceptance';
const session = 'production-rtp-' + process.env.GITHUB_RUN_ID;
const report = { stage:'failed', commit:process.env.GITHUB_SHA, producers:[], consumers:[], echo:null };
let browser;
async function open(mode, producerId) {
  const context = await browser.newContext({permissions:['microphone']});
  const page = await context.newPage();
  // Fulfil before network: neither the private token nor this diagnostic page
  // reaches the public web server. Its origin matches the production allowlist.
  await page.route(virtual+'**',route=>route.fulfill({status:200,contentType:'text/html',
    body:'<!doctype html><body><script>'+bundle.replaceAll('</script','<\\/script')+'</script></body>'}));
  const url = new URL(virtual);
  for (const [key,value] of Object.entries({server:'https://sfu.hallerbans.de',token,session,mode,
    ...(producerId ? {producerId} : {})})) url.searchParams.set(key,value);
  await page.goto(url.toString(),{waitUntil:'domcontentloaded',timeout:20000});
  await page.waitForFunction(()=>window.__SFU_RTP_RESULT !== undefined,null,{timeout:45000});
  const result = await page.evaluate(()=>window.__SFU_RTP_RESULT);
  return {context,result};
}
function received(result) {
  return {passed:result.ok === true && result.bytesReceived > 0 && result.packetsReceived > 0,
    bytesReceived:Number(result.bytesReceived)||0, packetsReceived:Number(result.packetsReceived)||0};
}
try {
  browser = await chromium.launch({headless:true,args:['--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const ids=[];
  for (let i=0;i<2;i++) {
    const {result} = await open('producer');
    report.producers.push({passed:result.ok === true && Boolean(result.producerId)});
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
  report.failureCode = error.message === 'RTP_PRODUCER_FAILED' ? error.message : 'RTP_BROWSER_OR_PROTOCOL_FAILED';
} finally {
  await browser?.close();
  await writeFile('production-evidence/rtp.json',JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report));
process.exitCode = report.stage === 'passed' ? 0 : 2;
