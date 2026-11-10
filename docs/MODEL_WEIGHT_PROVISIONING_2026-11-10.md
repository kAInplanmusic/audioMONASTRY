# Zusatzgewichte und Loader: Umsetzung vom 10. November 2026

Ausgangsbasis: `main` bei `ba6fd07c0b320ba6b6e785b351699b66832d58ad`.
Die sechs beauftragten Fehler sind im Code behoben. Eine Freigabe fuer die
laufende GPU-Flotte oder eine Bestaetigung des R2-Bestands ist damit nicht verbunden.
Es bleiben acht Rollen und 22 aktive Modell-IDs. Der YuE2-VAE ist eine
Gewichtskomponente, kein zusaetzliches Flottenmodell.

## Aenderungen

| Befund | Umsetzung |
|---|---|
| Mega 53/BVE ohne Stem-Spec | Beide registriert, Checkpoint/YAML mit vollen Identitaeten und SHA-256 gepinnt; Mega nutzt MSST v1.0.21. |
| DeReverb ohne Hash-Pins | Beide Dateien gepinnt, vollstaendig geladen und gehasht; direkter, gepinnter Download ersetzt die Abhaengigkeit von einem unbestaetigten R2-TAR. |
| YuE2-VAE fehlt | `weightComponents.yue2-vae` im Modellmanifest; neun Dateien einschliesslich Modell, Config, Gewichtsmanifest und Lizenzen separat gepinnt. |
| YuE2/UniverSR ignorieren Revision | Beide Loader uebergeben die Revision explizit. YuE2 nutzt den lokal hashgeprueften VAE und dessen separate Revision. Manifest und Asset-Lock muessen uebereinstimmen. |
| Beat This! ohne Bereitstellung | Atomarer Download nach `/data/weights/beat-this/final0.ckpt`, mit Groessen- und Hashpruefung vor Bereitschaft. Explizite `BEAT_THIS_CHECKPOINT`-Pfade bleiben moeglich und werden vom bestehenden Loader geprueft. |
| Basic Pitch nur `cpu-only` | Code-Tag auf vollen Commit aufgeloest; Wheel 0.4.0 per SHA-256 gepinnt, gebuendeltes ONNX-Modell separat geprueft, CPU-Backend explizit ausgewaehlt und gecacht. |

Zusaetzlich wurde der YuE2-Aufruf an die echte Paket-API angepasst:
`cot=` statt des bisher uebergebenen `planning=`. Das Interface zum App-Payload
bleibt `planning`.

## Gewichtsidentitaeten und echte Downloadbelege

Saemtliche folgenden Bestaende wurden vollstaendig heruntergeladen und gegen
die SHA-256-Werte im neuen `weight_assets.lock.json` geprueft. Dies waren keine
HEAD- oder Range-Proben. Zusammen mit dem Basic-Pitch-ONNX sind es
3.806.987.532 Bytes.

| Bestand | Dateien | Bytes |
|---|---:|---:|
| BVE | 2 | 913.092.230 |
| DeReverb | 2 | 913.109.424 |
| Mega 53 | 2 | 1.368.924.071 |
| Beat This! | 1 | 81.058.141 |
| YuE2-VAE | 9 | 530.573.222 |
| Basic Pitch ONNX aus dem gepinnten Wheel | 1 | 230.444 |

Pins:

- MSST/Mega-Code: `ea7eb9c20ea0e3f94368a30fc1654b51cdd55789`, Release `v1.0.21`.
- BVE: `c73a679a87e568133b7e7387f58c9d3186a51ad4`.
- DeReverb: `cef05ad2b5b3145ea5c149d3ad5d1f8439b34d06`.
- Beat-This-Code: `ad7974846029835307ba19a3d5cefbf40b243041`.
- YuE2-VAE: `m-a-p/YuE2-Vae@152733a19ad43aa67e367f9b5503ef8075bb5126`.
- Basic-Pitch-Code: `9991303bba609a3b93089d13ec80d1d495083596`, Tag `v0.4.0`.
- Basic-Pitch-Wheel SHA-256: `738adb503aae7fdfc7d1e1511aa0ce35052315f260a19531ef4c356708425db0`.
- Basic-Pitch-ONNX SHA-256: `2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec`.

Alle einzelnen URLs, Groessen und Hashes stehen im Asset-Lock; dort gibt es
keine Zugangsdaten und keine kurzlebigen Download-URLs.

