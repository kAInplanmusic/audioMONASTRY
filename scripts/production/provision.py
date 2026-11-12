"""Restore missing production roles from existing snapshots; preserve existing nodes.

All four recovery images and firewalls must exist before the first allocation.
Secrets are inherited from snapshots and never included in API payloads or output.
"""
import re
import time
import math
import json

NAMES = {role: 'audiomonastry-' + role + '-1' for role in ('app', 'sfu', 'media', 'edge')}
TYPES = ('cx23', 'cx33', 'cx43', 'cx53')
DEFAULTS = {'app': 'cx43', 'sfu': 'cx33', 'media': 'cx43', 'edge': 'cx23'}
MINIMUMS = {'app': (8, 16), 'sfu': (4, 8), 'media': (8, 16), 'edge': (2, 4)}


def collection(api, resource, query=''):
    rows, page = [], 1
    while page:
        data = api('GET', resource + '?' + query + ('&' if query else '') +
                   'per_page=50&page=' + str(page))
        rows.extend(data[resource])
        page = data.get('meta', {}).get('pagination', {}).get('next_page')
    return rows


def snapshot_role(image):
    labels = image.get('labels', {})
    if labels.get('app', '').lower() == 'audiomonastry' and labels.get('role') in NAMES:
        return labels['role']
    text = (image.get('description') or '') + ' ' + (image.get('name') or '')
    match = re.search(r'audiomonastry-snapshot-(?:audiomonastry-)?(app|sfu|media|edge)(?:-1)?-', text)
    return match.group(1) if match else None


def recovery_plan(servers, images, firewalls, types):
    by_name = {server['name']: server for server in servers}
    result = {}
    for role, name in NAMES.items():
        server = by_name.get(name)
        if server:
            if server.get('labels', {}).get('app', '').lower() != 'audiomonastry' or server['labels'].get('role') != role:
                raise RuntimeError('EXISTING_NODE_OWNERSHIP_MISMATCH:' + role)
            result[role] = {'existing': server}
            continue
        candidates = [image for image in images if image.get('status') == 'available'
                      and snapshot_role(image) == role]
        if not candidates:
            raise RuntimeError('RECOVERY_SNAPSHOT_MISSING:' + role)
        image = max(candidates, key=lambda item: item['created'])
        firewall = next((fw for fw in firewalls
                         if fw['name'] == 'audiomonastry-prod-' + role + '-20261112'
                         and fw.get('labels', {}).get('managed-by') == 'production-deploy'), None)
        if not firewall:
            raise RuntimeError('PRODUCTION_FIREWALL_MISSING:' + role)
        eligible = [t for t in types if t['name'] in TYPES[TYPES.index(DEFAULTS[role]):]
                    and t.get('architecture') == 'x86' and not t.get('deprecated')
                    and t['disk'] >= image['disk_size']]
        locations = ('fsn1', 'nbg1', 'hel1')
        capacity = [(t, location) for t in eligible for location in locations
                    if any(loc['name'] == location and loc.get('available') is True
                           for loc in t.get('locations', []))]
        # A snapshot cannot be restored onto a smaller disk. When the CX size
        # required by the saved disk is sold out, retain x86 and the role's
        # minimum RAM/cores using an available shared-CPU CPX at a quoted price.
        fallback = []
        if not capacity:
            cores, memory = MINIMUMS[role]
            for t in types:
                if not (re.fullmatch(r'cpx[0-9]+', t['name']) and t.get('architecture') == 'x86'
                        and t.get('cpu_type') == 'shared' and t['disk'] >= image['disk_size']
                        and t['cores'] >= cores and t['memory'] >= memory):
                    continue
                for location in locations:
                    available = any(loc['name'] == location and loc.get('available') is True
                                    for loc in t.get('locations', []))
                    price = next((float(p['price_hourly']['gross']) for p in t.get('prices', [])
                                  if p['location'] == location), math.inf)
                    if available and math.isfinite(price) and 0 < price <= 0.30:
                        fallback.append((price, t, location))
            if fallback:
                _, t, location = min(fallback, key=lambda row: (row[0], locations.index(row[2])))
                capacity = [(t, location)]
        if not capacity:
            raise RuntimeError('NO_RECOVERY_CAPACITY:' + role)
        selected, location = min(capacity, key=lambda pair: (TYPES.index(pair[0]['name'])
            if pair[0]['name'] in TYPES else len(TYPES), locations.index(pair[1])))
        result[role] = {'image': image['id'], 'type': selected['name'], 'location': location,
                        'firewall': firewall['id']}
    return result


def restore(api, public_key):
    plan = recovery_plan(collection(api, 'servers'), collection(api, 'images', 'type=snapshot'),
                         collection(api, 'firewalls'), collection(api, 'server_types'))
    print(json.dumps({'recoveryPlan': {role: {key: item[key] for key in ('image', 'type', 'location')
                                             if key in item} for role, item in plan.items()}}), flush=True)
    keys = collection(api, 'ssh_keys')
    key = next((item for item in keys if item['public_key'].split()[:2] == public_key.split()[:2]), None)
    if key is None:
        key = api('POST', 'ssh_keys', {'name': 'audiomonastry-production-recovery',
                                      'public_key': public_key})['ssh_key']
    # Creation is sequential. Never retry a POST after an ambiguous response:
    # the next invocation reconciles the stable server names first.
    for role, item in plan.items():
        if 'existing' in item:
            if item['existing']['status'] == 'off':
                api('POST', 'servers/' + str(item['existing']['id']) + '/actions/poweron', {})
            continue
        api('POST', 'servers', {'name': NAMES[role], 'image': item['image'],
            'server_type': item['type'], 'location': item['location'], 'ssh_keys': [key['id']],
            'firewalls': [{'firewall': item['firewall']}],
            'labels': {'app': 'audiomonastry', 'role': role, 'managed-by': 'production-deploy'},
            'public_net': {'enable_ipv4': True, 'enable_ipv6': True}})
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        servers = {s['name']: s for s in collection(api, 'servers')}
        if all(name in servers and servers[name]['status'] == 'running' for name in NAMES.values()):
            return {role: servers[name] for role, name in NAMES.items()}
        time.sleep(5)
    raise RuntimeError('RECOVERY_RUNNING_TIMEOUT')
