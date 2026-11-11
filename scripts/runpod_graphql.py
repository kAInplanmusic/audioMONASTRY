"""Runpod GraphQL transport using the documented query-parameter API-key auth."""
from __future__ import annotations
import json
import os
import urllib.error
import urllib.parse
import urllib.request


def query(document, variables=None):
    from provider_policy import require_provider
    require_provider("runpod")
    key = (os.environ.get('RUNPOD_API_KEY') or os.environ.get('RP_API_KEY') or '').strip()
    if not key:
        raise RuntimeError('Runpod API key missing')
    # Never log the request URL: Runpod GraphQL authenticates with api_key here.
    url = 'https://api.runpod.io/graphql?' + urllib.parse.urlencode({'api_key': key})
    req = urllib.request.Request(url, data=json.dumps({'query': document, 'variables': variables or {}}).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'Runpod GraphQL HTTP {exc.code}') from None
    except Exception:
        raise RuntimeError('Runpod GraphQL transport failed') from None
    if result.get('errors'):
        messages = [str(error.get('message', 'GraphQL error')).replace(key, '[REDACTED]')[:500]
                    for error in result['errors']]
        raise RuntimeError('Runpod GraphQL: ' + '; '.join(messages))
    if not isinstance(result.get('data'), dict):
        raise RuntimeError('Runpod GraphQL returned no data')
    return result['data']