## Routing und Ausgabeformate

Mega 53 liefert ueberlappende Kategorien wie `drums`/`kick`/`snare` oder
`guitar`/`acoustic-guitar`. Der Adapter summiert diese nicht doppelt. Fuer den
bestehenden Fuenf-Stem-Vertrag nutzt er `vocal`, `bass`, `drums`, `guitar` und
`piano`; `other` ist der verbleibende Mix. Die existierende Frequenzweiche
liefert weiterhin `vocals`, `lows`, `mids`, `highs`, `melody`.
`includeModelStems: true` liefert wie bisher zusaetzlich die nativen Ausgaben;
bei Mega sind das alle 53. Lange Inline-Ausgaben sind fuer diesen optionalen
Pfad weiterhin nicht produktionsgetestet.

BVE ist ein Spezialist fuer Vokal-Eingaben und liefert `lead`/`back`.
DeReverb liefert `noreverb`/`reverb`. Das jeweilige Upstream-Modell sagt ein
Zielsignal voraus; das zweite Signal wird ehrlich als Residuum gebildet
(`complementIsResidual: true`). Beide unterstuetzen passende `outputUrls`
fuer direkte Ablage. Sie werden nicht als Fuenf-Stem-Trenner ausgegeben.
Der bestehende DeReverb-Zusatz auf Vocal-Stems bleibt erreichbar.

## Automatische Bereitstellung

`weight_assets.py` fuehrt Groessen- und SHA-256-Pruefungen durch, laedt fehlende
oder beschaedigte Dateien atomar und ersetzt gueltige Dateien nicht durch
unvollstaendige Downloads. Wiederholte Zugriffe pruefen Dateistatus und nutzen
bereits verifizierte Dateien; die grossen Dateien werden nicht pro Audiojob
erneut vollstaendig gehasht. Der Basic-Pitch-ONNX-Interpreter wird gecacht.

Der Pod-Start provisioniert die fuer die Rolle benoetigten Zusatzdateien vor
dem Start des HTTP-Prozesses. HTTP- und Serverless-Preload pruefen sie ebenfalls
vor Bereitschaft. Fehler fuehren zu einem Startfehler beziehungsweise fehlender
Readiness. `AI_WEIGHT_ASSET_ROOT` kann den Cache-Ort festlegen; standardmaessig
ist es `/data/weights`. Der Pod-Starter besitzt einen geprueften Schreibpfad-
Fallback. Die Checks und Downloads liegen ausserhalb des Echtzeit-Audiopfads;
Frontend-Synchronisierung und B2B-Locking wurden nicht geaendert.

Basic Pitch wird ohne automatische TensorFlow-Installation aus dem hashgepinnten
Wheel installiert. `requirements-basic-pitch-runtime.lock` pinnt den direkten
ONNX-Stack. `setuptools==80.9.0` ist fuer das von Basic Pitch benoetigte
`resampy==0.4.2` erforderlich, weil neuere Setuptools `pkg_resources` entfernt
haben. Der echte CPU-Test hat diese Kombination bestaetigt.
Der RunPod-Build aktiviert Basic Pitch fuer das gemeinsame Audio-Image und
prueft den ONNX-Gewichtshash. Die Dockerfiles kopieren auch die bisher fehlende
`handlers_fleet2026.py` und die neuen Asset-Dateien.

## Reproduzierbare Betreiberbefehle

Vom Repository-Root; `AI_WEIGHT_ASSET_ROOT` kann fuer lokale Checks auf einen
beschreibbaren Cache zeigen:

```bash
# Vorhandene lokale Bestaende inkl. Paketversion/ONNX pruefen
python3 scripts/provision-model-assets.py

# Fehlende Zusatzdateien automatisch herunterladen und hashen
python3 scripts/provision-model-assets.py --download

# Einzelbestand
python3 scripts/provision-model-assets.py --download --only beat-this

# Optionaler R2-Spiegel; Zugangsdaten kommen aus einer privaten Datei
python3 scripts/provision-model-assets.py --env-file /private/runtime.env --mirror

# R2-Dateien vollstaendig streamen und hashen
python3 scripts/provision-model-assets.py --env-file /private/runtime.env --check-r2 --full

# Ohne --full: Groesse und vom Upload gesetzte SHA-256-Metadaten pruefen.
# Das ist ausdruecklich keine vollstaendige Byte-Integritaetspruefung.
python3 scripts/provision-model-assets.py --env-file /private/runtime.env --check-r2
```

