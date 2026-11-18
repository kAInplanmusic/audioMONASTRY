# Flotte: Module, Schnittstellen, Prüf-Gates und gelernte Fehlerklassen

Stand 2026-11-18. Nur geprüfte Aussagen; jede Zeile nennt Beleg (Code, Test, Messung) und Status.
**Status:** `geprüft` = am Code oder in einem Lauf belegt; `offen` = nicht belegt.
Verwandte Dokumente: `docs/FLEET_EVIDENCE.md` (Herstellerdoku), `docs/GOLDEN_MASTER_STARTUP_PLAN.md` (Messläufe, Plan).

## 1. Beteiligte Instanzen
| Instanz | Rolle | Quelle der Wahrheit |
| --- | --- | --- |
| 1 Hetzner-App-Server (ccx33, Snapshot 457927664) | Node-App, Caddy, master-player; Orchestrator-Konfiguration in `/opt/audiomonastry/.env` | `docker-compose.hetzner.yml`, `scripts/hetzner/app-from-snapshot.py` |
| 8 Vast-Pods | brain, ears, voice, music, studio, audio-brain, song, vis (7 Images) | `deploy/gpu/pod-fleet.json`, `deploy/vast/images.json` |
| temporärer Hetzner-Messserver (cx23) | misst Erreichbarkeit/Bereitschaft von außen | `scripts/pod_reach_probe.py`, `scripts/measure-from-hetzner.py` |
| Cloud-Sandbox (nur Steuerung) | mietet Vast-Instanzen; **erreicht Pods per TLS nicht** (Proxy blockt IP/Port-TLS, Gegenproben Cloudflare:8443, 1.1.1.1) | Startplan B4 |

## 2. Schnittstellenmatrix
| # | Strecke | Protokoll / Auth | Daten | Konfiguration | Code | Beleg / Status |
| --- | --- | --- | --- | --- | --- | --- |
| I1 | App → Pod (Aufträge) | HTTPS, `Authorization: Bearer AI_POD_TOKEN` | `POST /runsync`, `POST /run`, `GET /status/{id}`, `POST /cancel/{id}` | `VAST_POD_URL_<ROLLE>` (`-`→`_`, nur `https://host:port`), `AI_POD_TOKEN` (≥ 32 Zeichen), `AI_GPU_PROVIDER=vast` | `src/core/ai/orchestrator/podRouting.ts`, `vastProvider.ts`; Pod: `app.py` (Routen vorhanden) | **geprüft** am Code (Routen und Schlüsselformat stimmen überein); live offen |
| I2 | App → Pod (TLS-Vertrauen) | Selbstsignierte Pod-Zertifikate mit IP-SAN, in `ca.pem` gebündelt | – | `NODE_EXTRA_CA_CERTS=/etc/audiomonastry-vast/ca.pem`; Compose mountet `./vast-ca` | `docker-compose.hetzner.yml:213`, `scripts/vast-pods.py` | Zertifikats-IP-SAN in der Probe bestätigt (Hostprüfung aktiv); App-seitig live offen |
| I3 | Rolle → Pod-Zuordnung | – | brain→brain, ears→ears, voiceGen→voice (stem.separate→studio), music→music (LEGO→voice, yue2→song), audioBrain→audio-brain, song→song, vis→vis | – | `podRoleFor()` in `podRouting.ts` | **geprüft** am Code |
| I4 | Orchestrator → Vast-API | HTTPS, Schlüssel nur serverseitig/Proxy | `PUT /asks/{id}` (Miete), `DELETE /instances/{id}`, `request_logs` | `VAST_API_KEY` | `scripts/vast-pods.py` | Doku V1–V16 (`FLEET_EVIDENCE.md`), Läufe 2026-11-18 |
| I5 | Pod → R2 (Gewichte) | vorsignierte URLs, Range-GET | tar/Dateien je Rolle | `AI_WEIGHTS_URLS` (komprimiert) | `pod_start.py`, `s3lite.py` | Doku R1–R5; Gewichte audio-brain 124–216 s (Pod-Log) |
| I6 | Pod → Hugging Face (nur brain, song: `directRepo`) | HTTPS, **Content-Encoding br** | Modelldateien | `HF_HUB_OFFLINE` aus | `huggingface_hub` 2.4.0 + `httpx2` + **`brotli>=1.2.0`** | brain-Fehler hier gefunden (Abschnitt 4); Korrektur im Image, Lauf #18 |
| I7 | Pod ← GHCR (Image-Pull) | klassisches PAT `read:packages` | Image-Layer | `image_login` im Mietauftrag | `create_body()` | Doku G1; Pull-Zeit 45 s bis über 8 min |
| I8 | Messserver → Pod | TLS + Bearer, Zertifikats-Pinning | `/models` (geladene Modelle), `/ready` | Zielliste in Cloud-Init | `pod_reach_probe.py` | Läufe 18:54 und 19:08: Erreichbarkeit **belegt** |
| I9 | Restore App-Server | Hetzner-API, Cloud-Init | Pod-Werte in `.env` einfügen, CA ablegen, `docker compose up -d --force-recreate audiomonastry` | Snapshot-ID | `scripts/hetzner/app-from-snapshot.py` | offline getestet; **live offen** |
| I10 | App → vis-Pod (`/visual/*`) | – | – | – | **kein Aufruf im App-Code** (`server/`, `src/`) | **offen / nicht verdrahtet:** Die App nutzt ihre eigene Pipeline (VisualMONK, `server/visualStream.ts`, `/api/visual/status`); der vis-Pod wird gemietet und bereit, aber von der App nicht angesprochen |
| I11 | Pod → Autostop/Wake durch die App | Vast-API | Instanz beenden/starten | `VAST_API_KEY` auf dem App-Server | `fleetAutostop.ts`, `fleetWake.ts` | Schlüssel liegt nicht auf dem Server (Proxy-Header): Autostop/Wake **nicht funktionsfähig** |

