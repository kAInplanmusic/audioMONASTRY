# ENTWURF — Datenschutzerklärung & Impressum (zur Prüfung)

> ## ⚠️ Dies ist ein ENTWURF, keine Rechtsberatung
>
> Erstellt am 2026-09-23 vom Agenten auf Grundlage **gemessener** technischer
> Fakten. Er ersetzt **keine** anwaltliche Prüfung. Vor Veröffentlichung müssen
> alle `TODO(operator):`-Felder gefüllt sein. Die technische Faktenlage ist
> unten Abschnitt C belegt; die rechtliche Bewertung (Rechtsgrundlagen,
> Drittlandtransfer, Löschfristen) gehört zu Betreiber/Anwalt.

---

## A. Impressum (Entwurf)

Angaben gemäß § 5 DDG (vormals § 5 TMG):

```
TODO(operator): Vor- und Nachname / Firma (wie im Handelsregister)
TODO(operator): Straße und Hausnummer      ← PFLICHT, nicht weglassbar
TODO(operator): PLZ und Ort
TODO(operator): Land
```

**Kontakt**

```
TODO(operator): E-Mail-Adresse (erreichbar, keine info@-Blackbox)
TODO(operator): Telefon (optional, aber empfohlen: beschleunigt Auskunftsersuchen)
```

**Verantwortlich für den Inhalt**

```
TODO(operator): Name, Anschrift wie oben
```

**Hinweis zur Rechtsform**

