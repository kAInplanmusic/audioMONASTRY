# AUDIT REPORT – audioMONASTRY (Projekt-Einlesen & Code-Audit)

**Datum:** 2026-09-23
**Scope:** Gesamtprojekt `/home/patrick/audioMONASTRY` (Stand `main` = `e71cb7d` == `origin/main`, Arbeitsbaum sauber)
**Modus:** D (Audio-Engine-Code-Audit) + Projekt-Einlesen, nach `audioaudit`-Skill
**Umfang:** 755 TS/TSX-Dateien, `src/utils/audioEngine.ts` (2 476 Z.), 16 Worklets, `src/core/audio/**`,
`server.ts` + 13 Route-Module, `database/*.sql` (9 Migrationen), 297 Testdateien.
**Nicht auditiert:** Live-Verhalten der GPU-Flotte, Hörqualität (nur Mensch), 4-User-Live-E2E.
Alle Aussagen unten sind mit Datei/Zeile oder Kommando-Output belegt.

---

## 0. Was das Projekt ist (Einlese-Ergebnis)

audioMONASTRY (`v1.210.001`) ist eine **Browser-DAW + Streaming-/Collaboration-Plattform**:

| Schicht | Technik |
|---|---|
| Frontend | React 19, Vite 6, Tailwind 4, TypeScript ~5.8, lazy-geladene Plugin-Terminals |
| Audio-Engine | Web Audio + **AudioWorklet** (16 Prozessoren) + Rust/WASM-Kernel (`dspKernel`, `hrtf_conv`) |
| Backend | Node ≥22, Express 4, `server.ts` → 13 modulare Route-Familien |
| Realtime/Collab | Socket.io (+ Redis-Adapter), WebRTC, **mediasoup**-SFU, coturn-TURN |
| KI | 8 RunPod-Serverless-Rollen (brain/ears/voiceGen/music/orchestrator/imageHq/videoReal/videoAbstract), MoA-Orchestrator, MCP-Werkzeuge |
| Daten | Supabase/Postgres (9 Migrationen), R2/S3-Objektspeicher, Redis, IndexedDB/OPFS |
| Betrieb | Hetzner-Flotte (5 Knoten), Docker-Compose-Overlays, Prometheus/Grafana, Caddy/TLS |

**Architektur-Kernregeln** (`AGENTS.md`):
„Orchestra"-Backend + Master-Sound, bis zu 4 User mit gespiegeltem Zustand und Plugin-Locking (B2B),
Ultra-Low-Latency-Mandat, **16 kanonische Plugin-Adapter** mit einheitlichem Runtime-Vertrag,
`OFF` = transparenter Bypass.

**Reifegrad:** ungewöhnlich hoch. Der Zustand wird in einer maschinenlesbaren Single Source of Truth
(`MASTERTODOENDE.json`, Schema 2.0.0) geführt: **144 Einträge = 129 DONE / 12 PARTIAL / 3 OPEN**.
Der Arbeitsbaum ist sauber, alle drei Übergabe-Zweige (`hermes/portal|scripts|lora`) sind gemergt.
Der Quellcode erklärt an kritischen Stellen *warum* (Audit-IDs wie `P0-1`, `D13`, `AM-E6-5`,
`AUDIO-P1-011`) – das ist gelebte Audit-Kultur, nicht Dekoration.

---

## 1. Zusammenfassung

- **Status: PASS (mit 2 hochpriorisierten Sicherheits-Nebenbefunden außerhalb des Codes)**
- **Code-Gates, heute real gemessen – alle grün:**

| Gate | Kommando | Ergebnis |
|---|---|---|
| Typen | `npx tsc --noEmit` | **exit 0** ✅ |
| Lint | `npx eslint . --max-warnings=0` | **exit 0** ✅ (56 s) |
| Tests | `npx vitest run` | **280/280 Dateien, 2 097/2 097 Tests grün**, 64,9 s ✅ |
| Boundaries | `node scripts/validate-interface-boundaries.mjs` | **451 Dateien, 0 Verstöße** ✅ |
| Registry | `public/plugin-manifest.json` | **genau 16 `ui_plugins`**, 15 Worklets ✅ |

- **Kern-Engine:** Der hörbare Pfad läuft ausschließlich über den **V2-Live-Sink** (AudioWorklet).
  `activatePlugin`/`deactivatePlugin` sind sauber an die Signalkette gekoppelt, die Monitor-Policy
  (`src/core/audio/monitorRouting.ts`) ist eine **reine Funktion** und `MAIN` wird nie getrennt.
  Die 16 Worklets sind **echtzeit-diszipliniert** (vorallokierte Puffer, Scratch-Reuse mit
  Längen-Guard, keine Locks/IO im `process()`).
- **Kritische Altbefunde bereits behoben:** `ModuleContainer` hat den `✕ OFF`-Button (`P0-3`),
  `itSynth`-Frequenzexplosion und die Worklet-Allokationen aus `docs/audit-audioweg.md` (F1–F7) sind gefixt.
