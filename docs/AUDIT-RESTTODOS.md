# AUDIT-RESTTODOS (Paket C — startet nach Paket A/B, wegen Datei-Überlappung)

Stand: 2026-09-29 · Quelle: Sub-Agent-Befunde (SSOT/Konsistenz-Track) + Deploy-Log-Analyse
Regeln: Repo-only, lokale Commits, NICHTS pushen, NODE_ENV=test für Tests, NTFS (kein chmod).

## C1 — Deploy-Defaults auf Weg-A-Stand ziehen (high, Redeploy-Risiko)
> **Status 2026-09-29 (Paket C):** an Paket A übergeben — `scripts/runpod-deploy.py`
> ist Paket-A-Datei (Parallel-Worker); hier bewusst NICHT berührt.
- `scripts/runpod-deploy.py`: `PREBUILT_IMAGES` um worker-comfyui-Image ergänzen
  (`runpod/worker-comfyui:5.11.0-flux1-dev-fp8` laut docs/VISUAL_LORA_STACK.md:64),
  `ROLE_DEFAULTS.imageHq` von `FLUX_DEV` auf das neue Image umstellen.
- `tests/test_runpod_deploy_defaults.py:63`: Gate auf neuen Vertrag umschreiben
  (imageHq MUSS worker-comfyui sein, NICHT PrunaAI).
- Grund: Live-Endpoint läuft seit 27.09. (b90f7a8) auf worker-comfyui/Workflow-Vertrag;
  heutiger Deploy-Run 36580686816 zeigt, dass der Deploy-Pfad lebendig ist.

## C2 — comfyui_adapter.py imageHq-Mapping (medium)
> **Status 2026-09-29 (Paket C): erledigt** — Umstellung auf
> `{worker: "comfyui", protocol: "workflow", defaultModel: "flux1-dev"}`;
> Alt-Eintrag als „Historisch bis 2026-09-27 (b90f7a8)“-Kommentar erhalten;
> Contract-Check als `tests/test_comfyui_adapter_imagehq.py` (5 Fälle,
> offline unittest, grün).
- `services/audiomonastry-ai-runtime/comfyui_adapter.py:80`: imageHq von
  `{"worker": "flux", "protocol": "prompt"}` auf worker-comfyui/Workflow-Vertrag
  umstellen (Muster existiert: imageLora-Eintrag Z.90-100); alten Eintrag als
  "historisch bis 2026-09-27" markieren, nicht löschen.
- Contract-Check ergänzen: imageHq-Request-Form vs. runpodVision.ts (sendet `{workflow}`).

## C3 — NODE_ENV-Pinning (medium, 74+18 Test-Fails Prävention)
> **Status 2026-09-29 (Paket C): erledigt** — `vitest.config.ts` pinnt
> `test.env.NODE_ENV='test'` zentral (gewinnt gegen das Host-Env; Beweis:
> aiRoutes ohne Pin im Host-Env 18 Fails, mit Pin 18/18 grün bei identischem
> ambient production); `tests/setup.ts` fail-fast bei durchschlagendem
> production (strenger als „&& kein Token“: mit Host-Token käme 401-Chaos);
> alle 14 Server-Import-Testfiles mit `process.env.NODE_ENV ??= 'test'` am
> Modulkopf; `package.json` `scripts.test = "NODE_ENV=test vitest run"`.
> Production-Szenario-Files (cspPolicy, webrtcConfigF6, corsAllowedOrigins,
> securityProductionAuth, sessionResetProduction) nicht angefasst.
- `vitest.config.ts`: `test.env: { NODE_ENV: 'test' }` setzen (zentral).
- `package.json`: `"test": "NODE_ENV=test vitest run"` (POSIX-safe hier).
- 14 Server-Import-Dateien: `process.env.NODE_ENV ??= 'test'` am Modulkopf
  (Liste im Code-Review-Bericht; Pflicht nur wo production-Szenario NICHT getestet wird —
  production-Szenario-Tests setzen explizit 'production', nicht anfassen).
- fail-fast in tests/setup.ts: klarer Fehler wenn NODE_ENV=production && kein Token.

## C4 — Manifest-VRAM-Gate (medium)
> **Status 2026-09-29 (Paket C): Gate erledigt, Nachmessung offen** — Assertion
> in `tests/manifestRoles.test.ts` (Summe der Preload-estimatedVRAM ≤
> vramBudgetGb − vramSafetyMarginGb), dokumentierte Ausnahmen statt
> expect.fail: **videoReal** 41 GB vs. Deckel 18 (wan22-t2v-a14b est 32) und
> **videoAbstract** 27 GB vs. 18 (ltx-video-13b est 18) — zusätzlicher Befund
> über den ursprünglichen Befund hinaus. Manifestwerte bewusst NICHT gefälscht;
> Verstöße bleiben als console.warn sichtbar. Gate negativ verifiziert
> (Verstoß in Rolle ohne Ausnahme schlägt an). VRAM am live-Worker nachmessen
> (APP-Touch → erst mit Freigabe) oder Budget/Pool anheben — Betreiber-Entscheid.
- `tests/manifestRoles.test.ts`: Assertion ergänzen:
  Summe(preload estimatedVRAM) <= vramBudgetGb − vramSafetyMarginGb je Rolle.
- `wan22-t2v-a14b` (est. 32 GB vs ADA_24-Budget 24): VRAM real nachmessen (APP-Touch → erst
  mit Freigabe) ODER Budge/Pool-Anhebung vorschlagen; bis dahin Test als expect.fail oder
  documented-exception führen.