Das Projekt wird als **privates Forschungs- und Entwicklungsprojekt** ohne
kommerzielle Zwecke betrieben (`README.md`: „Project purpose: private /
research (no commercial purpose)"). `TODO(operator):` Falls eine
Gewerbeanmeldung, Vereins- oder Gesellschaftsform besteht, muss sie hier stehen
— „privat" ist keine Angabe im Sinne des § 5 DDG, wenn die Instanz öffentlich
erreichbar ist.

**Streitschlichtung**

Die Europäische Kommission stellt eine Plattform zur
Online-Streitbeilegung (OS) bereit: <https://ec.europa.eu/consumers/odr/>.
`TODO(operator):` Satz zur Bereitschaft/Nicht-Bereitschaft zur Teilnahme an
Streitbeilegungsverfahren ergänzen (Verbraucher- vs. B2B-Fall).

---

## B. Datenschutzerklärung (Entwurf, gegliedert nach Art. 13 DSGVO)

### B.1 Verantwortlicher

Siehe Impressum (Abschnitt A). `TODO(operator):` Datenschutz-Kontakt, falls
abweichend.

### B.2 Welche Daten verarbeitet werden — und wo sie tatsächlich landen

Die folgende Tabelle ist **aus dem Code und der Infrastruktur abgeleitet**
(Belege in Abschnitt C), nicht aus einem Template:

| Datenkategorie | Zweck | Verarbeitungsort | Empfänger |
|---|---|---|---|
| Audioaufnahme (Mikrofon, Instrument, Upload) | Kernfunktion: Aufnehmen, Mischen, Exportieren | Browser, eigener Server | Cloudflare R2 (Objektspeicher) |
| **Stimme** (Sprachaufnahme, Voice-Generator) | Sprachfeatures | eigener Server → RunPod-Endpunkt | RunPod (GPU-Serverless), ggf. HuggingFace |
| Datei-Metadaten (Name, Tags, BPM, Pfad) | Bibliothek, Suche | PostgreSQL | Supabase (Datenbank-Dienst) |
| Session-/Verbindungsdaten, IP-Adresse | Betrieb, Zugangsschutz, Missbrauchsabwehr | eigener Server, Logs | Hetzner (Hosting), Cloudflare (Proxy/DNS) |
| Anmelde-Cookies (`portal`, `studio`) | Sitzung, Zugangsschutz | Browser | — (kein Dritter) |
| Prompts an KI-Funktionen | KI-Features (Song-Ideen, Presets, Analyse) | eigener Server → KI-Endpunkt | RunPod, HuggingFace, ggf. DeepSeek |
| Nutzungs-/Fehler-Telemetrie | Stabilität | eigener Server | Prometheus/Grafana (eigene Instanz) |
| Lokale Zwischenspeicher (OPFS/IndexedDB) | Offline-Arbeit | **ausschließlich im Browser** | — |

**Kernaussage für den Nutzer:** Audioarbeit bleibt im Browser und auf eigener
Infrastruktur. Es gibt **keine** Analyse-, Tracking- oder Werbe-Skripte Dritter
(gemessen: kein `Notification`, kein Werbe-SDK im Client-Bundle).

### B.3 Besonderheit: Stimmdaten

`TODO(operator):` Wird die Stimme des Nutzers verarbeitet (Gesangsaufnahme,
Voice-Generator, Sprechprobe), ist zu prüfen, ob dies als **biometrisches Datum
nach Art. 9 DSGVO** einzuordnen ist. Falls ja, braucht es eine **ausdrückliche
Einwilligung** (Art. 9 Abs. 2 lit. a) mit gesonderter Information — nicht nur
eine allgemeine Datenschutzerklärung.

### B.4 Drittlandtransfer

`TODO(operator + Anwalt):` Für RunPod/HuggingFace/Cloudflare/Supabase ist zu
klären und zu benennen, in welchen Drittländern (typisch USA) verarbeitet wird
und worauf der Transfer gestützt wird (Angemessenheitsbeschluss EU-US Data
Privacy Framework, Standardvertragsklauseln). **Dieser Punkt ist ungeprüft** —
ich habe nur festgestellt, dass diese Dienste aufgerufen werden, nicht wo deren
Daten liegen.

### B.5 Rechtsgrundlagen

`TODO(operator + Anwalt):` je Zweck zu benennen (Vertrag/Art. 6 Abs. 1 lit. b,
berechtigtes Interesse lit. f, Einwilligung lit. a).

### B.6 Speicherdauer und Löschung

`TODO(operator):` Konkrete Fristen festlegen und hier nennen. Technisch heute
vorhanden: `DELETE`-Pfade für Objekte, `reset.sql` für die Datenbank,
`/api`-Audit-Logs. Ohne genannte Frist ist die Angabe unvollständig.

### B.7 Betroffenenrechte

Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung
(Art. 18), Datenübertragbarkeit (Art. 20), Widerspruch (Art. 21), Widerruf einer
Einwilligung (Art. 7 Abs. 3), Beschwerde bei einer Aufsichtsbehörde (Art. 77).

`TODO(operator):` Zuständige Aufsichtsbehörde benennen und einen erreichbaren
Weg für Auskunftsersuchen angeben.

### B.8 Keine automatisierte Entscheidungsfindung

Es findet keine automatisierte Einzelentscheidung mit Rechtswirkung nach
Art. 22 DSGVO statt. `TODO(operator):` Sofern KI-Features künftig Profile bilden,
gehört das hierher.

---

## C. Gemessene technische Faktenlage (Belege für Abschnitt B)

Damit das Papier nicht nur behauptet, was es sagt:

| Aussage | Beleg |
|---|---|
| Objektspeicher = Cloudflare R2 | `server/cloud.ts`, `docs/ENV_MATRIX.md` (CFS3-Keys) |
| Datenbank = Supabase/Postgres | `database/*.sql`, `src/config/supabaseKeys.ts` |
| GPU-Rollen = RunPod-Serverless | `src/core/ai/aiGate.ts`, `.env`-Schlüssel `RP_*` |
| Hosting = Hetzner, Proxy = Cloudflare | `Caddyfile`, `docs/HETZNER_DEPLOY.md`, `docs/ORIGIN_TLS_DNS_RUNBOOK.md` |
| Lokale KI ohne Dritten möglich | `OLLAMA_URL` in `.env.example` (lokale Instanz) |
| Keine Nutzer-Benachrichtigungen/Tracker | Audit 2026-09-23: 0 × `Notification`, 0 × `alert()`, keine Werbe-SDKs im Bundle |
| Cookies nur `portal` + `studio` | `src/core/session/studioSession.ts`, `tests/studioSession.test.ts` |
| Zugang ist token-geschützt | `STUDIO_ACCESS_TOKEN`, fail-closed (`server.ts`) |

**Nicht geprüft (ehrlich):** Datenhaltungsorte der Dritt-Dienste, deren
Auftragsverarbeitungsverträge, tatsächliche Löschfristen. Diese Punkte habe ich
nicht gemessen und deshalb nicht behauptet.

---

## D. Was der Betreiber tun muss (kurz)

1. Abschnitt A vollständig ausfüllen (Anschrift ist Pflicht).
2. B.4/B.5/B.6 mit Anwalt oder Vorlage des jeweiligen Dienstes klären.
3. B.3 entscheiden (Stimme = Art. 9?).
4. Erst danach unter `/impressum` und `/datenschutz` veröffentlichen und im
   Footer verlinken (die Seiten existieren heute **nicht** — Befund `PROD-P0-005`).