- **2 offene Punkte sind Sicherheits-relevant und betreffen die *Umgebung*, nicht den Code**
  (weltlesbare `.env` mit Service-Role-Key, zurückgekehrter Cloudflare-Token) → **siehe Findings
  SEC-N1/SEC-N2, das sind die einzigen „sofort handeln"-Punkte.**

---

## 2. Befunde

| ID | Schwere | Ort | Befund | Beleg | Empfehlung |
|---|---|---|---|---|---|
| **SEC-N1** | **HOCH** | `audioMONASTRY/.env` + 3 Backups | Lokale Env-Datei ist **weltlesbar (664)** und enthält **57 belegte Schlüssel**, darunter `SB_SERVICE_ROLE` (219 Z.), `ADMIN_PASSWORD`, `DEEPSEEK_API_KEY`, `GHCR_TOKEN`, `HCLOUD_TOKEN`, `HF_TOKEN`, `RP_API_KEY`, `TURN_STATIC_AUTH_SECRET`, `SQ_PERSONAL_TOKEN`, `STUDIO_ACCESS_TOKEN`. Backups `.env.bak-20260917-*`, `.env.bak-20260920-*`, `.env.bak-r2-20260921-*` ebenfalls **664** mit 49–53 belegten Schlüsseln. | `stat -c '%a' .env` → `664`; `rg -o '^[A-Z_]+=' .env \| wc -l` → `57` | `chmod 600 .env .env.bak-*` **sofort**; Backups nach Rotation löschen. `.env.deploy`/`.env.portal` sind bereits korrekt `600` – als Maßstab nehmen. |
| **SEC-N2** | **HOCH** | `.env`, `.env.bak-20260920-145010-template-override`, `.env.bak-r2-20260921-171203` | `CF_API_TOKEN` ist **wieder belegt (53 Zeichen)** auf der Platte – obwohl die SSOT-Einträge `SEC-P1-002` (DONE, „danach liegt kein Cloudflare-Token mehr auf der Platte") und `ENV-006` (DONE, Token entfernt) genau das Gegenteil dokumentieren. Der Token war am 2026-09-17 **live als aktiv/gültig gemessen** (HTTP 200). **0 Code-Referenzen** – er liegt ungenutzt, aber wirksam. | `rg -n CF_API_TOKEN src/ server/ services/ scripts/ .github/ docker-compose* Caddyfile Dockerfile*` → **0 Treffer**; Längen-Check `.env` → 53 Zeichen | Token im **Cloudflare-Dashboard widerrufen** (Betreiberaufgabe, war in `SEC-P1-002` schon als offen benannt) und Zeile aus allen drei Dateien entfernen. Danach SSOT-Eintrag mit Gegenmessung nachziehen. |
| **ARCH-N1** | MITTEL | `knip.json` | Die Ignorierliste enthält **~45 Module**, die damit dauerhaft aus der Totcode-Analyse fallen. Zwei Stichproben sind **nachweislich unreferenziert**: `src/lib/firebase.ts` (33-Byte-Leer-Shim, `0` Importe) und `src/hooks/useAIComposition.ts` (`0` Importe repo-weit, kein Barrel in `src/hooks/`). | `rg -n useAIComposition --glob '!node_modules' .` → nur die Datei selbst + `knip.json` | Ignorierliste in „aktiv ignoriert (begründet)" und „soll gelöscht werden" trennen; Leer-Shim + toten Hook entfernen; die übrigen Einträge einzeln mit Grund versehen (sonst verdeckt die Liste echten Totcode). |
| **DOC-N1** | NIEDRIG | `server/routes/aiRoutes.ts:232` | Kommentar ist Copy-Paste-falsch: er beschriftet **`POST /api/ai/generate`** als „`POST /api/ai/compose`". | Zeile 232 `// --- POST /api/ai/compose …` direkt über Zeile 233 `app.post('/api/ai/generate' …)`; Duplikat-Scan der Routen: **0 echte Doppelregistrierungen** | Kommentar korrigieren (rein kosmetisch, keine Funktionsauswirkung). |
| **DOC-N2** | NIEDRIG | `docs/NEXT_SESSION.md` | Der Startzettel ist **veraltet**: er nennt `main = 19294f7`, „Flotte AUS", und führt `hermes/portal\|scripts\|lora` als „noch zu mergen". Realität: `main = e71cb7d`, alle drei Zweige sind gemergt. | `git rev-parse main` → `e71cb7d`; `git log --oneline` zeigt die drei `merge(hermes/…)`-Commits | Startzettel beim nächsten Commit auf `e71cb7d`/gemergt aktualisieren – er ist als Einstiegsstelle sonst irreführend. |
| **ENG-N1** | NIEDRIG | `src/utils/audioEngine.ts:1253, 2258` | Zwei **Fallback-Pfade direkt auf `ctx.destination`** (`g.connect(drumInput \|\| this.ctx.destination)`, `else synth.toDestination()`) widersprechen dem in Zeile 543–547 dokumentierten Invarianten-Satz „KEIN zweiter Pfad zur `ctx.destination`". Nur erreichbar, wenn der Kanal-Knoten fehlt – dann umgeht der Ton aber V2-Sink, Kanalzug und Monitor-Policy. | Zeilen 1243–1253 (Drum-Preview), 2251–2258 (Synth-Preview) | Entweder Invariante ehrlich abschwächen („nur Preview-Fallback") **oder** Fallback auf einen dedizierten, stummen Fehlerknoten umstellen und `console.warn` loggen statt direkt auf `destination` zu gehen. |
| **INFO-N1** | – | `src/core/ai/orchestrator/promptRoles.ts:216-270`, `server/routes/aiRoutes.ts:239-269` | Rollen-Prompts und LLM-Aufträge sind **deutsch** (`'Du bist ein audioMONASTRY-Produktions-Agent …'`, `'Antworte NUR als JSON-Array …'`). Das ist **kein Defekt**, sondern der bewusste Stand „Deutsch mit englischen Keywords (D18)" und deckt sich exakt mit dem offenen SSOT-Punkt `AI-P1-PROMPTS-002`. | `composeRoleSystemPrompt()`, `MOA_GLOBAL_SYSTEM_PROMPT` | Kein Handlungsbedarf im Audit – bei Umsetzung von `AI-P1-PROMPTS-002` alle Rollen gleichzeitig umstellen (sonst Mischsprache im Few-Shot-Katalog). |

