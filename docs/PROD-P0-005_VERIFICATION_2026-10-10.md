# PROD-P0-005 Verifikation - 2026-10-10

## Ausgangslage
Ticket PROD-P0-005 ist PARTIAL (Stand MASTERTODOENDE.json). Prüfung Präsenz Datenschutzerklärung und Impressum, Typecheck, Acceptance.

## Befunde

### 1. Präsenz der Seiten
- `server/legalPages.ts` implementiert `/impressum` und `/datenschutz` als eigenständige server-seitige HTML-Dokumente.
- Registrierung in `server.ts` VOR Static-Zweigen, keine React-Route.
- Footer-Link vorhanden:
  - `src/App.tsx:663` href="/impressum"
  - `src/App.tsx:672` href="/datenschutz"
  - `server/legalPages.ts:146,152` Footer-Links im legal-Layout
- Test `tests/legalPages.test.ts` existiert, 18 Tests dokumentiert.

### 2. Inhalt / Vollständigkeit
Seiten rendern aus `LEGAL_*`-Umgebungsvariablen:
- LEGAL_NAME, LEGAL_STREET, LEGAL_CITY, LEGAL_COUNTRY, LEGAL_EMAIL, LEGAL_PHONE, LEGAL_REPRESENT, LEGAL_SUPERVISORY

Fehlt eine Pflichtangabe, wird `incompleteWarning(op)` angezeigt, es wird keine erfundene Anschrift gerendert.

Entwurf liegt vor: `docs/RECHT_ENTWURF_DATENSCHUTZ_IMPRESSUM.md` vom 2026-09-23, klar als Entwurf markiert, mit TODO(operator).

Offen / bewusst offen:
- Name und Anschrift nicht gesetzt → Seiten zeigen Hinweis auf Unvollständigkeit
- Rechtsgrundlagen je Zweck nicht finalisiert
- Drittlandtransfer RunPod/HuggingFace/Cloudflare/Hetzner nicht mit Rechtsgrundlage benannt
- Konkrete Löschfristen / Speicherdauer nicht betreiberseitig bestätigt

Die Seiten benennen diese Lücken ausdrücklich, statt Vermutungen zu publizieren.

### 3. Typecheck
```
npm run typecheck
> tsc --noEmit
Exit code: 0
```
Gate grün.

### 4. Acceptance-Kriterien aus MASTERTODOENDE
> Zwei Seiten ... erreichbar und im Footer verlinkt; Datenschutzerklärung nennt Verantwortlichen, Zwecke, Rechtsgrundlagen, Empfänger/Drittland, Speicherdauer/Löschkonzept und Betroffenenrechte. Sie beschreibt den IST-Zustand, kein Template.

Erfüllt:
- Seiten technisch erreichbar und verlinkt: JA
- IST-Zustand beschrieben, kein Template: JA (Tabelle Daten wo landen)
- Keine externen Ressourcen: JA

Nicht erfüllt:
- Verantwortlicher vollständig benannt: NEIN (LEGAL_* nicht befüllt)
- Rechtsgrundlagen je Verarbeitung: NEIN (TODO)
- Drittlandtransfer mit Grundlage: NEIN (TODO + Anwalt)
- Konkrete Löschfristen: NEIN (TODO)

## Ergebnis
Acceptance ist **teilweise** erfüllt. Technische Umsetzung vorhanden, inhaltliche Pflichtangaben fehlen betreiberseitig. Status bleibt **PARTIAL**.

Kein Commit nötig, da keine Änderungen vorgenommen wurden.

## Empfehlung
Betreiber muss LEGAL_* Variablen in .env setzen und Rechtsgrundlagen/Drittlandtransfer/Löschkonzepte anpassen lassen. Danach erneute Verifikation und Umschalten auf DONE möglich.
