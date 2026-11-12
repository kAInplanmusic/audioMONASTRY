"""Read-only DNS inventory for the production origin and SFU."""
import json
import os
import urllib.error
import urllib.request
import hashlib


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
                    worker['scheduleCount']=len(schedules.get('result',[]))
                except urllib.error.HTTPError as exc:worker['scheduleReadHttpStatus']=exc.code
                try:
                    request=urllib.request.Request('https://api.cloudflare.com/client/v4/'+prefix+'/content',headers={'Authorization':'Bearer '+token})
                    with urllib.request.urlopen(request,timeout=20) as response:raw=response.read(5*1024*1024)
                    source=raw.decode(errors='replace')
                    worker.update(sourceReadPassed=True,sourceSha256=hashlib.sha256(raw).hexdigest(),
                        referencesIdleSignal='idle-signal' in source,
                        referencesMaintenance='maintenance' in source.lower() or 'deploy.lock' in source,
                        referencesTeardown='stopFleet' in source or 'fleet-teardown' in source)
                except urllib.error.HTTPError as exc:worker['sourceReadHttpStatus']=exc.code
                workers.append(worker)
            report['attempts'].append({'binding':name,'zoneVisible':bool(zones),'records':rows,'workers':workers})
        except urllib.error.HTTPError as exc:
            report['attempts'].append({'binding':name,'httpStatus':exc.code})
    print(json.dumps(report,indent=2))


if __name__ == '__main__':
    main()