---

## 3. Was ausdrücklich geprüft und **in Ordnung** ist

Damit die Prüfungen nachvollziehbar sind – negativ Befunde sind auch Befunde:

| Prüfpunkt (Skill-Quelle) | Ergebnis |
|---|---|
| **Plugin-Lifecycle** `activatePlugin`/`deactivatePlugin`: OFF trennt, PRO/AUTO_AI speist ein | ✅ `audioEngine.ts:1087-1138` – OFF rampt auf −∞ (`muteAndRemember`), `mixer`-OFF stoppt zusätzlich Main+Clock; Start-Silence über `setIdleSilence` |
| **Monitor-Routing** `MAIN` wird nie getrennt, Cue unabhängig | ✅ `src/core/audio/monitorRouting.ts` – reine Policy, `mainMonitorGain: 0` nur bei CUE-only, MAIN-Bus unangetastet (D13/P0-6) |
| **~~`ModuleContainer` Close-Button~~** (Alt-Fund) | ❌ **FALSCH – korrigiert am 2026-09-23, siehe §7.** Der Button ist in `ModuleContainer.tsx:54-63` implementiert, aber `ModuleContainer.tsx` hat **0 Import-/Require-/Pfad-Statements im gesamten Repo** – die Komponente wird nie gerendert, der Button ist unerreichbar. `tests/e2e/pluginCloseSync.spec.ts:20` dokumentiert genau das. Die `P0-3`-Zusage ist über den Rack-Power-Button erfüllt, nicht über diese Datei. |
| **Plugin-Vertrag** (16 Adapter): `OFF`=Bypass, Lock-Guard, idempotentes `dispose()` | ✅ `BasePluginAdapter.ts:69-77` (OFF→`return block`), `:86-88` (Lock→throw), `:122-130` (dispose idempotent) |
| **Registry-Konsistenz** Manifest ↔ Code | ✅ exakt 16 `ui_plugins`, IDs deckungsgleich mit `CANONICAL_PLUGIN_IDS`, Fallback bei Manifest-Mismatch |
| **RT-Safety der 16 Worklets** | ✅ vorallokierte Puffer; Re-Allokation nur mit Längen-Guard (`if (this.mixBuf.length !== n)`); keine Locks/IO/fetch im `process()`; `spatialProcessor` nutzt vorkonvertierte Kernel + Scratch-Objekte |
| **V2-Parität & PDC** | ✅ eigene Test-Suiten (`v2DspV1Parity`, `v2PdcImpulse`, `v2SyncMirror`, `v2SinkProcessorWorklet`) laufen grün |
| **Prompt/Eval-DB (G8)** | ✅ `ai_migration_002/003` liefern `system_prompts`, `plugin_prompt_versions`, `ai_evaluations`, `ai_eval_runs` |
| **Auth/Zugriffsschutz Server** | ✅ zentraler Studio-Token, **fail-closed** (503 wenn kein Token konfiguriert, sonst 401); keine offenen Admin-Routen gefunden |
| **Keine Secrets im Repo** | ✅ `.env*` sind gitignored; getrackte `*.example` enthalten **nur Platzhalter** (gegengeprüft: keine Werteidentität mit `.env` außer einem Bucket-Namen) |
| **Keine Secrets im Client-Bundle** | ✅ Muster-Scan (`sk-…`, `AKIA…`, `ghp_…`, PEM, JWT) über `src/`, `public/`, `server/` → **0 Treffer** |
| **Keine doppelten Routen** | ✅ Methode+Pfad-Duplikat-Scan über `server.ts` + alle Route-Module → 0 |
| **Rust/WASM-Kernel** | ✅ `dspKernel_rs`, `hrtf_conv` vorhanden und gebaut; bekannter Punkt „WASM-Instanz wird verworfen" ist in `docs/audit-audioweg.md` F8 dokumentiert |

