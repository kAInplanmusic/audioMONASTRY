# Sicherheit: Cookies, Token-Weitergabe und Workflow-Pinning

Datum: 2026-09-11 · Scope: `services/portal-worker/src/index.js`, `server.ts`,
`.github/workflows/*` · Methode: Code-Review + Messung (keine Vermutungen)

Bezug: `MASTERTODOENDE.json` → `SEC-P2-001`.

---

## 1. Welche Cookies es gibt

Es gibt genau **zwei** App-Cookies. Beide werden vom **Portal-Worker**
(Cloudflare) gesetzt, nicht vom Node-Server; der Server **liest** sie nur.

| Cookie | Inhalt | Attribute | gesetzt in |
|---|---|---|---|
| `portal` | HMAC-signierte Session (`payload.exp.signature`) | `Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure` | `services/portal-worker/src/index.js:473` |
| `studio` | **`STUDIO_ACCESS_TOKEN` im Klartext** | `Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure` | `services/portal-worker/src/index.js:477` |

Verifikation der Attribute (jeweils im Code nachgelesen):

```
portal=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure
studio=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure
```

Beide sind also `HttpOnly` (kein JS-Zugriff → XSS kann sie nicht auslesen),
`Secure` (nur über HTTPS), `SameSite=Lax` (kein Mitversand bei Cross-Site-POSTs)
und auf **24 h** begrenzt.

## 2. Wie der Server das Cookie prüft

- REST: `studioTokenFromRequest()` liest erst den Header `x-studio-token`, sonst
  das Cookie `studio` (`server.ts:335–341`).
- Socket.io-Handshake: dieselbe Cookie-Auswertung (`server.ts:2695–2696`).
- Vergleich in **konstanter Zeit** (`safeTokenEqual`, `server.ts:326–333`).
- **Fail-closed:** Ohne `STUDIO_ACCESS_TOKEN` ist die API in Produktion
  geschlossen (`server.ts:310–323`, 503 `STUDIO_TOKEN_MISSING`) — nur
  `/api/health` und die Vision-Artefakte sind ausgenommen.

**CSRF-Bewertung:** `SameSite=Lax` verhindert den Mitversand des Cookies bei
Cross-Site-`POST`s; zusätzlich erwartet die API `Content-Type: application/json`
und prüft bei gesetztem `API_ALLOWED_ORIGINS` den `Origin` (`server.ts:359–372`).
Damit ist der klassische CSRF-Pfad geschlossen.

## 3. Befund (offen): das Master-Token liegt 24 h im Browser

**F-1 (Mittel):** Das `studio`-Cookie enthält **denselben Wert** wie der
API-Master-Token (`STUDIO_ACCESS_TOKEN`). Damit gilt:

- Jeder, der das Cookie erbeutet (Gerät, Backup, Browser-Profil, Mitlesen im
  Klartext-Proxy), hat **den dauerhaften Studio-Zugang** — nicht nur eine
  Sitzung. Es gibt keine serverseitige Ablauffrist und keine Einzel-Sperre.
- Die 24-Stunden-Grenze existiert nur im Cookie (`Max-Age`), nicht am Token.
- Ein Token-Wechsel entwertet gleichzeitig alle laufenden Browser-Sitzungen.

**Mildernd:** `HttpOnly` + `Secure` + `SameSite=Lax`, fail-closed-API,
Konstantzeit-Vergleich, keine Token-Ausgabe in Logs (nur Status/Quellname).

**Empfehlung (eigener Task `SEC-P2-002`):** Das Portal sollte statt des
Master-Tokens ein **kurzlebiges, signiertes Session-Token** ausstellen
(z. B. 15 min, mit `exp`-Feld wie beim `portal`-Cookie) und der Server sollte
dieses prüfen; das Master-Token bleibt dann ausschließlich serverseitig. Bis
dahin: Token bei Verdacht rotieren und `STUDIO_ACCESS_TOKEN` niemals in
Screenshots/Logs/Tickets zeigen.

## 4. Workflow-Pinning (geprüft)

**Ergebnis: alle Actions sind auf vollständige Commit-SHAs gepinnt.**

```
9 verschiedene Actions, 42 uses-Zeilen, 10 Workflows:
  actions/checkout@11d5960a…
  actions/github-script@f28e40c7…
  actions/setup-node@49933ea5…
  actions/setup-python@a26af69b…
  actions/upload-artifact@ea165f8d…
  docker/build-push-action@ca052bb5…
  docker/login-action@c94ce9fb…
  gitleaks/gitleaks@02808f45…
  SonarSource/sonarqube-scan-action@c7ee0f9d…
```

Prüfbefehl (im Repo):

```bash
grep -rh 'uses:' .github/workflows/*.yml | sed 's/.*uses: *//' | sort -u
# Jeder Eintrag muss auf @<40 hex> enden → kein @v4/@main
```

## 5. Gates / Wiederholung

```bash
# Secrets im Repo
npx gitleaks detect --no-banner           # in CI: Job in .github/workflows/build.yml
# Header/Cookie-Attribute im Worker
grep -n "HttpOnly" services/portal-worker/src/index.js
# Fail-closed-Auth im Server
npm run test -- tests/securityProductionAuth.test.ts tests/security.test.ts
```
