#!/usr/bin/env python3
"""
Gemeinsame HTTP-Bausteine der Standalone-Skripte in scripts/.
=============================================================
Drei Aufrufmuster lagen mehrfach wortgleich vor:

  * `portal_request`     - Aufbau des Portal-/Worker-Requests (Cloudflare blockt
                           Standard-urllib mit Fehler 1010, deshalb Browser-UA;
                           Cookie optional). Zeitlimit und Fehlerbehandlung
                           bleiben in den Skripten - die unterscheiden sich dort.
  * `runpod_request_text`- RunPod-REST mit Bearer-Token, roher Antworttext
  * `hcloud_api`         - Hetzner-Cloud-REST, Fehler als Dict `{_error, _body}`

Benutzung (laeuft direkt UND per importlib aus den Tests):

    import pathlib, sys
    _LIB = pathlib.Path(__file__).resolve().parents[0] / "lib"
    if str(_LIB) not in sys.path:
        sys.path.insert(0, str(_LIB))
    from restclient import portal_request  # noqa: E402

Die Skripte behalten ihre duennen lokalen Wrapper (`call`, `api`) - so bleiben
Aufrufstellen und Test-Stubs unveraendert.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

#: Browser-UA: Cloudflare antwortet Standard-urllib sonst mit HTTP 403 / Fehler 1010.
BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)

#: Hetzner-Cloud-REST-Basis (eine Quelle fuer die Firewall-Werkzeuge).
HCLOUD_API = "https://api.hetzner.cloud/v1"


def portal_request(
    base: str,
    path: str,
    data: Optional[Dict[str, Any]] = None,
    cookie: Optional[str] = None,
    *,
    method: Optional[str] = None,
    user_agent: str = BROWSER_UA,
) -> urllib.request.Request:
    """Baut den JSON-Request fuer die Portal-API (Browser-UA, optional Cookie).

    Ohne `method` entscheidet der Body: mit Body POST, ohne GET.
    """
    body = json.dumps(data).encode() if data is not None else None
    request = urllib.request.Request(
        base + path, data=body, method=method or ("POST" if data is not None else "GET"),
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("User-Agent", user_agent)
    request.add_header("Accept", "application/json")
    if cookie:
        request.add_header("Cookie", cookie)
    return request


def portal_call(
    base: str,
    path: str,
    data: Optional[Dict[str, Any]] = None,
    cookie: Optional[str] = None,
    *,
    method: Optional[str] = None,
    timeout: int = 30,
    user_agent: str = BROWSER_UA,
):
    """Portal-Aufruf: (status, geparst|rohtext, Set-Cookie).

    HTTP-Fehler kommen als `(status, Koerper[:200], '')` zurueck, Netzfehler als
    `(0, 'Ausnahme: Meldung', '')` - ein Fehler bleibt so sichtbar, statt still
    zu verschwinden. Werkzeuge mit eigenem Fehlermodell bauen ihren Request mit
    `portal_request` selbst.
    """
    request = portal_request(base, path, data, cookie, method=method, user_agent=user_agent)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as res:
            raw = res.read().decode()
            set_cookie = res.headers.get("Set-Cookie") or ""
            return res.status, (json.loads(raw) if raw.strip().startswith("{") else raw), set_cookie
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()[:200], ""
    except Exception as err:  # noqa: BLE001
        return 0, f"{type(err).__name__}: {err}", ""


def runpod_request_text(
    url: str,
    api_key: str,
    method: str = "GET",
    body: Optional[Dict[str, Any]] = None,
    timeout: int = 60,
) -> str:
    """RunPod-REST-Aufruf mit Bearer-Token; liefert den rohen Antworttext.

    Die Auswertung bleibt beim Aufrufer: runpod-smoke.py parst direkt, das
    Latenz-Werkzeug behandelt eine leere Antwort als `null`.
    """
    data = None
    headers = {"Authorization": f"Bearer {api_key}"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as resp:
        return resp.read().decode()


def hcloud_api(
    path: str,
    token: str,
    method: str = "GET",
    payload: Optional[Dict[str, Any]] = None,
    *,
    detail_limit: int = 250,
    timeout: int = 30,
) -> Dict[str, Any]:
    """Hetzner-Cloud-REST: Fehler kommen als `{_error, _body}` zurueck statt zu fliegen.

    `detail_limit` begrenzt den Fehlerkoerper - die beiden Firewall-Werkzeuge
    hatten hier historisch unterschiedliche Grenzen (250/300 Zeichen); sie
    bleiben ueber diesen Parameter erhalten.
    """
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        f"{HCLOUD_API}{path}", data=body, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        return {"_error": f"HTTP {error.code}", "_body": error.read().decode("utf-8", "replace")[:detail_limit]}
