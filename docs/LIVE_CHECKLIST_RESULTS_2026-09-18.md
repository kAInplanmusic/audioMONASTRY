# LIVE-CHECKLISTE · Messergebnisse 2026-09-18

Die Checkliste vom 2026-09-02 wurde am 2026-09-13 in `MASTERTODOENDE.json`
(LIVE-P1-003) konsolidiert und die Datei dabei entfernt. Hier steht sie **wieder** —
mit dem, was in der Agent-Umgebung tatsächlich messbar ist, und mit dem, was
Hardware/Flotte braucht. Grundsatz: jeder Punkt bekommt Messwert **oder** einen
Grund, warum er hier nicht erhebbar ist. Kein Punkt bleibt still offen.

## A · Lokal gemessen (2026-09-18, dieser Lauf)

| Prüfpunkt | Messwert | Ergebnis |
|---|---|---|
| `npm run verify` (tsc, eslint, vitest, security, audio-gate, Deep Audit) | 238 Dateien / **1664 Tests** grün | ✅ |
| `npm run build` | `dist/server.cjs` + Bundle erzeugt | ✅ |
| **P2-5 Bundle-Budget** (`npm run check:bundle`) | Startlast **0,96 MB** (Warn 1,50 · Fail 2,00) | ✅ **deutlich unter der Warnschwelle** (2026-09-02: 1,62 MB) |
| `npm run check:memory` | Heap-Delta **0,03 MB** (Gate 512 MB) | ✅ |
| `npm run eval:ai` | **18 Cases, Accuracy 100 %**, 18 Plugin-Runs, 0 FAIL | ✅ (2026-09-02: 21 Cases — Fallzahl seitdem reduziert) |
| Playwright smoke + keyboard + audioAction + responsive | **24/24** | ✅ |
| Playwright stress, live2browser, audio-smoke, v2-live, hardware | **je grün** (5 Dateien) | ✅ |
| Playwright collab (2-Browser-Sync, Lock-Denial+Resync, 4-User, Main-Out, Halter-Übergabe) | **7/7** | ✅ (2026-09-02 galt `collab.spec.ts` lokal als kaputt — jetzt grün) |
| TURN-Relay (COLLAB-P0-003, mit lokalem coturn) | relay/relay, relay-only, Gegenprobe abgelehnt | ✅ |
| Echter ICE-Ausfall + Wiederherstellung | disconnected ~6–10 s · failed ~16–20 s · restart-ice → **verbunden** +18,4 s/+22,2 s | ✅ |
| MJPEG-Beamer-Fallback | Bild rot → grün → blau im echten Chromium | ✅ |

## B · Nicht erhebbar in dieser Umgebung (Betreiber/Flotte/Hardware)

| Prüfpunkt | Warum hier nicht | Nächster Schritt |
|---|---|---|
| **OPS-Snapshot Wake→ready < 90 s** | Flotte nicht hochgefahren (Provisionierung kostet Geld) | Betreiber: Portal-Ladebildschirm bzw. `/api/status`-Polling |
| **OPS-Snapshot Refresh** | dito (Snapshot-Prefix inzwischen `audiomonastry-snapshot-<role>`) | Betreiber: `POST /api/refresh-snapshots`, dann `GET /api/snapshots` |
| **P1-1 iPhone vor Ort** | kein Gerät | UI-Check Safe-Area/Touch-Ziele ≥ 44 px |
| **P1-3 USB-Gerät (Xonar U7)** | kein Gerät, kein USB-Passthrough | Gerät anschließen, Auto-Auswahl + 2.1-Modus prüfen |
| **P0-4 60 s Dauerlauf, RMS ≤ −60 dBFS** | verlangt echte Ausgabe-/Messkette am Gerät | Loopback-Aufnahme am Interface |
| **P2-2 Jitter < 1 ms / 10 min, 2 Browser < 5 ms** | 10-Minuten-Echtzeitlauf mit zwei Audiogeräten ist ein Vor-Ort-Test (die Offline-Variante misst nur die Graph-Renderzeit, nicht die Geräteuhr) | Vor Ort mit `AudioContext.getOutputTimestamp()`-Log |
| **P2-3 Frequenzanalyse Sub/L/R** | setzt die 2.1-Verkabelung voraus | Testton 40 Hz auf Sub, 1 kHz auf L/R |
| **P2-4 CPU < 70 % (`tests/e2e/performance.spec.ts`)** | Der Spec ist hier **nicht lauffähig**: beim Aktivieren aller Plugins bricht die Navigation ab und der Renderer-Prozess wird beendet (`Target page, context or browser has been closed`) — die Messung ist damit nicht erhebbar | Betreiber: auf einem Arbeitsplatz-Rechner laufen lassen (Chromium mit GPU); Spec ist tolerant gemacht (kein zweiter `goto`, Startbildschirm-Erkennung) |
| **P4-1 4-Browser-Latenz one-way < 50 ms** | braucht Loopback (Mikrofon vor Lautsprecher) zur echten Messung | Vor Ort |
| **P4-2 Unterbrechungsfreiheit beim Rollenwechsel** | hörbare Prüfung | Vor Ort |
| **§5 P3-1/P3-2/P3-3/GAP-5 Supabase-Sichtbarkeit** | verlangt echtes Projekt + LLM-Läufe; die Mock-Variante (`tests/aiEvaluation.test.ts`) und `eval:ai` sind hier grün | Betreiber: `ai_evaluations`/`ai_eval_runs` prüfen; Nightly-CI |
| **§6 Security (Secret-Rotation, Pen-Test, RLS)** | Betreiber-/Fremdleistung | siehe `docs/SECURITY_AUDIT.md` |
| **LB11 (2 App-Knoten + Failover)** | flottenabhängig, bewusst nicht installiert | erst bei Skalierung |