## 3. Prüf-Gates: was fängt was (in Ablaufreihenfolge)
| Gate | Fängt | Beleg |
| --- | --- | --- |
| Preflight (`vast-pods.py preflight`) | Kosten, Digests, Gewichts-Links, Hostgrenzen | jeder Lauf |
| Build-Schritt „Canonical pinned model config" | Hub-Download-Fehler im Image (hat den brotli-Fehler gefangen) | Lauf 44412828901 |
| Build-Schritt „transformers Import-Pfad" + brotli-Prüfung | Versionsverschiebungen, `Decompressor.process(output_buffer_limit=…)` | `Dockerfile.vast` |
| Build-Schritt ears-Import | fehlende SongFormer-Pakete | `Dockerfile.vast` |
| Pod-Log `models ready` / `model preload failed` mit Text und Frames | Lade- und Importfehler je Rolle | `app.py`, `tests/test_runtime_diagnostics.py` |
| Messserver (`pod_reach_probe.py`) | Erreichbarkeit, Modelle geladen, `/ready` 200, Grund bei 503 | `tests/test_pod_reach_probe.py` |
| Host-Auswahl (`finalize-runtime-from-probe.py`) | nur bereite Hosts kommen in die App-Konfiguration | `tests/test_finalize_runtime.py` |
| Kaltstart-Bericht (`cold_start_report.py`) | Zeit je Rolle, Ziel 15 min, Hinweise | `tests/test_cold_start_report.py` |

## 4. Gelernte Fehlerklassen (Messläufe 2026-11-18) und Gegenmaßnahme
| Fehler | Ursache | Gegenmaßnahme | Status |
| --- | --- | --- | --- |
| brain: `TypeError` beim Modell-Laden (und Build-Fehler) | `brotli < 1.2.0` mit `httpx2 2.16.2` / `huggingface-hub 2.4.0`: `process() takes no keyword arguments` | `brotli>=1.2.0` + Build-Prüfung; **Lehre:** frei laufende Abhängigkeiten (httpx2) verschieben sich zwischen Bauläufen: neue Pakete mit Build-Prüfung absichern, mittelfristig pinnen | Fix im Image, Lauf #18 |
| song: Absturzschleife | `visual/effects.json` fehlt im song-Image; `vast_app` importierte `visual_renderer` beim Start | Import optional, nur vis braucht das Modul | behoben (`0ae0537`), mit Test |
| ears: SongFormer fehlt | `ema_pytorch`, `loguru`, `x_transformers`, `muq` (+ einx, nnAudio, easydict, x-clip) nicht installiert | Lock ergänzt (Versionen laut Upstream), Build prüft Importe | behoben im Code, **live offen** |
| voice: `OfflineModeIsEnabled` | `Qwen3TTSModel.from_pretrained(repo-id)` macht Hub-Anfragen im Offline-Pod | lokaler Snapshot-Pfad | begründet, **live offen** |
| Messung aus der Sandbox ohne Ergebnis | Sandbox-Proxy blockt TLS zu IP/Port | Messserver bei Hetzner | behoben |
| Probe 401 überall | Pod-Token wurde je Lauf neu erzeugt, falsches Token verwendet | Token wird in `vast-state/pod-token` abgelegt | behoben |
| Messfenster zu kurz | 150 s Wartezeit nach dem ersten Port | `--port-grace-seconds`, `--save-result` | behoben |
| Mietversuche scheitern | Angebotslimit 40 verengte die Hostauswahl; Geister-Angebote | Limit 100; Wiederholung mit anderem Host | behoben |

## 5. Offene Punkte für „komplette App"
1. DNS: neue IP nach dem Restore; Cloudflare-Tokens dieser Umgebung sind ungültig → Betreiber stellt um.
2. I10: vis-Pod ist nicht mit der App verdrahtet (siehe Matrix).
3. I11: Autostop/Wake ohne `VAST_API_KEY` auf dem Server; Pods laufen bis zum manuellen Ende oder zum Timer.
4. Live-Beleg der Fixes für ears und voice steht aus; brain/song nach Lauf #18.
5. Browser-Betrieb der App (4 Nutzer, Main-Out) ist hier nicht geprüft.