---

## 4. Priorisierte Maßnahmen

1. **SOFORT (Betreiber, ~2 Minuten):** `chmod 600 .env .env.bak-*` – die Service-Role-/Admin-/
   Token-Sammlung ist derzeit für jeden lokalen Account lesbar. *(SEC-N1)*
2. **HEUTE (Betreiber):** `CF_API_TOKEN` im Cloudflare-Dashboard **widerrufen**, danach aus `.env`
   und beiden Backups entfernen. Der Token war live als aktiv gemessen und ist der einzige
   „schlafende" Schlüssel mit echter Wirkung. *(SEC-N2)*
3. **NÄCHSTER CODE-LAUF:** `knip.json`-Ignorierliste entrümpeln und die zwei belegten Totcode-Dateien
   entfernen (`src/lib/firebase.ts`, `src/hooks/useAIComposition.ts`). *(ARCH-N1)*
4. **BEI GELEGENHEIT:** `docs/NEXT_SESSION.md` auf den echten HEAD ziehen; `aiRoutes.ts:232`
   Kommentar korrigieren; `ENG-N1`-Fallbacks entweder dokumentieren oder härten. *(DOC-N1, DOC-N2, ENG-N1)*

---

## 5. Offene Punkte aus der SSOT (unverändert übernommen, nicht neu bewertet)

12 × PARTIAL, 3 × OPEN – die drei OPEN sind:

| ID | Prio | Titel |
|---|---|---|
| `VISUAL-P1-009` | P1 | Weitere Szenen/Themen für die Visuals (wartet auf Betreiber-Material) |
| `INFRA-HETZNER-015` | P1 | SFU scharf machen (Entscheidung „go") – ACME-Caddyfile in den Flottenstart |
| `AI-P1-PROMPTS-002` | P1 | Rollen-Prompts auf **Englisch** umstellen + Betreiber-Antworten umsetzen |

Die PARTIAL-Punkte sind konsistent dokumentiert (u. a. `PROD-P0-F1` Portal-TLS,
`PROD-P2-F6` SFU/TURN-Standardpfad, `ARCH-P2-002` Server-Zerlegung, `PERF-P3-002` Worklet-Messweg).
Umgebungs-blockiert bleiben `ENV-001`–`ENV-003` (kein 4-Browser-Live-Target, keine Hardware,
Hörtest nötig) – daran ändert der Audit nichts.

---

## 6. Verknüpfte Prüfpunkte (Gates)

- [ ] **Gate SEC-1:** `stat -c '%a' .env .env.bak-*` liefert überall `600`
- [ ] **Gate SEC-2:** `rg -c '^CF_API_TOKEN=.' .env*` liefert keine Treffer + Widerruf im Dashboard bestätigt
- [ ] **Gate ARCH-1:** `npx knip` (ohne die zwei entfernten Dateien) bleibt grün
- [ ] **Gate DOC-1:** `docs/NEXT_SESSION.md` nennt den aktuellen HEAD
- [ ] **Gate G12 (bestehend):** `npm run verify` bleibt grün — heute für die gemessenen Teile bestätigt
      (tsc 0, eslint 0, vitest 2 097/2 097, boundary 0)

Reproduktion der Messungen:
```bash
cd /home/patrick/audioMONASTRY
npx tsc --noEmit                                   # exit 0
npx eslint . --max-warnings=0                      # exit 0
npx vitest run                                     # 280 Dateien / 2097 Tests grün
node scripts/validate-interface-boundaries.mjs     # 451 Dateien, 0 Verstöße
stat -c '%a %n' .env .env.bak-*                    # 664 -> Handlungsbedarf
rg -n CF_API_TOKEN src/ server/ services/ scripts/ .github/   # 0 -> schlafender Token
```

---

## 7. Nachtrag – Umsetzung 2026-09-23

Freigabe des Betreibers: „die drei P3-Aufräumarbeiten plus ARCH-P2-003 umsetzen".
Alle vier sind umgesetzt; die zwei Betreiber-Aufgaben (`SEC-N1`/`SEC-N2`) bleiben offen.

### 7.1 Korrektur einer eigenen Fehlaussage

Ich habe in §3 behauptet, der `ModuleContainer`-Close-Button sei „in Ordnung". **Das war falsch.**
Die Nachprüfung beim Umsetzen ergab: `src/components/ModuleContainer.tsx` hat **0 Import-/Require-/
Pfad-Statements im gesamten Repo** – die Komponente wird nie gerendert. Der Button existiert im Code,
ist aber **unerreichbar**. Der E2E-Test dokumentiert das seit 2026-09-17 selbst:

> „Der frühere Weg ‚OFF im Terminal‘ (Schließen-Button aus ModuleContainer) ist entfallen:
> ModuleContainer wird nirgends importiert, der Button also nie gerendert.
> Der Rack-Power-Button ist heute der einzige Schließweg."
> — `tests/e2e/pluginCloseSync.spec.ts:20-22`

Die `P0-3`-Zusage ist also über den Rack-Power-Button erfüllt, nicht über diese Datei. Das Item
steht jetzt als Entscheidung in der SSOT (`ARCH-P3-001`), der Report ist in §3 korrigiert.

### 7.2 Neuer Befund: die Hörprobe klang doppelt (HOCH, behoben)

Beim Umsetzen von `ENG-N1`/`AUDIO-P3-001` fand ich einen **dritten** `destination`-Pfad – und der war
kein Fallback, sondern ein echter Hörfehler:

`src/audio/samplePreview.ts` erzeugte für **jede** URL-Hörprobe zwei hörbare Wege gleichzeitig:

1. `new Tone.Player(url).toDestination()` mit `autostart = true` → **direkt auf der Ausgabe**, an
   Fader, EQ, Pan, Monitor-/Cue-Policy und dem V2-Sink vorbei.
2. `decodeToV2(...)` → `bridgeBufferToV2` + `triggerV2Sample` → derselbe Sample **korrekt über den
   V2-Sink**, um die Dekodierzeit versetzt.

6 UI-Stellen rufen `previewSample(track, time, url)` immer mit URL auf (`LibraryTerminal`,
`DeckSkins`, `RecorderTerminal`, `AudioActionMenuHost` ×2, `MIDIControllerTerminal`, alle auf
`channel5`) – ein Klick auf ▶ ergab also **zwei** Klangereignisse, eines davon ohne Mixer-Kontrolle.

**Behoben:** Direkt-Player und die Factory `createPlayerFromUrl` entfernt, ein hörbarer Weg bleibt.
Der still verschluckte Dekodier-Fehler ist auf `console.warn` umgestellt, damit ein Fehlschlag nicht
unsichtbar wird (vorher fiel er nicht auf, weil der Direkt-Player noch klang).
Regressionstest: `tests/samplePreview.test.ts` prüft jetzt explizit, dass die URL-Hörprobe **keinen**
Direkt-Player erzeugt.

> **Vorbehalt (ehrlich):** Das ändert hörbares Verhalten von „doppelt" auf „einfach". Ein Hörtest
> durch einen Menschen steht aus – und ist als `ENV-003` ohnehin umgebungs-blockiert. Der Fix ist in
> einem Commit revertierbar; das ist in `AUDIO-P3-001` so vermerkt.

### 7.3 Neuer Befund: das Totcode-Gate ist rot und läuft nicht mit

`npx knip` endet mit **exit 1** (195 ungenutzte Exporte, 88 ungenutzte Typen, 1 ungenutzte Datei, die
ungenutzte Abhängigkeit `axios`, 3 unauflösbare Imports in den Proof-Skripten). Der eigentliche Punkt:
`npm run verify` ruft `check:deadcode` **nicht** auf. Ein Totcode-Gate, das nirgends läuft, meldet
nichts – genau deshalb blieb auch die unbegründete Ignorierliste unbemerkt. Neu als `QUAL-P2-006`.

### 7.4 Was umgesetzt wurde

| Item | Ergebnis | Beleg |
|---|---|---|
| `ARCH-P2-003` | **DONE** – `knip.json` → `knip.jsonc` mit Begründung **je Eintrag** (Gruppen B–F); 4 belegte Totleichen entfernt (`lib/firebase.ts`, `hooks/useAIComposition.ts`, `types/composition.ts`, `config/rolePresets.ts`); die 5 **laufzeitgeladenen** Worklet-Prozessoren sind jetzt mit Grund geparkt (knip meldete sie fälschlich als tot – Löschen wäre ein Audio-Ausfall); redundante Einträge nach knip-eigenem Hinweis entfernt | **Unused files 10 → 1**, Configuration hints **20 → 1** (final nachgemessen); Unused exports/types/deps **unverändert** (195/88/1) → die Liste hatte nichts verdeckt |
| `AUDIO-P3-001` | **DONE** – drei `destination`-Pfade entfernt (§7.2); Invariante in `init()` präzisiert statt überzogen; die zwei geparkten Reste (`connectLiveWorkletChain()`, `applyMasterOutputRouting()`/`outputGain`) sind dort ausdrücklich benannt | `rg toDestination\(\) src/utils/audioEngine.ts` → nur noch Kommentare |
| `DOC-P3-001` | **DONE** – `docs/NEXT_SESSION.md` auf HEAD `e71cb7d`, SSOT 152 Einträge, drei Zweige als gemergt, Betreiber-Aufgaben oben | `git rev-parse --short main` |
| `DOC-P3-002` | **DONE** – Kommentar über `/api/ai/generate` korrigiert | `aiRoutes.ts:232` |

Nebenbefund, ebenfalls dokumentiert: `this.outputGain` bekommt **nirgends** ein `GainNode`
zugewiesen (nur `= null` in `dispose()`), deshalb ist der 2.0/2.1-Ausgangsrouter
`applyMasterOutputRouting()` wirkungslos. Die echte Umschaltung macht `v2LiveSink.setOutputLayout()`.
Kein zweiter Pfad – aber toter Code. Steht in `ARCH-P3-001`.

### 7.5 Gates nach der Umsetzung

Alle real gemessen, **alle grün**:

| Gate | Ergebnis |
|---|---|
| `npx tsc --noEmit` | exit **0** |
| `npx eslint . --max-warnings=0` | exit **0** |
| `npx vitest run` | **280/280 Dateien, 2 098/2 098 Tests** (ein Test mehr durch den neuen Regressionstest) |
| `npx knip` | exit 1 – **unverändert** gegenüber vorher, siehe `QUAL-P2-006` |

SSOT danach: **152 Einträge = 133 DONE / 12 PARTIAL / 7 OPEN**.

---

## 8. Nachtrag – ReleaseCycle Iteration 2 (2026-09-23)

Vier Punkte aus der To-Do-Liste der Iteration 1 sind umgesetzt. Alle Zahlen hier
sind **gemessen**, nicht abgeleitet.

### 8.1 RC1-003 – Kill-Switch als Umgebungsvariable (neu: `server/killSwitch.ts`)

Vorher gab es **keinen** Laufzeit-Halter: `src/config/featureFlags.ts` ist eine
hartkodierte Client-Konstante, der einzige echte ENV-Schalter im Server war
`ENABLE_SFU=1` (nur SFU). Jetzt liest `server/killSwitch.ts` `KILL_SWITCH` oder
`MAINTENANCE_MODE` (`1|true|yes|on|enabled|an|ja`).

End-to-End gemessen (echter Serverstart, `npx tsx server.ts`, Port 8080):

| Fall | Anfrage | Ergebnis |
|---|---|---|
| `KILL_SWITCH=1` | `GET /api/health` | **200**, `status:"maintenance"`, `killSwitch:true` |
| `KILL_SWITCH=1` | `POST /api/ai/generate` (mit Token) | **503**, `{"code":"KILL_SWITCH","status":"maintenance","retryAfterSeconds":300}` |
| `KILL_SWITCH=1` | `POST /api/ai/generate` (ohne Token) | **401** – die Auth-Middleware liegt davor (so bleibt der Pfad rate-limitiert); es startet in beiden Fällen **kein** Auftrag |
| `KILL_SWITCH=1` | `GET /` | **200** – die Oberfläche wird weiter ausgeliefert |
| ohne Schalter | `POST /api/ai/generate` (mit Token) | **200** mit echter lokaler Komposition (`task_id:"local_…"`) |
| ohne Schalter | `GET /api/health` | `status:"ok"`, `killSwitch:false` |

Startmeldung im Log: `[kill-switch] AKTIV (ENV KILL_SWITCH) - /api/* gesperrt bis auf /api/health, /api/metrics, /api/security/csp-report`.

Bewusste Grenzen: **Socket.io bleibt unberührt** (bestehende Sessions dürfen
ihren Zustand spiegeln – ein Kill-Switch, der Verbindungen abreißt, macht aus
einem Kostenstopp einen Datenverlust), und `/api/health`/`/api/metrics` bleiben
absichtlich offen, damit ein Alarm „absichtlich in Wartung" von „abgestürzt"
unterscheiden kann. 10 Tests in `tests/killSwitch.test.ts`, inklusive
Präfix-Falle (`/apiary` wird nicht als API-Pfad gewertet).

### 8.2 RC1-004 – anon-Lesen nur noch für die Browser-Allow-Liste

**Messung (entscheidend für die Bewertung):** Alle Tabellen `ai_*` und `mcp_*`
werden ausschließlich von `src/core/ai/orchestrator/aiPersistence.ts` berührt.
Diese Datei baut ihren Client mit `supabaseServerKey()` – also **service_role** –
und wird nur server-seitig importiert (`server.ts`, `server/routes/aiRoutes.ts`,
`server/routes/mediaRoutes.ts`). Im Client-Bundle gibt es **0 Treffer** für
`ai_jobs|ai_sessions|ai_errors|mcp_audit_events|ai_cost_estimates`. Der Browser
liest mit dem anon-Key nur `samples` und `music_tracks`
(`src/lib/supabaseClient.ts:73/85`, beide `select('*')` **ohne** verschachtelten
Join – deshalb brauchen `sample_tags` und `library_links` kein anon-Leserecht).

Umgesetzt: zwei idempotente Migrationen
(`supabase/migrations/007_rls_harden_anon_read.sql`,
`database/ai_migration_009_rls_harden.sql` – zwei Sätze, siehe 8.3) plus
Korrektur **an der Quelle** in `database/schema.sql`, wo `anon_read_tags` und
`anon_read_links` nicht mehr angelegt werden.

### 8.3 Neuer Befund `DB-P2-001` – zwei Migrationssätze (beim Umsetzen entdeckt)

`scripts/apply-supabase-migrations.ts` liest `supabase/migrations/`, aber
`database/` ist der Satz, auf den Doku, Codekommentare und Tests zeigen. Die
Nummern überlappen (002–006), der Inhalt ist nicht identisch, und der
**angewandte** Satz legt `samples`/`music_tracks` gar nicht an. Genau diese
Lücke hätte den RLS-Fix unsichtbar gemacht. Deshalb prüft
`tests/supabaseRls.test.ts` jetzt **beide Sätze getrennt**.

Der Test wurde von einer Dateizählung auf einen **Zustandsvertrag** umgebaut und
hat beim ersten Lauf sofort zwei echte Probleme gefunden (die alte Fassung hatte
4 Tabellen als anon-lesbar festgeschrieben; der angewandte Satz provisioniert die
Bibliothekstabellen nicht). 14 Tests, inklusive Negativ-Fall, der beweist, dass
eine zusätzliche anon-Policy wirklich erkannt wird.

### 8.4 RC1-008 – Build-Stempel beim Rohstart

`/api/health` meldete beim Rohstart `version:"dev", commit:"unknown"`; die
Rollback-Sichtbarkeit aus `PROD-P0-003` war damit nur im gestempelten Container
belastbar. Jetzt gibt es einen **Opt-in**-Ersatzstempel
(`primeBuildInfoFallback`) mit fs-basierten Lesern `readPackageVersion()` und
`readLocalGitCommit()` (kein Subprozess, kein `resolveJsonModule`). Gemessen:

```
{"status":"ok","version":"1.210.001","commit":"e71cb7d03bbd91246db666e978d774844ab1290d","buildTime":"unknown","killSwitch":false}
```

`buildTime` bleibt korrekt `unknown` – dafür gibt es keinen lokalen Ersatz, und
es wird weiterhin keine Parität behauptet. Der bestehende Vertrag
`readBuildInfo({}) -> dev/unknown` ist unverändert und mit `beforeEach`
abgesichert; 5 neue Tests.

### 8.5 RC1-009 – `.gitignore` um Schlüsselmaterial erweitert

`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa`,
`id_ed25519`, `*.ipynb`, `credentials.json`, `secrets.json` – **Prävention, kein
Vorfall**: nichts dergleichen ist getrackt. Zusätzlich `*.bak-*` für die
SSOT-Sicherungskopien.

### 8.6 Gates nach Iteration 2

| Gate | Ergebnis |
|---|---|
| `npx tsc --noEmit` | exit **0** (fand unterwegs einen echten Typfehler in `killSwitch.ts` – behoben) |
| `npx eslint . --max-warnings=0` | exit **0** |
| `npx vitest run` | **281/281 Dateien, 2 111/2 111 Tests** |

SSOT danach: **161 Einträge = 133 DONE / 12 PARTIAL / 15 OPEN / 1 BLOCKED**.
Neu aufgenommen (nur offene Punkte): `PROD-P0-005`, `PROD-P1-005`,
`PROD-P1-006`, `PROD-P1-007`, `DB-P2-001`, `DB-P3-001`, `PROD-P2-003`,
`OPS-P2-002`, `VISUAL-P1-011`.

---

## 9. Nachtrag – ReleaseCycle Iteration 3 und 4 (2026-09-23)

### 9.1 Iteration 3 — zehn Betreiber-Entscheidungen

Acht umgesetzt, zwei bewusst bei der Betreiberschaft belassen (`SEC-P1-005`
Token-Widerruf, `PROD-P0-005` Rechtstexte). Die Maßnahmen und ihre Messwerte
stehen in `MASTERTODOENDE.json` (`lastConsolidation`) — hier nur die
Kurzfassung: `.env`-Rechte auf 600 (vier Dateien), `PROD-P1-006`
Medien-Zugangsschutz mit Kopf-Token, `PROD-P1-005` LICENSE, drei extremistische
Demo-Tracks entfernt (davon einer, `Waffen SS - Erika`, als §86a-Material —
ein Befund, den ich erst beim Durchsehen der Dateiliste fand), 26 tote Dateien
gelöscht, Ruhe-Modus 22–07 Uhr, Migrations-Konsolidierung.

### 9.2 Iteration 4 — Block-2-Angriffe 3 und 4 gehärtet

**Angriff 4, ffmpeg-Protokoll-Whitelist.** Beide Aufrufstellen tragen jetzt
`-protocol_whitelist` (`server/audioEncode.ts` → `file`,
`server/visionShow.ts` → `file,concat`), jeweils **vor** dem `-i`. Vorher durfte
ffmpeg jedes Protokoll lesen, das der Build kennt.

Nachweis: `scripts/ffmpeg-whitelist-proof.ts`, 6 Prüfungen, alle bestanden.
Die entscheidende ist die Gegenprobe — ffmpeg lehnt ab mit
`Protocol 'http' not on whitelist 'file'!`. Eine Kontrollprobe bestätigt, dass
der Build `http` überhaupt kennt, die Ablehnung also von der Whitelist kommt.
Ein echter WAV→MP3-Lauf (42 285 Bytes) und der concat-Demuxer mit `file,concat`
funktionieren weiter. Regressionssicherung im Gate:
`tests/audioEncode.test.ts` und `tests/visualShowOrchestrator.test.ts`.

**Angriff 3, Dekompressionsbombe.** Hier muss ich eine **eigene Fehlaussage aus
§2 korrigieren**: ich hatte „kein decoded-duration cap" geschrieben. Das war
falsch — `services/master-player/server.py` hatte `MAX_DURATION_SEC = 120` und
`MAX_SAMPLES`. Der Fehler war die **Reihenfolge**, und er war ernster als ein
fehlender Deckel:

```
vorher:  run_ffmpeg(...)  →  volle PCM in proc.stdout  →  DANN arr.size > MAX_SAMPLES
```

Ein 64-MB-MP3 kann komprimiert zu rund 4,4 GB PCM entpacken. Der Prozess wäre an
der Speicher-Erschöpfung gestorben, **bevor die vorhandene Grenze gelesen
wurde**. Behoben in drei Schritten: (a) `probe_duration_sec` liest die Dauer aus
den **Metadaten**, bevor dekodiert wird; (b) `build_decode_args` setzt `-t` und
`-fs` als **Ausgabe**grenzen (nach dem `-i` — davor wäre es eine
Eingabegrenze); (c) die Sample-Prüfung bleibt als letzte Kontrolle, und wenn die
Dauer nicht bestimmbar ist, wird **konservativ abgelehnt** (fail-closed statt
stiller Freigabe).

Zusätzlich gemessen und im Code dokumentiert: ffprobe liefert auf `pipe:0`
wörtlich `N/A`, weil der Eingang nicht suchbar ist — auf einer regulären Datei
dagegen `1.000000`. Mein erster Entwurf sondierte über die Pipe und war damit
blind; **mein eigener Test hat das aufgedeckt**, nicht ich. Der Fix schreibt den
Payload deshalb in eine temporäre Datei (begrenzt durch die bereits geprüfte
`MAX_INPUT_BYTES`).

Nachweis: `tests/test_master_player_limits.py`, 10/10 — inklusive einer **echten**
Datei mit 200 s bei 8 kHz mono (wenig Bytes, viel Dauer = das Bombenmuster), die
vor dem Dekodieren abgelehnt wird, und eines Stubs, der beweist, dass der
Dekodierer für eine zu lange Datei gar nicht erst aufgerufen wird.

### 9.3 Iteration 4 — Gate und Doku

* **`QUAL-P2-006` DONE:** neuer Schritt `check:deadfiles` (`knip --include files`,
  Datei-Scope) in `npm run verify`. Beweis: `npm run verify` **exit 0** mit dem
  Schritt in der Kette, der Deep-Audit meldet darin `knip (0 Findings)`.
* **`PROD-P2-003` DONE:** `README_DE.md` hat denselben Einstieg wie `README.md`.
* **Dritte eigene Fehlaussage korrigiert:** in Iteration 3 hatte ich behauptet,
  knip melde keine ungenutzten Dateien mehr. Mein `grep "^Unused files"` matchte
  nichts, weil knips Ausgabe ANSI-Farbcodes enthält. Tatsächlich: `knip --files`
  **exit 1** mit `tests/setup.ts` (kein toter Code — per
  `vitest.config.ts:6` als `setupFiles` verdrahtet) und zwei Config-Hinweisen.
  Alle drei behoben; zusätzlich entfernte ich den **redundanten**
  Ignorier-Eintrag für `src/config/webrtc.ts`, den knip selbst als „Remove from
  ignore" gemeldet hatte.

### 9.4 Gates nach Iteration 4

| Gate | Ergebnis |
|---|---|
| `npx tsc --noEmit` | exit **0** |
| `npx eslint . --max-warnings=0` | exit **0** |
| `npx vitest run` | grün (inkl. neuer Whitelist-Regressionen) |
| `npm run verify` (vollständig) | **exit 0** — mit `check:deadfiles` in der Kette |
| `knip --include files` | **exit 0** (keine ungenutzten Dateien) |
| `npm run proof:ffmpeg-whitelist` | 6/6 Prüfungen bestanden |
| `npm run test:python:master` | 10/10 |
| `npx knip` (vollständig, informativ) | 199 ungenutzte Exporte, 90 Typen, 1 ungenutzte Abhängigkeit (`axios`) — Kaskadenthema `QUAL-P2-003` |

SSOT danach: **162 Einträge = 141 DONE / 15 PARTIAL / 5 OPEN / 1 BLOCKED**.
Neu aufgenommen: `SEC-P2-004` (die drei noch unbelegten Block-2-Angriffe).