## C · Zwei echte Funde aus diesem Lauf (beide behoben)

1. **Ein verwaister Dev-Server sabotiert E2E-Läufe.** Ein übrig gebliebener
   `tsx server.ts` aus einem abgebrochenen Beweis-Lauf hielt Vites festen
   HMR-Port `24678`. Die Playwright-`webServer`-Instanz konnte ihn nicht binden,
   der HMR-WebSocket schlug fehl, und die Smoke-Tests scheiterten an
   `"WebSocket closed without opened"` (7 Fehler, die wie eine Regression
   aussahen). Nach dem Aufräumen: **24/24 grün**. Konsequenz: die Beweis-Skripte
   starten ihre Server jetzt **detached** und beenden die ganze Prozessgruppe
   (`process.kill(-pid)`), und `scripts/mjpeg-live-proof.mjs` bricht ab, wenn der
   Beweis-Port belegt ist. Vor einem E2E-Lauf lohnt `ss -ltnp | grep -E ':24678|:8080'`.
2. **`tests/e2e/performance.spec.ts` kollidierte mit dem Vite-Dep-Reload.** Der
   zweite `page.goto('/')`/`page.reload()` brach mit `net::ERR_ABORTED` ab (der
   Spec-Kommentar kennt den Reload, behandelt ihn aber nicht). Jetzt wird ohne
   zweite Navigation gemessen und `openStudio` erkennt den Startbildschirm nach
   einem Vite-Reload. Die CPU-Messung selbst bleibt hier trotzdem nicht
   erhebbar (Renderer beendet sich unter der Plugin-Last dieser Umgebung).

## D · Weiterer Befund: visuelle Baselines sind veraltet (A/B-bewiesen)

`npx playwright test tests/e2e/visual.spec.ts` scheitert: erwartet 1280×2945 px,
erhalten 1280×1679 px bzw. 1280×5446 px (45–68 % der Pixel unterschiedlich). Der
**A/B-Test** (Änderungen dieser Runde per `git stash` entfernt, Spec erneut
gelaufen) zeigt **dasselbe** Ergebnis — die Baselines stammen vom 2026-09-02
(`2456a91`), seitdem hat sich die UI deutlich geändert. Das ist ein Testschuld-Fund,
kein Regressionsbefund; die Baselines werden bewusst **nicht** blind überschrieben
(`--update-snapshots` würde echte UI-Änderungen verdecken) und stehen als offener
Punkt im Mastertodo.

**Zweite, unabhängige Ursache in derselben Datei (neu gefunden):** der Test
„P1-2: Screenshot-Baselines für alle Plugin-Ansichten" hängt. Seine Liste
`PLUGIN_ROWS` nennt **Plugin-Namen, die es nicht mehr gibt** — `instrumentMONK`
(heute `instruMONK`), `synthesizerMONK`/`drumMONK`/`samplerMONK` (heute
`syntisamplerMONK`), `mcpMONK` u. a., 20 Einträge gegen 18 Nav-Icons. Der
`getByTitle`-Klick findet nie ein Element und läuft in den 300-s-Testabbruch.
Nach dem Aktualisieren der Baselines für Start/Studio/masterplayer läuft der Test
deshalb bis in diese Schleife und hängt dort — **vorher** brach er schon an der
ersten Baseline ab, sodass die veraltete Liste nie auffiel.

Reparatur-Rezept: `PLUGIN_ROWS` aus der Registry ableiten (`getPluginRegistry()`
ohne `NAV_EXCLUDED`) statt Namen von Hand zu pflegen, dann die Plugin-Baselines
einmal bewusst erzeugen (`--update-snapshots`) und die Diff-Bilder ansehen.

## E · Wiederholbare Kommandos

```bash
npm run verify && npm run build
npm run check:bundle && npm run check:memory && npm run eval:ai
npx playwright test tests/e2e/smoke.spec.ts tests/e2e/keyboard.spec.ts \
  tests/e2e/audioAction.spec.ts tests/e2e/responsive.spec.ts tests/e2e/collab.spec.ts
npm run proof:turn          # braucht coturn (services/turn/turnserver.local-proof.conf)
npm run proof:ice-recovery  # stoppt den Relay WAEHREND der Verbindung
npm run proof:mjpeg         # Beamer-Fallback im echten Chromium
npm run proof:webgpu        # WebGPU/WGSL-Pfad: echter Frame + GPU-Ruecklesung
npm run probe:apis          # WebGPU/renderCapacity/worklet-Scope in 4 Konfigurationen
```
