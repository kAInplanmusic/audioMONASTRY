# audioMONASTRY — Acht Vast.ai GPU-Rollen · Start/Stop/Recovery (2026-11-17)

**Gültige Architektur:** Vier Hetzner-App-Rollen, acht kurzlebige Vast.ai GPU-Rollen, Cloudflare R2 für Modelle und dauerhafte Artefakte, Supabase für persistente App-Daten. **Kein Hugging Face Inference Endpoint.** Hugging Face Hub darf nur als Quelle gepinnter Gewichte dienen.

## Verbindliche Quellen

- `deploy/gpu-provider.json`: `vast`, maximal 8 EUR GPU-Flotte pro Stunde, keine versteckte automatische Aufladung; zuzüglich separat bepreister Hetzner/R2/Supabase-Ressourcen.
- `deploy/gpu/pod-fleet.json`: die acht Rollen, konkrete Modell-IDs, VRAM-/Disk-Anforderungen und erlaubte GPU-Angebote.
- `services/audiomonastry-ai-runtime/model_manifest.json`: 22 derzeit aktive gepinnte Modell-/Paket-IDs; kein automatischer Austausch gegen die neun Kandidaten.
- `deploy/gpu/frontier-candidates.json`: neun Kandidaten mit eigenem isolierten R2-Staging; **keine** produktive Aktivierung ohne Handler/Tests und Lizenzfreigabe.
- `deploy/vast/images.json` + `deploy/vast/image-attestation.json`: geprüfte Container-Digests; nach Änderungen an Runtime, Dockerfile oder Modellmanifest neu bauen und attestieren.
- `scripts/gpu-lifecycle-preflight.py`: prüft ohne GPU-Kosten die acht Rollen, den Modellkatalog und den unerwünschten HF-Endpoint-Pfad.

## Acht Rollen und produktive Modelle

| Vast-Rolle | Modelle im aktuellen produktiven Manifest | Funktion |
|---|---|---|
| brain | qwen38-27b-fp8 | Große LLM-Aufgaben, Koordination und Reasoning |
| ears | moss-music-8b-instruct, clap-music, beat-this, songformer, dsp-analysis, basic-pitch | Musik verstehen, Beats/Features erkennen, DSP/MIDI |
| voice | qwen3-tts-17b, qwen3-tts-voicedesign, moss-soundeffect-v2.0, acestep-v15-xl-base, acestep-v15-shared | TTS, Soundeffekte und bestehende ACE-Abhängigkeiten |
| music | acestep-v15-xl-turbo, acestep-5hz-lm-4b, acestep-v15-shared | Musikgenerierung |
| studio | sonicmaster, bs-roformer-sw-6stem, mvsep-mega-53, mel-roformer-bve | Mastering und Stem-Separation |
| audio-brain | qwen3-4b | Schnellere genehmigungspflichtige DAW-Ausführung |
| song | yue2-3b | Gesungene Songgenerierung |
| vis | universr, mel-roformer-dereverb | Derzeit Audio-Upsampling/DeReverb; noch KEIN attestierter generativer Videodienst |

*Wichtig:* Die neun zusätzlichen Kandidaten sind **nicht** als funktionierende Laufzeitmodelle vorzutäuschen. Die VIS-Videomodelle und die größeren EARS-Modelle müssen zuerst in passenden Image-/Loader-Profilen integriert und auf realer GPU geprüft werden. Einzelne aktive Einträge sind CPU/DSP-Pakete und benötigen keinen separaten GPU-Checkpoint.

## Ohne Miete prüfen

```bash
python3 scripts/gpu-lifecycle-preflight.py
python3 scripts/gpu-lifecycle-preflight.py --check-r2
python3 scripts/gpu-pods.py plan
python3 scripts/gpu-pods.py status
```

Die R2-Prüfung benötigt die bereits hinterlegten S3-Secrets im Ausführungsumfeld. Eine GitHub-Secret-Referenz bedeutet nicht, dass dieselben Werte automatisch auf einem Hetzner-Host vorliegen. `plan` fragt frische Vast-Angebote ab, reserviert aber **nichts**.

Vor einer bezahlten Provisionierung müssen alle acht Rollen Gewichte/erforderliche Zusatzdateien, signierte Registry-Images, Host-Angebote, vollständige Transferkosten und Budgetgrenzen nachweisen. Gated/NC-Modelle nicht unbewusst freischalten.

