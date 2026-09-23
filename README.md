# audioMONASTRY

**Status: Alpha · privates Forschungs- und Entwicklungsprojekt · keine kommerzielle Nutzung**

> **audioMONASTRY ist ein browserbasiertes, kollaboratives Tonstudio (DAW) für bis zu vier
> Personen gleichzeitig: gemeinsam an derselben Session arbeiten, ohne proprietäre Plugins
> und ohne Bindung an einen einzigen Cloud-Anbieter.**

**Version** 1.210.001 (`V. 1|210|001`) · **Codename** „HyperAudioWorkstation" · **Zweig** `main`
Stand: **2026-09-23**

---

## Inhalt

- [1. Was es ist](#1-was-es-ist)
- [2. Was es nicht ist](#2-was-es-nicht-ist)
- [3. Schnellstart](#3-schnellstart)
- [4. Rechtliches](#4-rechtliches)
- [5. Betrieb und Kosten](#5-betrieb-und-kosten)
- [6. Architektur](#6-architektur)
- [7. Die 16 Module](#7-die-16-module)
- [8. KI-Rollen](#8-ki-rollen)
- [9. Sicherheitskonzept](#9-sicherheitskonzept)
- [10. Qualitätssicherung](#10-qualitaetssicherung)
- [11. Projektstruktur](#11-projektstruktur)
- [12. Offene Punkte — ehrlich](#12-offene-punkte--ehrlich)
- [13. Dokumentation](#13-dokumentation)

---

## 1. Was es ist

Vier Personen arbeiten gleichzeitig in **einer** Session. Jede Änderung an Reglern, Effekten oder
Zuständen wird gespiegelt; ein Modul kann für die anderen gesperrt werden, damit niemand
gleichzeitig an derselben Sache dreht („B2B-Locking"). Das Audiomaterial bleibt dabei im Browser
und auf eigener Infrastruktur.

**Kernfunktionen**

| Bereich | Umfang |
|---|---|
| Aufnahme & Wiedergabe | Mikrofon, Instrument, Upload, Bounce, Offline-Rendering |
| Mischpult | 8 Kanäle, Gain, Fader, Pan, Cue, Monitor, Routing, 2.1-Ausgang |
| Effekte & Dynamik | Effektketten, parametrischer EQ, Kompressor/Gate/Limiter, PDC-fähiges Mastering |
| Instrumente | Synthesizer, Sampler, Drum-Machine, MIDI-Ein-/Ausgang für externe Hardware |
| Bibliothek | Samples, Tags, Suche, Metadaten |
| KI | Text/Sprache erzeugen, Stems trennen, analysieren, Visuals |
| Kollaboration | bis 4 Nutzer, gespiegelter Zustand, Plugin-Sperren, Chat |
| Visuals | Bild-/Clip-Ausgabe, Beamer, MJPEG-Rückfallweg |

**Technik in einem Satz je Schicht:** React 19 + Vite 6 + Tailwind 4 im Browser · Express 4 auf
Node ≥ 22 als Server · **AudioWorklet** (16 Prozessoren) und Rust/WASM-Kernel für die
Signalverarbeitung · Socket.io + WebRTC für die Gleichzeitigkeit · mediasoup als SFU · Supabase
für Metadaten, Cloudflare R2 für Audiodateien, OPFS/IndexedDB lokal · acht GPU-Rollen auf
RunPod-Serverless.

**Vergleich**

| | audioMONASTRY | Audacity | iZotope RX | Colab-Notebooks |
|---|---|---|---|---|
| Läuft im Browser, ohne Installation | ✅ | ❌ | ❌ | ✅ |
| Mehrere Nutzer in **einer** Session | ✅ bis 4, gespiegelt | ❌ | ❌ | ❌ |
| Plugin-Sperren inklusive | ✅ | – | – | – |
| DSP im AudioWorklet/WASM | ✅ 16 Worklets | nativ | nativ | – |
| Kosten bei Nichtbenutzung | 0 €/h (Flotte aus) | 0 | einmalig | 0 |
| Zweck | privat / Forschung | freie Audiosoftware | Restaurierung | Experimente |

---

## 2. Was es nicht ist

1. **Kein eigenes Audio-Interface.** Es gibt keine Hardware- und Treiberebene; das Gerät kommt
   vom Betriebssystem und vom Browser.
2. **Kein Kino-Audio.** Kein Dolby Atmos, kein THX, kein 7.1.4-Zwang.
3. **Keine Lichtanlage.** Visuals sind Bild- und Beamer-Ausgabe, kein DMX.

Die vollständige Abgrenzung samt Zellen-, Stille- und Skriptorium-Prüfung steht in
**[`PRINCIPLES.md`](PRINCIPLES.md)**.

---

## 3. Schnellstart

```bash
npm ci                       # Abhängigkeiten (package-lock.json ist maßgeblich)
cp .env.example .env         # Zugangstoken eintragen – .env wird NIE committet
node build-worklets.mjs      # AudioWorklets bauen (public/worklets ist gitignored)
npm run dev                  # Express + Vite auf http://localhost:8080
```

**Der Zugang ist zu, bis ein Token gesetzt ist.** Ohne `STUDIO_ACCESS_TOKEN` startet die
Anwendung, beantwortet aber **keine** API-Anfrage (HTTP 503 `STUDIO_TOKEN_MISSING`). Für lokale
Entwicklung lässt sich die Sperre bewusst öffnen:

```bash
AUDIOMONASTRY_DEV_NO_AUTH=1 npm run dev     # NUR lokal, nie in Produktion
```

> Der Name ist wichtig: bis 2026-09-23 stand in `.env.example` irrtümlich `STUDIO_DEV_NO_AUTH`.
> Diese Variable liest der Server **nicht** — sie war wirkungslos.

Ohne Cloud-Schlüssel läuft die Anwendung vollständig offline (eingebaute Voreinstellungen,
lokale Ersatzwege).

**Produktion**

```bash
npm run build                # Vite-Client + Worklets + esbuild-Server-Bundle
npm start                    # node dist/server.cjs
```

**Die wichtigsten Befehle**

| Befehl | Zweck |
|---|---|
| `npm run dev` | Entwicklungs-Server (API + Oberfläche, Port 8080) |
| `npm run build` / `npm start` | Produktionsbau / -start |
| `npm run verify` | **Freigabeprüfung** — siehe [Abschnitt 10](#10-qualitaetssicherung) |
| `npm run typecheck` · `npm run lint` | `tsc --noEmit` · ESLint ohne Warnungen |
| `npm test` · `npm run test:ci` | Vitest · Vitest mit Sperre gegen übersprungene Tests |
| `npm run test:e2e` | Playwright (Kollaboration, Hardware, Tastatur, visuell, Audio) |
| `npm run check:deadfiles` | knip: keine unerreichbaren Dateien, keine ungenutzten Pakete |
| `npm run check:bundle` | Bundle-Budget (< 2,0 MiB) |
| `npm run check:memory` | Heap-Wachstum im Client (< 512 MB) |
| `npm run proof:ffmpeg-whitelist` | Beweist die Protokoll-Whitelist der ffmpeg-Aufrufe |
| `npm run test:python:master` | Beweist die Dekodier-Grenzen des Master-Dienstes |
| `npm run generate:golden` | Golden-WAV-Referenzen für die DSP-Tests |
| `npm run audit:deep:static` | Tiefenprüfung offline (tsc/eslint/knip/npm-audit/semgrep/Grenzen/Bundle) |

---

## 4. Rechtliches

**Impressum und Datenschutzerklärung sind veröffentlicht** und **ohne Anmeldung** erreichbar:

| Seite | Adresse |
|---|---|
| Impressum | `/impressum` |
| Datenschutzerklärung | `/datenschutz` |

Beide werden vom Server als eigenständige HTML-Seiten ausgeliefert — **absichtlich nicht** als
Teil der Studio-Oberfläche und **absichtlich ohne Zugangstoken**: eine Datenschutzerklärung
hinter einer Anmeldung wäre wertlos. Verlinkt sind sie auf der Startseite vor dem Betreten des
Studios.

Sie laden **keine externen Ressourcen** — keine Schriftart, kein Skript, kein Bild von einem
anderen Server. Eine Datenschutzseite, die beim Aufruf eine Verbindung zu einem Schriftarten-
Dienst aufbaut, würde sich selbst widerlegen. Ein Test prüft das.

> **Die Betreiber-Angaben fehlen noch.** Name, Anschrift und erreichbare E-Mail sind nach § 5 DDG
> Pflicht. Solange sie fehlen, zeigt die Seite oben einen deutlichen Hinweis und nennt die
> fehlenden Felder — es wird **keine erfundene Anschrift** angezeigt. Das Ausfüllen braucht
> keinen Code-Änderung, nur diese Variablen:
>
> ```
> LEGAL_NAME="…"   LEGAL_STREET="…"   LEGAL_CITY="…"   LEGAL_COUNTRY="…"
> LEGAL_EMAIL="…"  LEGAL_PHONE="…"    LEGAL_REPRESENT="…"  LEGAL_SUPERVISORY="…"
> ```
>
> Prüfen: `curl -s localhost:8080/impressum | grep -c "noch unvollständig"`
> → `0` heißt vollständig, `1` heißt es fehlen Pflichtangaben.
>
> **Noch nicht abschließend geklärt und deshalb auf der Seite bewusst offen benannt:**
> Übermittlung in Drittländer, Rechtsgrundlagen je Verarbeitung, Löschfristen, Einordnung der
> Stimme nach Art. 9 DSGVO. Entwurf und Beleglage: `docs/RECHT_ENTWURF_DATENSCHUTZ_IMPRESSUM.md`.

**Lizenz:** proprietär, alle Rechte vorbehalten — siehe [`LICENSE`](LICENSE). Eingebundene fremde
Werke sind einzeln in `docs/LICENSE_EXTERNAL_RESOURCES.md` aufgeführt.

**Rechte an mitgeliefertem Material:** Die Demo-Titel unter `public/music/` sind **nicht** Teil
dieses Projekts, per `.gitignore` ausgeschlossen und **nur mit gültigem Zugangstoken** abrufbar
(`/music/*`).

---

## 5. Betrieb und Kosten

**Betreiber** kAInplanmusic · **Hosting** Hetzner (nbg1) · **Proxy/DNS** Cloudflare ·
**Datenbank** Supabase · **Objektspeicher** Cloudflare R2 · **GPU** RunPod-Serverless

Die Flotte läuft **stundenweise** und wird nach der Session gelöscht → **0 €/h**, wenn niemand
arbeitet. Grenzen (verbindlich, `docs/INFRA_KONSTITUTION.md`):

| Grenze | Wert |
|---|---|
| Laufende Flotte (Hetzner + GPU zusammen) | **max. 10 €/h**, Zielband 5–7,5 €/h |
| GPU-Endpunkte | max. 8 |
| Hetzner-Server | max. 5 |

**Die Hetzner-Flotte besteht aus fünf Knoten** (Rollen app / sfu / ai / master / edge):

- Hetzner fleet: `app-1` (cx23), `sfu-1` (cx23), `ai-1` (cx23), `master-1` (cx23), `edge-1` (cx23) — der Typ je Rolle ist über `FLEET_TYPE_<ROLLE>` überschreibbar, Vorgabe im Skript `scripts/hetzner/provision-fleet.sh`. Verbindliche Tabelle: `docs/SERVER_FLEET.md`.

> Diese Zeile hat eine feste Form: `tests/test_hetzner_scripts.py` liest sie aus und
> vergleicht die Typen mit den Vorgaben des Bereitstellungsskripts. Wer sie umschreibt, bricht
> die Prüfung — und genau das ist gewollt: die README soll nicht von der Flotte abweichen können.

**Not-Aus.** `KILL_SWITCH=1` (oder `MAINTENANCE_MODE=1`) sperrt alle `/api/*`-Aufträge mit
HTTP 503. `/api/health` und `/api/metrics` bleiben absichtlich offen, damit „absichtlich in
Wartung" von „abgestürzt" unterscheidbar bleibt; die Oberfläche wird weiter ausgeliefert.
Laufende Sitzungen werden **nicht** getrennt — ein Not-Aus, der Verbindungen abreißt, würde aus
einem Kostenstopp einen Datenverlust machen.

**Ruhe-Modus.** Alarme werden 22–07 Uhr nicht sofort zugestellt, sondern gepuffert und danach als
eine Sammelmeldung nachgeliefert. Kritische Alarme (`critical`/`fatal`/`page`) kommen sofort.

---

## 6. Architektur

```
┌──────────────┐   HTTPS/WSS    ┌──────────────────────────────┐
│ Browser (4×) │ ─────────────► │ app-1 · Express + Socket.io  │
│ React 19     │ ◄───────────── │ server.ts (Token-Sperre)      │
└──────────────┘   WebRTC/SSE   └───┬────────────┬─────────────┘
                                    │            │
                    ┌───────────────┘            └──────────────┐
                    ▼                                           ▼
        ┌────────────────────────┐                  ┌──────────────────────┐
        │ KI-Orchestrierung      │                  │ SFU (mediasoup)      │
        │ Jobs · Routing · MCP   │                  │ UDP/RTP              │
        └───┬─────────┬──────────┘                  └──────────────────────┘
            │         │
            ▼         ▼
  ┌────────────────┐ ┌──────────────────────┐
  │ 8 GPU-Rollen   │ │ lokal (ohne Cloud):  │
  │ RunPod         │ │ Ollama · ONNX ·      │
  │ Serverless     │ │ deterministische     │
  │ Scale-to-Zero  │ │ Ersatzwege           │
  └────────────────┘ └──────────────────────┘
            │
            ▼
  ┌───────────────────────────────────────────────────┐
  │ Supabase (Metadaten, RLS) · Cloudflare R2 (Audio) │
  │ OPFS/IndexedDB (lokal im Browser)                 │
  └───────────────────────────────────────────────────┘
```

**Audioschicht.** Es gibt genau **einen** Produktionsweg zur Ausgabe: `V2StudioGraph` →
`V2LiveSink` / `WorkletGraphRuntime` mit samplegenauem Takt (`V2SampleClock`), SharedArrayBuffer-
Ringpuffer und PDC-fähigem Mastering. Tone.js wurde am 2026-09-09 entfernt; die
Tone-kompatible Fassade liefert `src/core/audio/compat/nativeAudioKit.ts`. **Kein zweiter Pfad
zur Ausgabe** — Hörproben laufen ausschließlich über diesen Weg (2026-09-23 korrigiert, siehe
`docs/AUDIT_REPORT_2026-09-23.md` §7).

**Dienste**

| Dienst | Ort | Aufgabe |
|---|---|---|
| Anwendung/API | `server.ts` | REST, Socket.io, KI-Vermittlung, Metriken |
| KI-Laufzeit | `services/audiomonastry-ai-runtime/` | GPU-Container: `/infer`, `/mcp/tools`, `/metrics` |
| Master | `services/master-player/` | ffmpeg-Mastering, Analyse, Rendern |
| Stem-KI (optional) | `services/stem-ai/` | lokale Stem-Trennung als Ersatzweg |
| MIDI-Brücke | `services/midi-bridge/` | MIDI ↔ WebSocket |
| Portal-Worker | `services/portal-worker/` | Cloudflare: Aufwecken, Proxy, Auto-Löschen |
| SFU | `docker-compose.sfu.yml` | mediasoup, UDP 40000–40099 |
| TURN | `docker-compose.turn.yml` | Relay für schwierige Netze |

**Compose-Dateien:** `docker-compose.yml` (Basis) · `.hetzner.yml` · `.ai.yml` · `.media.yml` ·
`.monitoring.yml` · `.monitoring.proof.yml` · `.sfu.yml` · `.turn.yml` · `.fleet-test.yml`

---

## 7. Die 16 Module

Genau **16** Module („MONKs"), geladen zur Laufzeit aus `public/plugin-manifest.json`;
stimmt die Anzahl nicht, greift die eingebaute Liste. Zustände: **OFF** (transparenter Bypass) ·
**AUTO_AI** (Vorschläge) · **PRO** (volle Oberfläche). Beim Betreten des Studios startet **alles
in OFF**, die Ausgabe ist im Ruhezustand still.

| # | ID | Name | Rolle |
|---|---|---|---|
| 1 | `mixer` | mixerMONK | Mischpult: Gain, Fader, Pan, Cue, Monitor, Routing |
| 2 | `drop` | dropMONK | Drops, One-Shots, Performance-Samples |
| 3 | `song` | songMONK | Song, Arrangement, Playlist, Set |
| 4 | `effect` | effectMONK | Effekte und Effektketten |
| 5 | `syntisampler` | syntisamplerMONK | Synthesizer + Sampler |
| 6 | `drumsampler` | drumsamplerMONK | Drum-Machine, Pads, Patterns |
| 7 | `instru` | instruMONK | Instrumente, MIDI-Notensteuerung, Presets |
| 8 | `biblio` | biblioMONK | Bibliothek: Samples, Suche, Metadaten |
| 9 | `voice` | voiceMONK | Stimme: TTS, Gesang, Sprachverarbeitung |
| 10 | `sound` | soundMONK | Klangerzeugung und Sounddesign |
| 11 | `stem` | stemMONK | Stem-Trennung und -Analyse |
| 12 | `spatial` | spatialMONK | Räumlichkeit: Positionierung, 2.1/N.x, HRTF |
| 13 | `eq` | eqMONK | Parametrischer EQ |
| 14 | `dsp` | dspMONK | Verarbeitungsknoten und DSP-Ketten |
| 15 | `master` | masterMONK | Dynamik, Limiting, Loudness, PDC |
| 16 | `record` | recordMONK | Aufnahme, Bounce, Export, Offline-Rendern |

**Außerhalb der 16** (feste Systemmodule, kein Plugin-Platz): `masterplayerMONK`
(Wiedergabe/Wellenform, nur Ansicht), `aiMONK` (studio-weite KI-Steuerung), `perforMONK`
(Telemetrie/Diagnose). MIDI belegt keinen Platz, sondern liegt unter **Einstellungen → MIDI**.

**Vertrag jedes Moduls:** `initialize · setState · setParameter · process · handleCommand ·
snapshot · restore · dispose`.

---

## 8. KI-Rollen

**Acht GPU-Rollen** auf RunPod-Serverless, alle mit `workersMin: 0` (Scale-to-Zero) und
Aufwecken beim Betreten der Session:

| Rolle | Aufgabe |
|---|---|
| `brain` | Steuerung, Werkzeugaufrufe |
| `ears` | Spracherkennung, Einbettungen, Klassifikation |
| `voiceGen` | Sprachausgabe, Gesang, Effekte |
| `music` | Musikerzeugung |
| `imageHq` | Bilder in hoher Qualität |
| `videoReal` | Video, realistische Pfade |
| `videoAbstract` | Video, abstrakte Pfade |
| `orchestrator` | Planung (Mehrfach-Agenten + MCP) |

Jede Rolle ist **genau einem** Zweck zugeordnet; maßgeblich ist `GPU_ROLE_IDS` in
`src/config/aiInfrastructure.ts`, gespiegelt in `model_manifest.json` und durch
`tests/manifestRoles.test.ts` gegen Drift abgesichert.

**Ohne Cloud:** Ollama (lokales Sprachmodell), ONNX (Stem-Trennung), WebSpeech und
deterministische Ersatzwege — die Anwendung bleibt funktionsfähig.

**Kostenbremse, gemessen:** 10 Anfragen/Minute auf den teuren Wegen · **10 €/h hartes
Flottenbudget, geprüft _vor_ dem ersten Netzwerkaufruf** (bei Überschreitung startet nichts,
HTTP 409) · harte Obergrenze ist das GPU-Guthaben. Details und offene Punkte:
`docs/SEC_BLOCK2_ATTACKS.md`.

---

## 9. Sicherheitskonzept

**Zugang.** Alle `/api/*` verlangen ein Token (Kopfzeile `x-studio-token`, `?token=` oder das
HttpOnly-Cookie `studio`) — konstantzeit verglichen. Ohne Token ist die API geschlossen
(fail-closed); es gibt keinen stillen Entwicklungsmodus. Für Besucher gibt es zwei Arten von
kurzlebigen, signierten Sitzungstoken (`v1.<exp>.<hmac>`).

**Datenbank (RLS, an der laufenden Datenbank gemessen am 2026-09-23).** Der `anon`-Schlüssel
liegt im öffentlichen Client-Bundle und darf deshalb **genau zwei** Tabellen lesen:
`samples` und `music_tracks`. Alles andere ist ausschließlich serverseitig mit `service_role`
erreichbar. Nachgemessen: `anon_lesen_tabellen = 2`.

> **Diese Zahl war bis 2026-09-23 falsch.** Die Härtung lag im Repo, war aber **nie auf die
> Datenbank angewendet** — live erlaubte `anon` weiterhin SELECT auf 13 Tabellen, darunter
> `system_prompts` und `ai_evaluations`. Eine Migrationsdatei ist kein Vollzug. Der Grund, warum
> es niemandem auffiel: die Tests prüfen die **Dateien**, nicht die Datenbank. Offen als
> `DB-P2-002` in `MASTERTODOENDE.json`.

**Weitere Maßnahmen**

| Bereich | Umsetzung |
|---|---|
| Testkopfzeilen | `nosniff`, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy, CSP |
| Uploads | Art-beschränkt, Namensbereinigung, 100 MB Grenze, Chunks 32 MB, 240 Chunks/Minute |
| ffmpeg | Argumentlisten ohne Shell, `-nostdin`, Timeouts, **Protokoll-Whitelist** |
| Dekodier-Grenzen | Dauer wird **vor** dem Dekodieren aus den Metadaten geprüft; zusätzlich harte Ausgabegrenzen; unbekannte Dauer wird abgelehnt statt freigegeben |
| Demo-Titel | `/music/*` nur mit gültigem Zugang |
| Not-Aus | `KILL_SWITCH=1` |
| Dateirechte | `.env*` mit `chmod 600`; nur `.example`-Vorlagen lesbar, ohne Werte |

---

## 10. Qualitätssicherung

**`npm run verify` ist die Freigabeprüfung** und muss grün sein:

```
typecheck → lint → test → test:python → security → audio:gate → check:deadfiles → audit:deep:static
```

Gemessener Stand **2026-09-23** (dieser Zweig):

| Prüfung | Ergebnis |
|---|---|
| `tsc --noEmit` | **0 Fehler** |
| `eslint . --max-warnings=0` | **0 Fehler** |
| `vitest run` | **284/284 Dateien, 2 169/2 169 Tests** |
| `npm run verify` (vollständig) | **exit 0** |
| `knip --include files,dependencies` | keine unerreichbaren Dateien, keine ungenutzten Pakete |
| Grenzprüfung der Schnittstellen | 422 Dateien, 0 Verstöße |
| `npm audit` | 0 blockierende Befunde |
| Audio-Gate | I = −12,0 LUFS · TPK = −8,4 dBTP |
| `proof:ffmpeg-whitelist` | 6/6, inkl. Gegenprobe |
| `test:python:master` | 10/10 |
| `tests/legalPages.test.ts` | 18/18 |

**Warum das Totcode-Gate nur Dateien und Pakete prüft:** der vollständige knip-Bericht trägt
zusätzlich ~199 ungenutzte Exporte und ~90 ungenutzte Typen. Das ist ein Kaskadenthema
(`QUAL-P2-003`) und würde als Freigabekriterium dauerhaft rot stehen — ein Gate, das immer rot
ist, wird ignoriert. Der vollständige Bericht bleibt mit `npm run check:deadcode` abrufbar.

**Bekannte Warnung:** `jscpd` meldet 4 Duplikate. Sie sind bekannt und nicht blockierend.

---

## 11. Projektstruktur

```
server.ts                  Server-Einstieg: Express, Socket.io, Token-Sperre, KI-Vermittlung
server/                    Server-Module: Not-Aus, Medienzugang, Ruhe-Modus, Rechtstexte,
                           Routen (admin, agent, ai, cloud, master, media, ops, security,
                           session, stem, upload, visual, voice)
src/
  App.tsx                  Oberfläche und Startseite
  components/              Oberflächen je Modul (lazy geladen)
  core/audio/              Audiokern: V2Graph, Worklets, Routing, Ringpuffer
  core/ai/orchestrator/    Aufträge, Sitzungen, Vermittlung, MCP, Kosten
  core/session/            Sperren, Zustandsspiegelung
  plugins/                 registry.ts + die 16 Adapter
  config/                  Grenzen, Rollen, Tarife
services/                  Dienste (siehe Abschnitt 6)
scripts/                   Bau, Betrieb, Prüfungen, Beweisläufe
tests/                     Vitest + tests/e2e (Playwright)
public/                    Statische Dateien, plugin-manifest.json
docs/                      61 Dokumente: Architektur, KI, Sicherheit, Betrieb, Audits
supabase/migrations/       der ANGEWENDETE Migrationssatz
database/                  historischer Migrationssatz (siehe database/README.md)
```

---

## 12. Offene Punkte — ehrlich

Die verbindliche Liste steht in **[`MASTERTODOENDE.json`](MASTERTODOENDE.json)**:
**164 Einträge = 142 erledigt · 16 teilweise · 5 offen · 1 blockiert.** Nur offene Punkte sind
Einträge; Erledigtes steht in der Git-Historie.

**Was bewusst noch nicht da ist**

| Punkt | Warum |
|---|---|
| **Demo-Link und 15-Sekunden-GIF** | Die Flotte ist derzeit **heruntergefahren** (0 Server). Ein Link ganz oben würde ins Leere führen. |
| **Betreiber-Angaben in Impressum/Datenschutz** | Name und Anschrift kann nur der Betreiber liefern (siehe Abschnitt 4). |
| **Drittlandtransfer, Rechtsgrundlagen, Löschfristen** | Rechtliche Bewertung, keine Code-Angabe. Auf der Datenschutzseite steht deshalb offen, dass es fehlt — statt einer Vermutung. |
| **`library_links`-Tabelle** | Kein Codepfad, live **0 Zeilen**. Ein Tabellen-Drop ist irreversibel und wird deshalb nicht stillschweigend ausgeführt. |
| **Live-Prüfung mancher Angriffe** | Braucht eine laufende Umgebung: Lastversuch mit parallelen Uploads, Abruf direkt aus dem Objektspeicher. |

**Was noch nie live geprüft wurde:** dass eine leere GPU-Rechnung die Dienste wirklich stoppt
(der Codepfad ist belegt, ein echter `402` wurde nie ausgelöst). Das steht so im Infra-Audit.

Meldungen bitte mit einem Beleg — Datei, Zeile oder Befehl mit Ausgabe. Dieses Projekt hat die
Erfahrung gemacht, dass eine grüne Prüfung und eine wahre Aussage nicht dasselbe sind.

---

## 13. Dokumentation

**Zuerst lesen**

| Datei | Inhalt |
|---|---|
| `PRINCIPLES.md` | Grundsätze, Nicht-Ziele, Stille als Feature |
| `MASTERTODOENDE.json` | **Einzige Quelle der Wahrheit** für offene Arbeit |
| `docs/INFRA_KONSTITUTION.md` | Verbindliche Grenzen für Flotte und Kosten |
| `docs/AUDIT_REPORT_2026-09-23.md` | Vollständiger Audit dieser Runde, inkl. eigener Fehlkorrekturen |
| `docs/NEXT_SESSION.md` | Startzettel: Zustand, Fallstricke, nächste Schritte |
| `AGENTS.md` | Verbindliche Architektur- und Arbeitsregeln |

**Weitere Schwerpunkte:** `docs/AI_ARCHITECTURE.md`, `docs/AI_SECURITY_GUIDE.md`,
`docs/AI_COST_GUIDE.md`, `docs/ENV_MATRIX.md`, `docs/SERVER_FLEET.md`,
`docs/runpod-8-instances-complete-plan.md`, `docs/SEC_BLOCK2_ATTACKS.md`,
`docs/RECHT_ENTWURF_DATENSCHUTZ_IMPRESSUM.md`, `docs/SEC_CF_TOKEN_ROTATION.md`,
`docs/HETZNER_DEPLOY.md`, `docs/PERFORMANCE_BUDGETS_2026.md`,
`docs/QUALITY_TOOLING_2026.md`, `docs/LICENSE_EXTERNAL_RESOURCES.md`

**Zahlen in diesem Dokument** sind am 2026-09-23 gemessen. Steht irgendwo eine Zahl ohne
Belegweg, ist sie zu prüfen, nicht zu glauben.
