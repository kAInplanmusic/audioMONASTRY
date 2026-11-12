"""Reconcile only the three production host records against owned live nodes."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import urllib.request

HOSTS = {'origin.hallerbans.de': 'app', 'sfu.hallerbans.de': 'sfu',
         'master.hallerbans.de': 'media'}


def request(base, token, path, method='GET', body=None):
    req = urllib.request.Request(base + path, method=method,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def plan(servers, records):
    result = []
    for name, role in HOSTS.items():
        nodes = [s for s in servers if s['name'] == 'audiomonastry-' + role + '-1']
        if len(nodes) != 1 or nodes[0]['status'] != 'running' or any(
                nodes[0]['labels'].get(k) != v for k, v in {'app':'audiomonastry','role':role}.items()):
            raise RuntimeError('PRODUCTION_NODE_OWNERSHIP_OR_READINESS_FAILED:' + role)
        address = nodes[0]['public_net']['ipv4']['ip']
        if not ipaddress.IPv4Address(address).is_global:
            raise RuntimeError('PRODUCTION_NODE_ADDRESS_INVALID:' + role)
        matches = [r for r in records if r['name'] == name]
        if len(matches) > 1 or any(r['type'] != 'A' for r in matches):
            raise RuntimeError('CONFLICTING_DNS_RECORDS:' + name)
        old = matches[0] if matches else None
        result.append({'name':name, 'role':role, 'recordId':old['id'] if old else None,
            'before': {k:old[k] for k in ('type','content','proxied','ttl')} if old else None,
            'after': {'type':'A','content':address,'proxied':False,'ttl':300},
            'changed': old is None or old['content'] != address or old['proxied'] or old['ttl'] != 300})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    provider = json.loads(os.environ.get('AUDIO_PROD_PROVIDER_ENV') or '{}')
    token = os.environ.get('CF_DNS_API_TOKEN') or provider.get('CF_DNS_API_TOKEN')
    if not token:
        raise RuntimeError('CF_DNS_API_TOKEN_MISSING')
    cfbase = 'https://api.cloudflare.com/client/v4/'
    def cf(path, method='GET', body=None):
        data = request(cfbase, token, path, method, body)
        if data.get('success') is not True:
            raise RuntimeError('CLOUDFLARE_REQUEST_REJECTED')
        return data['result']
    zones = cf('zones?name=hallerbans.de')
    if len(zones) != 1:
        raise RuntimeError('PRODUCTION_ZONE_NOT_UNIQUE')
    prefix = 'zones/' + zones[0]['id'] + '/dns_records'
    records = []
    for name in HOSTS:
        records += cf(prefix + '?name=' + name)
    servers = request('https://api.hetzner.cloud/v1/', os.environ['HETZNER_PRODUCTION_TOKEN'],
                      'servers?per_page=50')['servers']
    changes = plan(servers, records)
    report = {'applied':args.apply, 'records':changes, 'onlyProductionHostRecords':True}
    # Persist the complete before/after plan before the first reversible write.
    output = Path('production-evidence')
    output.mkdir(exist_ok=True)
    (output / 'dns.json').write_text(json.dumps(report, indent=2) + '\n')
    if args.apply:
        for item in changes:
            if item['changed']:
                cf(prefix + ('/' + item['recordId'] if item['recordId'] else ''),
                   'PUT' if item['recordId'] else 'POST', {'name':item['name'], **item['after']})
        current = [row for name in HOSTS for row in cf(prefix + '?name=' + name)]
        if any(item['changed'] for item in plan(servers, current)):
            raise RuntimeError('DNS_POSTWRITE_VERIFICATION_FAILED')
        report['verificationPassed'] = True
        (output / 'dns.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