## Bisheriger Startpfad (nach Preflight)

```bash
# Hetzner + Vast: nur mit bewusst bereitgestellten Secrets und Konfigurationsdateien
./scripts/hetzner/fleet-start-complete.sh --dry-run
./scripts/hetzner/fleet-start-complete.sh --yes
```

`scripts/fleet-start.py` provisioniert die fehlenden Hetzner-Knoten, deployed die App, ruft anschließend `scripts/gpu-pods.py up --yes` auf und prüft Health/Readiness. Ein erfolgreicher Container-Start allein reicht **nicht**. `VAST_APP_ENV` muss auf eine vorhandene vertrauenswürdige App-Umgebung zeigen, wenn die acht geprüften Pod-URLs/CA automatisch übernommen werden sollen. Danach muss der Node-Dienst kontrolliert neu gestartet werden. Ohne diesen Nachweis ist die App-Verknüpfung **nicht bestätigt**; einen kostenpflichtigen Start dann nicht fortsetzen.

## 30 Minuten Idle: Snapshots erstellen, danach wirklich löschen

1. Die App wertet letzte erfolgreiche Nutzeraktivität, aktive Sessions, GPU-Jobs und Host-Beschäftigung aus. Monitoring-Zugriffe verlängern die Laufzeit nicht.
2. Nach 30 Minuten ohne Aktivität, verbundenen Client oder aktiven Job löst der getrennte Watchdog das Teardown aus. Ein App-Neustart darf die Frist nicht eigenmächtig auf null setzen, solange Jobs laufen.
3. `scripts/fleet-teardown.py --yes` beendet Vast-Mietinstanzen per **delete** (nicht nur `stop`). Stopped Vast disks kosten weiter Geld.
4. Vor der Löschung der Hetzner-Knoten erstellt das Teardown snapshots und wartet auf den Status `available`; schlägt der Snapshot fehl, wird dieser Knoten **nicht** gelöscht.
5. Der letzte Watchdog-/Koordinatorknoten wird zuletzt gelöscht, und APIs müssen bestätigen, dass **keine** Cloud-Server und **keine** GPU-Mietinstanzen des Projekts zurückbleiben.

Der Watchdog wird auf **App und Edge** installiert. Er hat zusätzlich eine 30-Minuten-Karenz, falls die App nicht erreichbar ist. Der Server-Installer und `scripts/production/idle-policy.py` müssen beim nächsten echten Deployment auf denselben 30-Minuten-Wert gebracht und live durch `scripts/hetzner/check-idle-shutdown.sh` geprüft werden.

**Kosten nach dem Stop:** Keine gemieteten GPUs/Hetzner-Server, sofern vollständige Löschung per API nachgewiesen wurde. **Nicht null:** R2-Objekte, Supabase, Hetzner-Snapshots, registrierte Volumes und eventuell externe Dienste. Vor dem nächsten Start R2/Backup-Retention und Snapshot-Kosten prüfen.

## Persistenz und Recovery

- **Software Golden Master:** unveränderliches Repo/Container-Digest/Versionsmanifest.
- **Modellgewichte:** gepinnte R2-Archive plus SHA256, getrennt von App-Backups; nur für den genau angegebenen Modellrevision laden.
- **Studio-Projekte:** Supabase + R2-Backups, transaktional und wiederherstellbar; niemals nur auf einer Vast-Container-Disk.
- **Hetzner-Zustand:** Snapshot je Serverrolle; mindestens ein bestätigter Snapshot verfügbar, bevor ein Server gelöscht wird; Aufbewahrung auf dokumentiertes Budget begrenzen.
- **Vast-Rollen:** nach `down` bei jedem Start neu provisionieren und aus R2/Images laden. Das ist **kein** warmes Disk-Snapshot. Für einen temporären kostenpflichtigen Disk-Warmstart existieren separate `stop`/`resume`-Befehle; sie sind **nicht** Standard für 30-Minuten-Autolöschung.

## Noch nicht live bestätigt

Der aktuelle Code- und Konfigurationsstand beweist **nicht**, dass alle Gewichte in R2 liegen, alle acht Model-Handler auf GPU durchlaufen, ein Self-Hosted-Mirror-Runner bereitsteht, der Vast-Account aktuell Guthaben hat, oder dass die 30-Minuten-Timer auf dem echten Hetzner-System installiert wurden. Diese Gates bleiben vor produktiver Freigabe zwingend.