Die Privatdatei benoetigt die vom bestehenden `s3lite.py` unterstuetzten
R2-Zugangsfelder und einen expliziten Bucket. Basic Pitch wird aus dem Wheel
verifiziert und nicht als redundanter R2-Bestand hochgeladen. Das CLI ist auf
die Zusatzbestande dieses Auftrags begrenzt; es bestaetigt nicht die gesamte
22-Modell-Flotte.

## Validierung und Grenzen

- Zehn neue Regressionstests: Integritaet, atomare Downloads, Wiederverwendung,
  Aenderungserkennung, Modell-Pins, Rollenkomponenten, Spezialisten-Dispatch,
  Residuen, Mega-Kategorien und beide Revisionsargumente.
- Vier Flotten-Konfigurationstests gruen; voller BVE-Pin ersetzt die bisher
  im Test explizit tolerierte Kurzrevision.
- Typecheck und ESLint gruen; Python-Quellen kompilieren; `git diff --check` gruen.
- Echter Basic-Pitch-CPU-Durchlauf: drei erzeugte Sinustoene, drei erkannte
  MIDI-Noten, gueltige MIDI-Datei mit 836 Bytes.
- Die echten Checkpoints wurden gegen die echten MSST-v1.0.21-Modellklassen
  mit `load_state_dict(strict=True, assign=True)` geladen. Alle Schluessel und
  Tensorformen stimmen ueberein: Mega 13.595 Tensoren/681.662.892 Parameter;
  BVE und DeReverb je 684 Tensoren/228.202.852 Parameter. Konstruktion auf dem
  Meta-Geraet und mmap-CPU-Laden sind ein Kompatibilitaetsnachweis, kein
  GPU-Inferenz- oder Klangtest.
- `npm run verify` wurde ausgefuehrt. Typecheck/Lint bestehen; die Teststufe
  bleibt rot: 3.726 TS-Tests bestanden, 66 fehlgeschlagen und ein Laufzeitfehler.
  Darunter sind bestehende Flotten-/Manifest-Drifts und Umgebungsfehler wie
  `listen EPERM` beim Start von tsx. Nachfolgende Gates der `&&`-Kette wurden
  dadurch nicht ausgefuehrt. Node ist hier 24 statt der Repo-Vorgabe 22.
- Die Python-Gesamtsuite wurde zum Abgleich auch auf unveraendertem `main`
  ausgefuehrt. Die dortigen 12 Fehlergebnisse und 50 Testfehler sind bestehende
  Altlasten (u.a. inzwischen entfernte Modelle/Rollen). Der geaenderte Stand
  fuehrt 423 statt 413 Tests aus und hat exakt dieselben 12 Fehlergebnisse
  und 50 Testfehler: keine neu fehlgeschlagenen Python-Tests.
- Docker steht in dieser Umgebung nicht bereit. Image-Build und GPU-Lauf
  wurden nicht behauptet. Fuer YuE2/UniverSR bleibt die vorhandene Installation
  ihrer jeweiligen Inferenzpakete Voraussetzung; dieser Auftrag pinnt ihre
  Gewichtsaufladung, er migriert nicht den gesamten Modell-Dependency-Stack.

## Externer Blocker: R2

Beide bereitgestellten Cloudflare-API-Tokens wurden durch den Anbieter mit
HTTP 401 (`Invalid API Token`) beziehungsweise HTTP 403 (`Invalid access token`)
abgelehnt. Die separate signierte R2-S3-Leseprobe lieferte HTTP 401
(`Unauthorized`). Kein R2-Upload und keine Bucket-Aenderung wurden vorgenommen.
Die uebergebenen Zugangsdaten liegen separat vom Quellcode; sie sind weder in
diesem Bericht noch im Commit enthalten. Die Upstream-Bereitstellung der neuen
Zusatzgewichte funktioniert ohne R2-Zugang.

Offen fuer die Produktionsfreigabe bleiben ein authentifizierter R2-Abgleich,
der Image-Build, die Installation der passenden rollenspezifischen Inferenz-
Dependencies und reale GPU-Jobs mit Peak-Speicher-, Laufzeit- und Hoerpruefung.
