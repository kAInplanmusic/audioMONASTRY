"""Verify pinned GPU image access on CPU, without renting any compute."""
import base64
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'kainplanmusic/audiomonastry-ai-runtime-vast'
ACCEPT = 'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'


def probe(username, password, images):
    result = {'authenticated': False, 'manifests': {}}
    if not username or not password:
        result['failureCode'] = 'REGISTRY_CREDENTIAL_MISSING'
        return result
    basic = base64.b64encode((username + ':' + password).encode()).decode()
    query = urllib.parse.urlencode({'service':'ghcr.io','scope':'repository:'+REPOSITORY+':pull'})
    request = urllib.request.Request('https://ghcr.io/token?'+query,headers={'Authorization':'Basic '+basic})
    try:
        with urllib.request.urlopen(request,timeout=30) as response:
            token = json.load(response).get('token')
        if not token:
            result['failureCode'] = 'REGISTRY_TOKEN_MISSING'
            return result
        result['authenticated'] = True
        for role, image in images.items():
            digest = image.split('@',1)[1]
            request = urllib.request.Request('https://ghcr.io/v2/'+REPOSITORY+'/manifests/'+digest,
                headers={'Authorization':'Bearer '+token,'Accept':ACCEPT})
            try:
                with urllib.request.urlopen(request,timeout=30) as response:
                    json.load(response)
                    result['manifests'][role] = response.status
            except urllib.error.HTTPError as exc:
                result['manifests'][role] = exc.code
    except urllib.error.HTTPError as exc:
        result['tokenHttpStatus'] = exc.code
    result['allEightImagesReadable'] = len(result['manifests']) == 8 and all(status == 200 for status in result['manifests'].values())
    return result


if __name__ == '__main__':
    provider = json.loads(os.environ.get('AUDIO_PROD_PROVIDER_ENV') or '{}')
    images = json.loads((ROOT / 'deploy/vast/images.json').read_text())
    reports = {'packedProviderCredential': probe(provider.get('GHCR_USERNAME',''),provider.get('GHCR_PASSWORD',''),images),
               'dedicatedRegistryCredential': probe(os.environ.get('GHCR_USERNAME',''),os.environ.get('GHCR_PASSWORD',''),images)}
    print(json.dumps(reports,indent=2))
    if not any(row.get('allEightImagesReadable') for row in reports.values()):
        raise SystemExit(2)
