# audioMONASTRY

**Status: Alpha · privates Forschungs- und Entwicklungsprojekt · keine kommerzielle Nutzung**

> **audioMONASTRY ist ein browserbasiertes, kollaboratives Tonstudio (DAW) für bis zu vier
> Personen gleichzeitig: gemeinsam an derselben Session arbeiten, ohne proprietäre Plugins
> und ohne Bindung an einen einzigen Cloud-Anbieter.**

![audioMONASTRY in 15 Sekunden: Startbildschirm, dann das Studio mit Mastergraph, Mixer und Wellenform](docs/media/audioMONASTRY-demo.gif)

*15 Sekunden, ohne Schnitt: Startbildschirm, dann das Studio mit Mastergraph (132 BPM, C Minor),
Mischer mit Wellenform und Hot Cues A-H sowie der aiMONK-Eingabezeile. Aufgenommen am 2026-09-24
auf einem einzelnen Rechner - **nicht** in einer Vier-Personen-Sitzung und **nicht** auf der Flotte.*

*Neu erzeugen: `npm run dev` in einem Terminal, dann `npm run demo:gif`.*

---
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
für Metadaten, Cloudflare R2 für Audiodateien (kein verdeckter Gerätespeicher; Ausnahmen siehe AGENTS.md §2.2) · acht RunPod-Pods der 48-GB-Klasse (Ist: 8×A40; A01/A04 mit Ada-Ziel); siehe `docs/RUNPOD_FLEET_SSOT.md`.

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
**Datenbank** Supabase · **Objektspeicher** Cloudflare R2 · **GPU** RunPod-Pods (Ist: 8 × A40 48 GB; Ziel A01/A04 RTX 6000 Ada)

Die Flotte läuft **stundenweise** und wird nach der Session gelöscht → **0 €/h**, wenn niemand
arbeitet. Grenzen (verbindlich, `docs/INFRA_KONSTITUTION.md`):

| Grenze | Wert |
|---|---|
| Laufende Flotte (Hetzner + GPU zusammen) | **max. 10 €/h**, Zielband 5–7,5 €/h |
| GPU-Pods | Ziel: acht 48-GB-Pods; A01/A04 RTX 6000 Ada, übrige vorläufig A40; max. 42 GB Nutzlast + 6 GB Reserve |
| Hetzner-Server | max. 5 |

**Die Hetzner-Flotte besteht aus vier Knoten** (Rollen app / sfu / media / edge):

- Hetzner fleet: `app-1` (cx43), `sfu-1` (cx33), `media-1` (cx43), `edge-1` (cx23) — der Typ je Rolle ist über `FLEET_TYPE_<ROLLE>` überschreibbar, Vorgabe im Skript `scripts/hetzner/provision-fleet.sh`. Verbindliche Tabelle: `docs/SERVER_FLEET.md`.

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
  │ RunPod A40     │ │ ONNX · WebSpeech ·   │
  │ 8 Pods / 48 GB │ │ deterministische     │
  │ SSOT-Modellset │ │ Ersatzwege           │
  └────────────────┘ └──────────────────────┘
            │
            ▼
  ┌───────────────────────────────────────────────────┐
  │ Supabase (Metadaten, RLS) · Cloudflare R2 (Audio) │
  │ (kein verdeckter Gerätespeicher, AGENTS.md §2.2)   │
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
stimmt die Anzahl nicht, greift die eingebaute Liste. Modi in der Oberfläche (Modus-Button rechts
am Plugin, OFF → STBY → ON → OFF): **OFF** (frei, transparenter Bypass, jede Person darf es holen) ·
**STBY** (einer Person zugeordnet, noch nicht aktiv) · **ON** (aktiv, Bedienfläche beim Halter offen).
Fremde Plugins sind gesperrt, es gibt kein Anfragen und kein Übernehmen. `mixerMONK` ist immer ON und
hat immer genau einen Halter; nur der Halter übergibt ihn. KI-Vorschläge laufen über `aiMONK`.
Intern bilden sich die Modi auf den replizierten Modul-Zustand (`OFF`/`PRO`) und den zentralen Lock ab
(`src/core/session/pluginMode.ts`); `AUTO_AI` ist nur noch Altbestand im Vertrag. Spielende Plugins
haben eine **SYNC**-Taste gegen Main (Standard an). Beim Betreten des Studios startet **alles in
OFF**, die Ausgabe ist im Ruhezustand still.

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

**Außerhalb der 16** (feste Systemmodule, kein Plugin-Platz): `mastergraphMONK`
(Wiedergabe/Wellenform, nur Ansicht), `aiMONK` (studio-weite KI-Steuerung), `perforMONK`
(Telemetrie/Diagnose). MIDI belegt keinen Platz, sondern liegt unter **Einstellungen → MIDI**.

**Vertrag jedes Moduls:** `initialize · setState · setParameter · process · handleCommand ·
snapshot · restore · dispose`.

---

## 8. KI-Pods: A01–A05 Ziel-SSOT und Agenten-Handoff (10.11.2026)

