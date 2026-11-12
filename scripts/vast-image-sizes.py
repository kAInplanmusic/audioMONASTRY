"""Read compressed registry sizes for pinned role images; never pulls layers."""
import base64
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request


def main():
    images = json.loads(Path('deploy/vast/images.json').read_text())
    repo = 'kainplanmusic/audiomonastry-ai-runtime-vast'
    credentials = (os.environ['GHCR_USERNAME'] + ':' + os.environ['GHCR_PASSWORD']).encode()
    url = 'https://ghcr.io/token?' + urllib.parse.urlencode({
        'service': 'ghcr.io', 'scope': 'repository:' + repo + ':pull'})
    request = urllib.request.Request(url, headers={'Authorization': 'Basic ' + base64.b64encode(credentials).decode()})
    with urllib.request.urlopen(request, timeout=60) as response:
        token = json.load(response)['token']

    def manifest(digest):
        request = urllib.request.Request('https://ghcr.io/v2/' + repo + '/manifests/' + digest, headers={
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json'})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)

    cache, result = {}, {}
    for role, image in images.items():
        digest = image.split('@')[1]
        if digest not in cache:
            data = manifest(digest)
            if 'manifests' in data:
                matches = [m for m in data['manifests'] if m.get('platform', {}).get('architecture') == 'amd64' and m.get('platform', {}).get('os') == 'linux']
                assert len(matches) == 1, 'Ambiguous linux/amd64 image'
                data = manifest(matches[0]['digest'])
            cache[digest] = sum(x['size'] for x in data['layers']) + data['config']['size']
        result[role] = {'image': image, 'compressedBytes': cache[digest]}
    Path('vast-image-sizes.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({r: v['compressedBytes'] for r, v in result.items()}))


if __name__ == '__main__':
    main()
