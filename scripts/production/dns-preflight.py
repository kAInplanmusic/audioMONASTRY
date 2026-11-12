"""Read-only DNS inventory for the production origin and SFU."""
import json
import os
import urllib.error
import urllib.request
import hashlib
import re


def main():
    provider = json.loads(os.environ.get('AUDIO_PROD_PROVIDER_ENV') or '{}')
    candidates = [(name, os.environ.get(name) or provider.get(name)) for name in
                  ('CF_DNS_API_TOKEN','CLOUDFLARE_API_TOKEN','CLOUDFLARE_TOKEN')]
    checked = set()
    report = {'dnsWriteAttempted':False,'credentialConfigured':any(value for _,value in candidates),'attempts':[]}
    for name, token in candidates:
        if not token or token in checked:
            continue
        checked.add(token)
        def get(path):
            request = urllib.request.Request('https://api.cloudflare.com/client/v4/'+path,
                headers={'Authorization':'Bearer '+token})
            with urllib.request.urlopen(request,timeout=20) as response:
                return json.load(response)
        try:
            zones = get('zones?name=hallerbans.de')['result']
            rows = []
            workers=[]
            for zone in zones:
                records = get('zones/'+zone['id']+'/dns_records?per_page=100')['result']
                rows += [{key:row[key] for key in ('type','name','content','proxied','ttl')}
                         for row in records if row['name'] in ('origin.hallerbans.de','sfu.hallerbans.de','master.hallerbans.de')]
                prefix='accounts/'+zone['account']['id']+'/workers/scripts/audiomonastry-portal'
                worker={'script':'audiomonastry-portal'}
                try:
                    schedules=get(prefix+'/schedules')
                    worker['scheduleReadPassed']=schedules.get('success') is True
                    result=schedules.get('result',{})
                    entries=result.get('schedules',[]) if isinstance(result,dict) else result
                    worker['scheduleCount']=len(entries)
                    worker['crons']=[row['cron'] for row in entries if re.fullmatch(r'[0-9*,/ -]{1,100}',row.get('cron',''))]
                except urllib.error.HTTPError as exc:worker['scheduleReadHttpStatus']=exc.code
                try:
                    request=urllib.request.Request('https://api.cloudflare.com/client/v4/'+prefix,headers={'Authorization':'Bearer '+token})
                    with urllib.request.urlopen(request,timeout=20) as response:raw=response.read(5*1024*1024)
                    source=raw.decode(errors='replace')
                    worker.update(sourceReadPassed=True,sourceSha256=hashlib.sha256(raw).hexdigest(),
                        referencesIdleSignal='idle-signal' in source,
                        referencesMaintenance='maintenance' in source.lower() or 'deploy.lock' in source,
                        referencesTeardown='stopFleet' in source or 'fleet-teardown' in source)
                    match=re.search(r'(?:async\s+)?scheduled\s*\(|scheduled\s*:',source)
                    if match:
                        snippet=source[max(0,match.start()-40):match.start()+2000]
                        for secret in sorted([token,*[value for value in provider.values() if isinstance(value,str)]],key=len,reverse=True):
                            if len(secret)>=8:snippet=snippet.replace(secret,'[redacted]')
                        snippet=re.sub(r'https?://[^\s\"\'<>]+','[url]',snippet)
                        worker['scheduledSourceRedacted']=re.sub(r'[A-Za-z0-9_./+=-]{28,}','[redacted]',snippet)
                except urllib.error.HTTPError as exc:worker['sourceReadHttpStatus']=exc.code
                workers.append(worker)
                try:
                    scripts=get('accounts/'+zone['account']['id']+'/workers/scripts').get('result',[])
                    worker['accountWorkerCount']=len(scripts)
                    scheduled=[]
                    for script in scripts[:50]:
                        ident=script.get('id') or script.get('name')
                        if not isinstance(ident,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',ident) or ident=='audiomonastry-portal':continue
                        other='accounts/'+zone['account']['id']+'/workers/scripts/'+ident
                        try:
                            result=get(other+'/schedules').get('result',{})
                            entries=result.get('schedules',[]) if isinstance(result,dict) else result
                            if not entries:continue
                            item={'script':ident,'crons':[row['cron'] for row in entries if re.fullmatch(r'[0-9*,/ -]{1,100}',row.get('cron',''))]}
                            request=urllib.request.Request('https://api.cloudflare.com/client/v4/'+other,headers={'Authorization':'Bearer '+token})
                            with urllib.request.urlopen(request,timeout=20) as response:content=response.read(5*1024*1024).decode(errors='replace')
                            item.update(referencesProject=any(word in content.lower() for word in ('audiomonastry','hallerbans')),
                                referencesHetzner='api.hetzner.cloud' in content or 'HCLOUD_TOKEN' in content)
                            if item['referencesProject'] or item['referencesHetzner']:
                                match=re.search(r'(?:async\s+)?scheduled\s*\(|scheduled\s*:',content)
                                snippet=content[max(0,match.start()-40):match.start()+2000] if match else ''
                                for secret in sorted([token,*[value for value in provider.values() if isinstance(value,str)]],key=len,reverse=True):
                                    if len(secret)>=8:snippet=snippet.replace(secret,'[redacted]')
                                snippet=re.sub(r'https?://[^\s\"\'<>]+','[url]',snippet)
                                item['scheduledSourceRedacted']=re.sub(r'[A-Za-z0-9_./+=-]{28,}','[redacted]',snippet)
                            scheduled.append(item)
                        except urllib.error.HTTPError as exc:scheduled.append({'script':ident,'httpStatus':exc.code})
                    worker['otherScheduledWorkers']=scheduled
                except urllib.error.HTTPError as exc:worker['accountWorkersHttpStatus']=exc.code
            report['attempts'].append({'binding':name,'zoneVisible':bool(zones),'records':rows,'workers':workers})
        except urllib.error.HTTPError as exc:
            report['attempts'].append({'binding':name,'httpStatus':exc.code})
    print(json.dumps(report,indent=2))


if __name__ == '__main__':
    main()