> **STATUS: BESCHLOSSENE ZIELPLANUNG, NOCH NICHT IMPLEMENTIERT.** Die hier beschriebenen Entscheidungen für **A01–A05** sind im Gespräch festgelegt. Die ausführbare Flotten-SSOT [`deploy/runpod/pod-fleet.json`](deploy/runpod/pod-fleet.json), das GPU-[`model_manifest.json`](services/audiomonastry-ai-runtime/model_manifest.json), zugehörige Handler und Routings sind **noch nicht angepasst oder auf RunPod getestet**. Sie enthalten noch die alten Belegungen. **Nicht aus der README auf laufende Deployments schließen.** Für A06–A08 läuft die Einzelprüfung weiter; auf A08 sind UniverSR und DeReverb als ausgelagerte Aufgaben vorgesehen.

**Hardware-Budget:** 48 GB VRAM pro GPU, maximal 42 GB geplante Last, 6 GB Sicherheitsreserve. Alle nachfolgenden VRAM-Bereiche sind **geschätzt**, einschließlich angenommenem Laufzeit-Overhead; kein A40-/Ada-Livemesswert. Checkpoint-Dateigröße, GPU-Gewichtsbedarf, KV-Cache und Inferenz-Peak sind unterschiedliche Größen. Langform-Audio und 4 parallele DAW-Nutzer erfordern zusätzliche Lasttests. Private Test-/Forschungsnutzung; Lizenzen werden dokumentiert, sind aber kein Modell-Auswahlfilter dieses Reviews.

### 8.1 Acht-Pod-Übersicht (A01–A05 beschlossen; A06–A08 noch offen)

| Pod | Residente Zielmodelle / aktuelle Ist-Belegung | Geplanter VRAM |
|---|---|---:|
| **A01 brain – NEU** | **Qwen3.8-27B-FP8** allein; kleines GUI-Modell ausgelagert, noch nicht ausgewählt | **34–40 GB** (Schätzung) |
| **A02 ears – NEU** | **MOSS-Music-8B-Instruct BF16, CLAP Music FP16, Beat This! FP32, SongFormer BF16-Ziel, audioFlux+librosa CPU, Basic Pitch CPU** | **27,5–37 GB** (Schätzung) |
| **A03 voice – FEST** | Qwen3-TTS CustomVoice + VoiceDesign, MOSS SoundEffect v2, ACE-Step XL Base + Shared; **kein Stimmenklonen** | **36 GB** nominell |
| **A04 music – FEST** | ACE-Step XL Turbo BF16, 5Hz LM 4B BF16, Shared BF16; **kein SFT** | **27 GB** inklusive LM-Runtime-Budget |
| **A05 studio – MODELLWAHL FEST** | SonicMaster, BS-RoFormer SW 6-Stem, Mega 53, BVE; **keine Fallbacks**; UniverSR/DeReverb zu A08 | **≥33 GB**, Peak ≤42 GB **noch nicht bewiesen** |
| A06 audio-brain – BISHER | `qwen3-omni-30b`; Überschneidung mit neuem A02 gesondert prüfen | 28 GB |
| A07 song – BISHER | `yue2-3b` | 24 GB |
| **A08 vis – OFFEN** | Visual-Rendering + **UniverSR** und **DeReverb** aus A05; MOSS-Ergebnisse aus A02 statt Music Flamingo angestrebt; bislang nur Planung | **15 GB** Teilbudget ohne Flamingo/Runtime |

### 8.2 A01 brain: zentrale interne KI – Aufgaben und Modell

**Produktrolle, keine Entwicklungs-Agentenrolle:** A01 ist das **interne Gehirn** der fertigen audioMONASTRY. Es verwaltet fachliches Wissen zu Audio, Audiobearbeitung, Musik, Musikgeschmack, Musikpsychologie, Psychoakustik und zur tatsächlichen Anwendung. Es ist **Router und „Chef“ der spezialisierten Pods**: Aufträge verstehen, zuständige Modelle auswählen, Prompts entwickeln/verbessern, Kontext und Parameter übergeben. **Kein eigenes Benutzer-Chatfenster, kein Code-Debugger, kein eigenständiges Ausführen von GUI-Befehlen oder Audio-DSP.** Interaktionen mit Nutzern erfolgen per Texteingabe an die App.