## C5 — CI-Hygiene (low)
> **Status 2026-09-29 (Paket C): main.yml erledigt** — gelöscht (Sonar-Platzhalter
> `DEIN_PROJEKT_KEY`, workflow_dispatch-only, unbenutzbar); die 9 verbleibenden
> Workflows YAML-parse-geprüft. „ai.yml in ci.yml aufgehen lassen“ bleibt offen
> (ai.yml ist aktiv und inhaltlich eigenständig).
- `.github/workflows/main.yml` (Sonar-Platzhalter, unbenutzbar) löschen.
- Optional ai.yml in ci.yml aufgehen lassen.

## Nicht-Repo-Punkte (brauchen Betreiber)
- L: FLUX.1-Derivate auf kommerzieller Website (BFL-Lizenz) → SSOT LEGAL-P0 (Paket-B legt an).
- APP: Live-Zählung Alt-Snapshots (Legacy-Phase-2-Vorbedingung) — RunPod/Hetzner-Token nötig.
- APP: runpod-deploy workflow → deploy-Job an workflow_dispatch/environment binden (sonst
  feuert er bei jedem main-Push); Decision Betreiber.

## C6 — Signalkette hat zur Laufzeit keinen Ausführer (high)
Stand: 2026-10-05, aus dem Umbau „linearer Insert-Pfad“. Gemessen, nicht vermutet.
- `src/audio/PluginAudioPipeline.ts` wird in `src/` **nirgends konstruiert** — der einzige
  Erzeuger ist `tests/pluginAudioPipeline.test.ts` (`rg "PluginAudioPipeline" src/` liefert
  nur die Datei selbst). Damit hat der lineare Insert-Pfad über die 16 Adapter **keine
  Laufzeitwirkung**.
- `audioEngine.bounceGraph(...)` und `bounceV2NodeChain(...)` haben in `src/` **keinen
  Aufrufer**; der Offline-Renderpfad ist ebenfalls nicht angeschlossen.
- Folge: Der hörbare Pfad ist die handverdrahtete Worklet-Kette (eq/effect/dynamics/v2Sink)
  plus `pluginAudioRouter`. Genau deshalb lässt sich die Kette heute nicht „hören“.
- Teilfix 2026-10-05: Die Pipeline nimmt ohne Argument `SIGNAL_CHAIN_ORDER` als
  Verarbeitungsreihenfolge (vorher war die einzige je genutzte Ordnung die *Kopfreihenfolge*
  — nachweislich falsch: `mixer` an Position 0, also **vor** die Quellen, und `spatial` vor
  `eq`). `pluginAudioRouter` trägt jetzt `chainStage`/`chainIndex`, und
  `missingChainRoutes()` beweist, dass die Kette keine Lücke im Router hat.
- Zu schließen (nächster Schritt, bewusst nicht blind gemacht): Pipeline im Engine-
  Lebenszyklus konstruieren und den Block-Durchlauf im Live-Pfad an der Stelle einsetzen, an
  der heute `monitorRoutingFacade`/`channelStripState` hängen. Das ist der einzige hörbare
  Pfad — erst nach einer Gehörprobe auf der Flotte, nicht ohne.

### C6a — Offline-Ausführer gebaut und bewiesen (erledigt 2026-10-05)
- `src/audio/pluginChainBounce.ts`: `bounceThroughPluginChain(source, opts)` rendert die
  Quelle Block für Block (Vorgabe 128 = ein Web-Audio-Quantum) durch die 16 Adapter in
  `SIGNAL_CHAIN_ORDER`; Tail als Stille, Rückgabe mit `order`. Zustand wird über
  `restore()`-Snapshots gesetzt — `setParameter()` bräuchte einen Runtime-Kontext und wäre
  im Bounce wirkungslos.
- Hörbar gemacht: Recorder-Terminal → Karte **SIGNALKETTE** → „BOUNCE DURCH DIE KETTE“
  rendert das auf Kanal 1 geladene Lied durch die Kette und legt es als WAV in die Takes
  (`encodeWavFromChannels`). Quelle kommt aus dem bestehenden Decoder-Cache
  (`audioEngine.getMusicSampleChannels`, Kopien — der Cache wird nicht angefasst).
- Beweise in `tests/pluginChainBounce.test.ts` (11 Fälle): OFF = bit-gleicher Bypass;
  Master-Gain wirkt und wird auf 0…2 geklemmt; **Ordnungsbeweis** mit zwei
  nicht-kommutierenden Test-Adaptern — `effect` (addiert 1) läuft vor `master`
  (verdoppelt), Ergebnis `(x+1)*2` und Aufrufprotokoll `['effect','master']`; Ergebnis ist
  blockgrößenunabhängig; Quelle bleibt unverändert; Leerquelle/Mehrkanal in Ordnung.
- **Neuer Befund (der eigentliche Rest):** Kein einziger der 16 Adapter überschreibt
  `onProcess()` — alle nutzen die Basis, die den Block unverändert zurückgibt. Die Kette ist
  damit ausführbar und geordnet, aber bis auf `master` (Master-Gain, jetzt implementiert)
  klanglich noch neutral. `rg "onProcess" src/plugins/adapters/` → nur die Basis.
- Rest für den Live-Pfad: dieselbe Ordnung an die Stelle von
  `monitorRoutingFacade`/`channelStripState` setzen, und die 15 übrigen Adapter brauchen
  echte Block-Verarbeitung (oder eine Delegation an die vorhandenen Worklets) — sonst bleibt
  der Live-Pfad still, egal wie korrekt die Reihenfolge ist.