| Feld | Beschluss und technische Einordnung |
|---|---|
| Modell (einziges resident geplantes LLM) | **[Qwen3.8-27B-FP8](https://huggingface.co/Qwen/Qwen3.8-27B-FP8)**; offizieller Hersteller-Checkpoint |
| Typ | ca. 27B Dense mit hybrider Linear-/Full-Attention, Sprach-/Bildencoder; native Multimodalität ist eine Modellfähigkeit, **keine zusätzliche Produktfunktion für A01** |
| Gewichte | **FP8** (feingranulare Block-128-Quantisierung, laut offizieller Model Card), nicht INT4, nicht alter Qwen3.5-GPTQ-Alias |
| Bedarf | **34–40 GB geschätzte Gesamtlast** inklusive angenommenem Runtime-/Kontextanteil bei moderatem Kontext; **keine gemessene Kontextlänge bei 42-GB-Limit** |
| Modell-Repository/Revision | HF-Link oben; **konkrete Commit-SHA und Gewichts-Hashes müssen noch gepinnt werden** |
| Laufzeit | vLLM oder SGLang als Kandidat; Version, CUDA, Tensor-/FP8-Kernels, tatsächliche Performance vor Installation prüfen |
| Input | textbasierter interner Auftrag, Appzustand/Projekt, verfügbares Tool-/Pod-Schema, ausgewählte Wissens-/Retrieval-Segmente |
| Output | interne Routing-Entscheidung, Zielmodell, vorbereiteter/optimierter Prompt, validierte Parameter, Fehler-/Statusinformation; **keine direkte GUI-Aktion durch das Brain** |
| Wissen | Audio-/Musik-/Plugin-Wissen aus gepflegter externer Knowledge-Basis/Retrieval + App-Zustand zuführen; kein unbegrenztes Wissen im Checkpoint behaupten |
| Bewertung | Hersteller-Benchmarks nur Referenz; eigene audioMONASTRY-Tests für musikwissenschaftliche Korrektheit, Routing-Treffer, Prompt-Qualität, Schema-Treue, Halluzinationen |
| Offene Leistungsfragen | Latenz bis erstes Token, Token/s, zulässiger Kontext, KV-Cache, max. gleichzeitige Requests, Peak-VRAM, Verhalten bei 4 Nutzern |

**A01-GPU-Folge (je 48 GB, native FP8-Tensor-Cores, Preisgrenze <1 USD/GPU-Stunde):**

1. **RTX 6000 Ada** – primär.
2. **NVIDIA L40S** – Fallback 1.
3. **NVIDIA L40** – Fallback 2.

Stundenpreise und konkrete RunPod-Verfügbarkeit **vor Provisionierung live prüfen**; bekannte öffentliche Beispielpreise sind kein zugesichertes Mietangebot. Die alte A40 ist auf A01 **nicht** die gewünschte Primärkarte für FP8. Alle drei Ada-Karten unterstützen BF16/FP16/FP8 nativ.

**Kleines schnelles GUI-Ausführungsmodell:** Ein **separates, noch nicht gewähltes** Modell soll kontrollierte Funktionen der fertigen App ausführen (UI-/GUI-Aktionen über explizit erlaubte Commands); **nicht** resident auf A01. Anderer Ziel-Pod, Checkpoint, Quantisierung, Event-/API-Schema und Zugriffsgrenzen **offen**, daher **keine** automatische Zuordnung zu A02 und **kein** stillschweigend gewähltes Qwen3.5-2B. Frontend-/Session-Rechte beachten; AudioWorklet-Thread niemals durch LLM-Aufträge blockieren.

### 8.3 A02 ears: sechs fest ausgewählte Komponenten, nur Musikanalyse

**Klare Produktgrenze:** keine Spracheingabe, keine Whisper-STT-Transkription, keine Pyannote-Sprecherdiarisierung, kein Qwen2-Audio-7B. A02 analysiert **Musik** (auch Songs mit Gesang), versteht akustische und musikalische Merkmale und liefert strukturierte Ergebnisse an die übrigen Pods. **Keine** Ton-/Song-Generierung, kein zusätzlich residentes ACE-Step/LEGO-Modell auf A02; ACE-Step kann die Analysewerte auf anderen Pods verwenden.

| # | Modell / Quelle | Gewählte Präzision | Geschätzter Gesamt-GPU-VRAM | Zuständigkeit |
|---|---|---|---:|---|
| 1 | **[MOSS-Music-8B-Instruct](https://huggingface.co/OpenMOSS-Team/MOSS-Music-8B-Instruct)** | **BF16** | **22–28 GB** | Musikalisches Verständnis, Genre, Instrumente, Stimmung, Harmonik, Akkorde, Tonart, Songfragen, zeitliche Songinterpretation |
| 2 | **[LAION CLAP Music](https://huggingface.co/laion/larger_clap_music)** | **FP16** | **3–4 GB** | Audio-Text-Embeddings, semantische Ähnlichkeit, Suche, Song-/Sample-Vergleich |
| 3 | **[Beat This! `final0`](https://github.com/CPJKU/beat_this)** | **FP32** | **0,5–2 GB** | Beat- und Downbeat-Zeitpositionen; Ableitung von BPM/Tempoverlauf |
| 4 | **[SongFormer](https://huggingface.co/ASLP-lab/SongFormer)** | **BF16 angestrebt**, Checkpoint derzeit **F32** | **2–3 GB** | Abschnittssegmentierung, Intro/Verse/Chorus/Bridge/Outro, Zeitgrenzen |
| 5 | **[audioFlux](https://github.com/libAudioFlux/audioFlux) + [librosa](https://github.com/librosa/librosa)** (ein gemeinsames Werkzeugpaket) | **CPU FP32/FP64 je Funktion** | **0 GB GPU** | deterministische Signalmetriken: RMS, Frequenzen, Spektrum, Chroma, Onsets, Klangmerkmale |
| 6 | **[Spotify Basic Pitch](https://github.com/spotify/basic-pitch)** | **CPU-Backend** | **0 GB GPU** | Audio-to-MIDI (Noten/Pitch-Bends) vorzugsweise isolierter Instrumente/Stems |

**Summe:** MOSS 22–28 + CLAP 3–4 + Beat This 0,5–2 + SongFormer 2–3 = **27,5–37 GB** geschätzte GPU-Last. Plus CPU-/RAM-Bedarf für audioFlux/librosa und Basic Pitch. **Bis 42 GB**: rechnerisch mindestens 5 GB frei bei 37 GB Last; zusätzlich 6 GB Sicherheitsreserve bis zur 48-GB-Grenze. Die obere Spanne ist **kein Leistungstest unter Parallelität**. Längere Songs und überlappende Analysen können höhere Peaks verursachen.

**Details für Implementierungsagenten:**

1. **MOSS-Music ist NICHT MOSS-Audio.** Exakt `OpenMOSS-Team/MOSS-Music-8B-Instruct` laden, nicht das bereits im Altmanifest vorhandene `moss-audio-8b-instruct`. Offiziell ca. **9,1B Parameter**, Modellarchitektur mit Audio-Encoder/Adapter und Qwen3-8B-Backbone; HF-Repository ca. **18,1 GB Checkpoint-Dateien** (nicht Peak-VRAM). Der Publisher beschreibt Genre-/Stimmungs-/Instrumenten-Tags, Key/Tempo/Chord-Reasoning, Struktur und Musik-QA. Anbieter-Benchmark **80,38 %** ist kein unabhängiger GPU-Gütenachweis. Die Herstelleranleitung nutzt SGLang und `trust_remote_code`; Code/Revision prüfen, `BF16` für gesamten Audiopfad erzwingen und auf GPU nachweisen. Kein INT4-/INT8-Downquantisieren im beschlossenen Ziel. Die im Herstellerprojekt ebenfalls beschriebene Lyrics-ASR-Fähigkeit wird **nicht** als Sprachsteuerung genutzt.
2. **CLAP Music** verwendet semantische Audio↔Text-Embeddings; **keine** exakten Beats, Akkordtabellen oder isolierten Noten. Das bisherige `clap-music` ist im alten `model_manifest.json` vorhanden und wird übernommen. FP16 GPU-Ladeweg gegen Checkpoint-Original messen. Embeddings über Modellrevision, Normalisierung, Index-Version und Vergleichsmetrik reproduzierbar halten.
3. **Beat This!** erhält den offiziellen `final0`-Checkpoint (vom Upstream beschrieben mit ca. **78 MB Dateigröße**, **nicht** 78 MB Peak-VRAM). Exakte Beat-/Downbeat-Zeitstempel statt nur freier Musikbeschreibung; Tempo aus Zeitabständen bestimmen. Standardinferenz FP32 (`float16=False`). Offizieller Code/Weights MIT. Der alte `beat-this`-Eintrag im Manifest hat noch `PIN-ERFORDERLICH`; konkreten Code-Commit/Checkpoint-URL/Datei-SHA256 vor Runtime-Einbau nachtragen.
4. **SongFormer** soll Songteile und deren Start-/Endzeiten liefern. Offizieller HF-Code nutzt `AutoModel.from_pretrained(..., trust_remote_code=True)` und im Beispiel **24 kHz** Audio. Die publizierten Gewichte sind im vorhandenen Manifest als **F32** vermerkt; die gewünschte **BF16-Laufzeit** ist daher erst nach Label-/Boundary-Vergleich mit F32 erlaubt. F32 als Fallback würde die 2–3-GB-Schätzung verändern; ggf. temporär statt parallel laden. Im alten Manifest ist SongFormer vorhanden, jedoch nicht Teil der bisherigen residenten A02-Podliste.
5. **audioFlux + librosa** ist ausdrücklich ein **CPU-only**-Werkzeugpaket ohne GPU-Modellgewichte. Software-Versionen, Resampler, Kanalbehandlung, FFT-/Hop-Parameter, Zeitbasis und Einheiten festlegen. Messen statt Musikgenres zu raten; Chroma ist ein Indiz, kein mathematischer Beweis einer Tonart.
6. **Basic Pitch** ist **nicht optional**: CPU-Audio→MIDI mit Noten-Start/Ende, Pitch und Pitch-Bends. Auf isolierten Instrumentenspuren weit sinnvoller als bei dichtem Full-Mix; kein Stem-Splitter. CPU-Backend inkl. Version und MIDI-Export validieren. Die beiden CPU-Komponenten können CPU/RAM-/Latenzengpässe verursachen, auch wenn sie 0 GB GPU-VRAM planen.

**A02-Hardware (noch keine Änderung beschlossen):** **A40 48 GB** ist technisch passend und unterstützt **BF16/FP16/FP32 nativ**, anders als A01 benötigt A02 keine FP8-Hardware. Für maximale Geschwindigkeit unter 1 USD/h **RTX 6000 Ada** erwägen, **L40S/L40** als weitere schnellere 48-GB-Alternativen; in BF16/FP16/FP32 ist die höhere Ada-Rechenleistung nützlich, die **Analysequalität des gleichen Checkpoints ändert sich nicht automatisch**. A40/RTX A6000 bleiben günstige Optionen. **Bis zur GPU-Entscheidung ist A40 die geplante A02-GPU.** CPU-Kernzahl/System-RAM für librosa/audioFlux/Basic Pitch und vier Jobs ebenfalls prüfen.

### 8.4 A02 Analyse-Schnittstelle (Entwurf; noch keine existente API)

| Feld | Anforderung |
|---|---|
| Anfrage | `sessionId`, Audio-Assetreferenz, `task`, `timeRange`, Sample-Rate, Versionskennung |
| Mögliche `task` | `music.describe` / `music.embed` / `music.beats` / `music.structure` / `music.features` / `music.to_midi` |
| Response | JSON mit `modelId`, `revision`, `segments`/`timestamps`, `values`+Einheiten, `confidence`/`uncertainty`, Ausführungsstatus und Zeitbasis |
| Zeitliche Korrektheit | Beat-/Downbeat-/SongFormer-Segmente auf gemeinsame Sekunden-Zeitachse und Audiolänge abgleichen |
| Sicherheit/Last | Keine Cross-Session-Daten; bounded queue, Einzeljob-Limits, Timeouts, backpressure, ≤42-GB-GPU-Gate, 4-Nutzer-Test |
| Plugin-Verbraucher | songMONK, stemMONK, biblioMONK, instruMONK, mix-/master-/spatialMONK nur über bereits freigegebene App-Schnittstellen |

### 8.5 A03 voice — FEST, 5 Komponenten, kein Cloning

**Feste Funktionen:** neue Stimmen textbasiert gestalten (VoiceDesign), synthetische Sprachausgabe mit auswählbaren Standardstimmen (CustomVoice), Soundeffekte/Atmosphären (MOSS SoundEffect v2), ACE-Step LEGO/Extract/Complete (XL Base). **KEINE Stimmmuster-Kopie, KEIN Klonen, KEINE Voice-Conversion, KEIN MeanVC2.** VoiceDesign bedeutet eine neue Stimme aus einer Textbeschreibung, nicht das Nachbilden einer hochgeladenen Person.

| Alias | Festes Modell / Modellquelle | Genau gepinnte Revision | Präzision | nomineller VRAM |
|---|---|---|---|---:|
| `qwen3-tts-17b` | [Qwen3-TTS-12Hz-1.7B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) | `0c0e3051f131929182e2c023b9537f8b1c68adfe` | BF16 | 8 GB |
| `qwen3-tts-voicedesign` | [Qwen3-TTS-12Hz-1.7B-VoiceDesign](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign) | `5ecdb67327fd37bb2e042aab12ff7391903235d3` | BF16 | 8 GB |
| `moss-soundeffect-v2.0` | [MOSS-SoundEffect-v2.0](https://huggingface.co/OpenMOSS-Team/MOSS-SoundEffect-v2.0) | `e35df4d82fbe87fcd5d14e5d100e349c0c3c076d` | BF16 | 8 GB |
| `acestep-v15-xl-base` | [ACE-Step 1.5 XL Base](https://huggingface.co/ACE-Step/acestep-v15-xl-base) | `220c1166efbdd9583eafcb12eb160594bbfcb241` | F32-Gewichte → BF16 zur Laufzeit | 10 GB |
| `acestep-v15-shared` | [ACE-Step1.5](https://huggingface.co/ACE-Step/Ace-Step1.5), nur `vae/` und `Qwen3-Embedding-0.6B/` | `19671f406d603126926c1b7e2adc169acbcade22` | BF16 | 2 GB |
| **Summe** | **5 Komponenten; Shared ist kein autonomes Generierungsmodell** | | | **36 GB** |

**VRAM/Hardware:** zunächst **A40 48 GB**, 42 GB striktes Nutzlastlimit + 6 GB Hardware-Reserve. Die 36 GB stammen aus bisherigen Modellschätzungen, nicht aus Messungen; **6 GB bis zum Limit müssen die sonstige Runtime-Last und Peaks abdecken**. 4 simultane Jobs müssen vor Freigabe gemessen werden. Keine zusätzliche Quantisierung ohne erneute Abstimmung. **Entfernen:** `qwen3-tts-06b-base` aus residenten Modellen und Clone-Routing. ACE-Step XL Base gehört wegen **LEGO, Extract, Complete** auf A03, auch wenn A04 separat XL Turbo nutzt. Tatsächliche Handler-Funktionen, BF16-Konvertierung, Modell-Shards, VAE/Encoder-Laden und hörbare Ausgaben prüfen.

### 8.6 A04 music — FEST: XL Turbo + 4B-LM + Originalgewichte

**Entscheidung:** **ACE-Step XL SFT entfernen**. Das einzige residente XL-DiT auf A04 ist **XL Turbo**. Hinzu kommen **ACE-Step 5Hz LM 4B**, der originale **Qwen3-Embedding-0.6B**-Textencoder sowie der originale **VAE**. **Alle Gewichte BF16**, keine INT4/INT8-Gewichtsquantisierung, keine ungeprüften Fremdgewichte. Das LM muss tatsächlich für Generierungen angeschlossen werden; bestehende `llm_handler=None`-Pfade schließen diese Anforderung nicht ein.

| Modell/Pack | Quellrepository | Revision | GPU-Datentyp | nomineller VRAM |
|---|---|---|---|---:|
| `acestep-v15-xl-turbo` | [ACE-Step/acestep-v15-xl-turbo](https://huggingface.co/ACE-Step/acestep-v15-xl-turbo) | `d4a0b288b83ebb7e25a8c0b32c573c22e134e8ee` | Quellgewichte F32 → **BF16** | 10 GB |
| `acestep-5hz-lm-4b` | [ACE-Step/acestep-5Hz-lm-4B](https://huggingface.co/ACE-Step/acestep-5Hz-lm-4B) | `0a3ec94b557aea7d508da38b31cfe7341f6ff737` | **BF16** | 9 GB |
| `acestep-v15-shared`: `vae/` und `Qwen3-Embedding-0.6B/` | [ACE-Step/Ace-Step1.5](https://huggingface.co/ACE-Step/Ace-Step1.5) | `19671f406d603126926c1b7e2adc169acbcade22` | **BF16** | 2 GB |
| vLLM-/KV-/Runtime-Budget (kein eigener Checkpoint) | – | – | – | 6 GB |
| **Basis-Planung** | | | | **27 GB** |

**Artefakte:** vollständige XL-Turbo-Safetensors-Shards samt Index; alle 4B-LM-Shards samt Index, Tokenizer/Configs; `Qwen3-Embedding-0.6B/model.safetensors`; `vae/diffusion_pytorch_model.safetensors`. Weitere vom Loader verlangte Assets wie `silence_latent.pt` nicht unterschlagen; mit Hash/Revision fixieren. Der Shared-Eintrag ist **kein** separates fünftes Generierungsmodell, und nicht doppelt laden. Der gewonnene Speicher aus SFT-Entfernung ist für realen LM-KV-Cache, Batches und Laufzeitspitzen bestimmt; 27 GB Basis lassen bis zum Limit 42 GB **15 GB rechnerischen Spielraum**, aber **keine belegte tatsächliche Parallelkapazität**.

**GPU beschlossen:** **RTX 6000 Ada 48 GB primär**, Hardware-Alternativen **L40S → L40**, A40 als günstige Option; Preisobergrenze **1 USD/GPU-Stunde**. Alle müssen im 42-GB-Limit bleiben. Eine schnellere GPU beschleunigt ggf. Inferenz, aber macht dieselben Gewichte nicht musikalisch besser. Agenten prüfen `gpu_memory_utilization` in vLLM, damit das LM die DiT nicht verdrängt; unter 4 Nutzerlast GPU-Peaks, Walltime, Audioqualität und ursprüngliche Prompt-Kontrolle messen. **Kein XL SFT auf A04.**

### 8.7 A05 studio — FEST: 4 Modelle, Schwerpunkt hochwertiges Mastering & Stems

**Feste Modellwahl:** SonicMaster, BS-RoFormer SW 6-Stem, MVSep Mega 53 und Mel-Band RoFormer BVE (Lead-/Backing-Vocals). **Keine Fallback-Separatoren**, kein SCNet XL, kein HTDemucs 6S, keine Stimme klonen/konvertieren, kein MeanVC2. **UniverSR und DeReverb bewusst von A05 auslagern** (vorgesehen für A08; `8.8).

| Alias / Modell | Modellquelle / Checkpoint | Präzision | GPU-Budget |
|---|---|---|---:|
| `sonicmaster` | [amaai-lab/SonicMaster](https://huggingface.co/amaai-lab/SonicMaster), `93c7fa73c4dd446c9e656af34524b5f6a416afda` | FP16 | 8 GB |
| `bs-roformer-sw-6stem` | [FractalSurfer/BS-RoFormer-SW-6stem](https://huggingface.co/FractalSurfer/BS-RoFormer-SW-6stem), `2b98254b19bdab07ce225d884ec4aa9dd8aafce1` | BF16-Autocast; auf Audiotreue prüfen | 6 GB |
| **NEU** `mvsep-mega-53` | [ZFTurbo MSST v1.0.21](https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/tag/v1.0.21), `mvsep_mega_model_bs_roformer_53_stems_v1.ckpt` + passendes YAML | **Originale Quellpräzision**, keine INT8/INT4; Checkpoint ggf. in Half gespeichert | **mindestens 16 GB** (KEINE bekannte Obergrenze) |
| **NEU** `mel-roformer-bve` | [Gonzaluigi/Mel-Band-Roformer-BVE-Gonzaluigi](https://huggingface.co/Gonzaluigi/Mel-Band-Roformer-BVE-Gonzaluigi), `config_bve_gonza.yaml` + zugehöriger Checkpoint (SHA/Revision noch pinnen) | FP32 zunächst; Upstream-Mixed-Precision validieren | 3 GB |
| **Basislast ab** | | | **33 GB** |

**HARTES LIMIT: GPU-Peak ≤42 GB bei zusammen residenten Modellen und 4 parallelen Nutzern.** **6 GB Sicherheitsreserve** bis 48 GB müssen real frei bleiben. 8+6+16+3=33 GB bedeutet **nur 9 GB** für *sämtliche* Mega53-Mehrlast über 16 GB, CUDA-Kontext, Aktivierungen, Buffers und weitere parallele Jobs. Das ist **kein Beweis**, dass A05 unter 42 GB passt. Laut Release sind für Mega53 **mindestens** 16 GB bereits bei Batch 1 angeraten; reale Spitzen ungemessen. **Nicht deployen, bevor das nachgewiesen ist.** Falls >42 GB: **BVE zusätzlich nach A08 auslagern oder Pod-Verteilung erneut beschließen**, *keine* versteckte Quantisierung und *kein* Ersatzmodell. A05 zunächst **A40 48 GB**; Ada/L40S erhöht Tempo, **nicht** die Speicherkapazität. Mega53 produziert bis zu 53 überlappende Kategorien, die sich **nicht** zum Originalmix aufaddieren lassen.

### 8.8 A08-Auslagerungsauftrag (A08 noch nicht separat finalisiert)

| A08-Modell / Komponente | Quellrepository | Präzision | vorgesehenes Budget |
|---|---|---|---:|
| `universr` | [woongzip1/universr-audio](https://huggingface.co/woongzip1/universr-audio), `1c3294844285af851b6ffa56cbde4e43cd41fc2b` | FP16 | 4 GB |
| `mel-roformer-dereverb` | [anvuew/dereverb_mel_band_roformer](https://huggingface.co/anvuew/dereverb_mel_band_roformer), `cef05ad2b5b3145ea5c149d3ad5d1f8439b34d06` | FP32 | 3 GB |
| Bisheriger visueller Renderer/NVENC | vorhandene Fotos/Videos, keine Visual-Generierung | – | 8 GB bisheriger Ansatz |

**Aus A05 ausgelagert:** UniverSR und DeReverb; beide **bleiben funktionale Bestandteile der DAW**. Mit dem Renderer ergibt das nominal **15 GB ohne** das bisherige Music Flamingo und ohne ungemessenen Laufzeitpuffer. MOSS-Music auf A02 soll die musikalischen Analyse-Informationen für A08 liefern. **A08 ist noch nicht vollständig beschlossen; Music Flamingo steht noch im Ist-JSON.** Kein Agent darf Restaurierung aus A05 entfernen und auf A08 ohne funktionierende Endpoint-/Routing-Integration als erledigt bezeichnen. Audio-Reparaturjobs haben geringere Priorität als laufende Visual-Ausgabe.

### 8.9 Verbindliche Implementierungs- und Testgrenzen für A03–A05

**Diese README + `docs/RUNPOD_FLEET_SSOT.md` fixieren die vereinbarte ZIELPLANUNG.** Die ausführbare `deploy/runpod/pod-fleet.json` und `services/audiomonastry-ai-runtime/model_manifest.json` sind **noch ALT**. Es gibt **noch keine** neue Runtime-Konfiguration, keine nachgewiesene GPU-Auslastung und keine implizite Freigabe, Modelle ohne eigene Handler als aktiv zu melden.

1. A03 `qwen3-tts-06b-base` und alle Clone-Aufrufe entfernen. A04 `acestep-v15-xl-sft` entfernen; 4B-LM tatsächlich anbinden. A05 `meanvc2`, `scnet-xl-4stem`, `htdemucs-6s` entfernen. A05 `universr` nach A08; `mel-roformer-dereverb` auf A08 einrichten. **Keine Modell-Fallbacks für A05.**
2. A05 `mvsep-mega-53` und `mel-roformer-bve` neu in Manifest/Handlers registrieren, Checkpoint-URL/Commit und alle Dateihashes pinnen; korrekte Configs, Sample-Rate, Kanalzahl, 53-Kategorien-Mapping, Lead-/Backing-Output und Zeitachsen testen.
3. Echte hörbare Ein-/Ausgaben je Modell statt Mock-only: TTS Design/CustomVoice, SFX, LEGO/Extract/Complete, XL Turbo+4B-LM, SonicMaster, SW-6-Stem, Mega53, BVE, ausgelagertes UniverSR/DeReverb.
4. Sicherheits-/Performance-Gates: Datei-/Gewichts-Hashes, Risiko von Pickle/Remote-Code prüfen, bounded Audio-Chunks, RAM-/CPU-/GPU-Messung, Session-Isolation, Timeouts, Latenz, 4 parallele DAW-Sessions, **Peak ≤42 GB je 48-GB-Pod**. Fail-closed, wenn A05 überläuft. Lizenzangaben bei privater Testnutzung dokumentieren, aber nicht als aktuellen Auswahlfilter verwenden.

**Primärquellen:** [ACE-Step Modell-/GPU-Registry](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/INSTALL.md) · [Mega53 Release](https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/tag/v1.0.21) · [Mega53-MVSep](https://mvsep.com/algorithms/135) · [BVE Config](https://huggingface.co/Gonzaluigi/Mel-Band-Roformer-BVE-Gonzaluigi/blob/main/config_bve_gonza.yaml).

### 8.10 Umsetzung – bisherige A01/A02-Hinweise

- **Nicht** aus diesem README-Commit schließen, dass die laufende Flotte oder GPU-SSOT umgestellt ist. Für wirkliche Umsetzung: `deploy/runpod/pod-fleet.json`, `services/audiomonastry-ai-runtime/model_manifest.json`, Runtime-/Docker-Images, Modell-Handler, Routing, UI-Integration und Tests separat ändern, dabei alte A01-/A02-Modelle aus den *residenten* Listen entfernen.
- A01 alt: `qwen3-30b-a3b-awq` (tatsächlich Qwen3.5 GPTQ unter irreführendem Alias), `qwen3-4b`. A02 alt: `whisper-large-v3`, `pyannote-diarization`, `qwen2-audio-7b`, `mert-v2-330m`, `ast-audioset`, `essentia`. **CLAP bleibt**.
- **A06 und A08 nicht eigenmächtig im ausführbaren JSON ändern.** A06 Omni bleibt noch aktiv; A08 Music Flamingo steht noch im JSON, obwohl die neue Zielplanung UniverSR/DeReverb dort reserviert und MOSS-Analysen von A02 vorsieht. A08 wird separat finalisiert. **Keine Bild-/Video-Generierungsmodelle ergänzen.**
- MOSS und SongFormer benötigen genaue Pinned Revisions und Prüfung ihres Custom Codes; alle Checkpoints hash-pinnen. Die Lizenzdetails für private Tests dokumentieren, jedoch nicht als Auswahlfilter erfinden.
- **Test-Gates:** Ein echter vollständiger Audio-Durchlauf je Modell, Beat-/Struktur-Zeitstempel auf Referenzsongs, CPU-Auslastung und RAM, Peak-GPU-VRAM unter 4 parallelen Sessions, Startzeiten, Genauigkeit, Halluzinationen, Tool-Routing, Kosten. Fehlende Messungen sind **offen**, nicht bestanden.

**Primärquellen:** [Qwen3.8-FP8 Model Card](https://huggingface.co/Qwen/Qwen3.8-27B-FP8) · [MOSS-Music Projekt](https://github.com/OpenMOSS/MOSS-Music) · [MOSS-Music Instruct](https://huggingface.co/OpenMOSS-Team/MOSS-Music-8B-Instruct) · [CLAP](https://huggingface.co/laion/larger_clap_music) · [Beat This!](https://github.com/CPJKU/beat_this) · [SongFormer](https://huggingface.co/ASLP-lab/SongFormer) · [audioFlux](https://github.com/libAudioFlux/audioFlux) · [librosa](https://github.com/librosa/librosa) · [Basic Pitch](https://github.com/spotify/basic-pitch) · [NVIDIA A40](https://images.nvidia.com/content/Solutions/data-center/a40/nvidia-a40-datasheet.pdf) · [NVIDIA L40S](https://www.nvidia.com/en-us/data-center/l40s/) · [RunPod GPU-Preise](https://www.runpod.io/pricing)


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
| `MASTERTODOENDE.json` | **Einzige Quelle der Wahrheit** für offene Arbeit (nur offene Punkte; Erledigtes steht in der Git-Historie) |
| `docs/INFRA_KONSTITUTION.md` | Verbindliche Grenzen für Flotte und Kosten |
| `docs/AUDIT_REPORT_2026-09-23.md` | Vollständiger Audit dieser Runde, inkl. eigener Fehlkorrekturen |
| `AGENTS.md` | Verbindliche Architektur- und Arbeitsregeln |
| `docs/README.md` | Doku-Index: was verbindlich ist, woher zurueckgeholte Dokumente stammen (DOC-2026-10-13-001) |

**Weitere Schwerpunkte:** `docs/AI_ARCHITECTURE.md`, `docs/AI_SECURITY_GUIDE.md`,
`docs/AI_COST_GUIDE.md`, `docs/ENV_MATRIX.md`, `docs/SERVER_FLEET.md`,
`docs/runpod-8-instances-complete-plan.md`, `docs/SEC_BLOCK2_ATTACKS.md`,
`docs/RECHT_ENTWURF_DATENSCHUTZ_IMPRESSUM.md`, `docs/SEC_CF_TOKEN_ROTATION.md`,
`docs/HETZNER_DEPLOY.md`, `docs/PERFORMANCE_BUDGETS_2026.md`,
`docs/QUALITY_TOOLING_2026.md`, `docs/LICENSE_EXTERNAL_RESOURCES.md`

**Zahlen in diesem Dokument** sind am 2026-09-23 gemessen. Steht irgendwo eine Zahl ohne
Belegweg, ist sie zu prüfen, nicht zu glauben.
