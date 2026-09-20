# RunPod-Kaltstart: Ursache, Sofort-Ausweg, Warmhalter, Bake

Ticket: **INFRA-RUNPOD-010** · Stand 2026-09-20 · Betreiber-Dokument (deutsch)

Dieses Dokument beschreibt DREI Abhilfen gegen den Kaltstart der Serverless-Flotte.
Alle Zahlen darin sind gemessen, nicht geschätzt; alle Preise sind Eingaben des
Betreibers mit Quelle, es gibt keine erfundenen Stundensätze.

---

## 1. Was passiert ist (belegt)

**Symptom:** Die Rolle `voiceGen` lieferte keine Hörproben mehr – Job nach Job blieb
in der Queue.

**Ursache 1 – Slot-Deadlock bei `workersMax=1`:** Alle acht Endpoints fahren
`workersMax=1` (live: `docs/audit-infra-runpod.md`, Abschnitt 4.1). Ein **einzelner
`unhealthy` Worker hielt den einzigen erlaubten Slot**, also startete RunPod keinen
frischen Worker – die Jobs warteten auf einen Worker, der nie fertig wurde.

Gemessener Einzeljob (`scripts/voice-coldstart-probe.py`):

| Messwert | Wert |
|---|---|
| Wartezeit (`delayTime`) | **1.175.156 ms ≈ 19,6 min** |
| echte Arbeit (`executionTime`) | **7.640 ms ≈ 7,6 s** |

Vorher/Nachher im Direktvergleich (gleicher Aufruf, gleiche Sprache):
**0/3 Hörproben** während des Ausfalls (alle auf `IN_QUEUE`) gegen
**3/3 COMPLETED in 36 s** Gesamtlaufzeit nach der Reparatur.

**Ursache 2 – langer Kaltstart:** Das Image backt keine Gewichte ein
(`AI_BAKE_ROLE` ist im Push-Pfad leer), `HF_HOME=/data/hf-cache` liegt IM Container
und es hängt kein Network Volume (`networkVolumeId=null`). Jeder neue Worker lädt
die Rollen-Gewichte also erneut herunter.

**Akute Reparatur (belegt):** `PATCH https://rest.runpod.io/v1/endpoints/gajmangfldpzrk`
mit `{"workersMax": 2}` → HTTP 200; Rücklesung `workersMin/Max 0/2`; danach
`health {ready:0, running:2, unhealthy:0}`, alle 4 wartenden Jobs liefen durch
(`completed 44 → 48`, `inQueue: 0`). Anschließend wieder auf `workersMax=1`
zurückgestellt (Rücklesung: 1).

> **Wichtig:** Diese Reparatur ist ein **Betreiber-Eingriff an der Produktion**.
> Sie wird hier beschrieben, nicht automatisch ausgeführt.

---

## 2. Sofort-Ausweg: `workersMax` auf 2 (Selbstheilung)

Ein zweiter Slot hebt den Deadlock auf: startet der eine Worker nicht, bekommt der
Job trotzdem einen frischen Worker. Kosten: Es kann kurzzeitig **ein zweiter GPU-Worker**
laufen, also bis zu 2× der Stundensatz der Rolle – nur solange Jobs anstehen und
`idleTimeout` läuft.

```bash
cd /home/patrick/audioMONASTRY
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
ID=gajmangfldpzrk                      # voiceGen; andere Rollen: docs/audit-infra-runpod.md 4.1
KEY=$(grep -E '^RP_API_KEY=' .env | cut -d= -f2-)

# hochsetzen
curl -sS -X PATCH "https://rest.runpod.io/v1/endpoints/$ID" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "User-Agent: $UA" \
  -d '{"workersMax":2}'

# nachsehen
curl -sS "https://rest.runpod.io/v1/endpoints/$ID" \
  -H "Authorization: Bearer $KEY" -H "User-Agent: $UA" | python3 -m json.tool | grep -i workers

# nach dem Lauf wieder zurueck (Betreiber-Vorgabe: 1)
curl -sS -X PATCH "https://rest.runpod.io/v1/endpoints/$ID" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "User-Agent: $UA" \
  -d '{"workersMax":1}'
```

**Der `User-Agent` ist Pflicht:** `rest.runpod.io` liegt hinter Cloudflare und
antwortet ohne Browser-User-Agent mit **HTTP 403** (live belegt 2026-09-20).
Setzt man `workersMax` per `runpodctl` mehrfach hintereinander, kann der zweite
Aufruf den ersten überschreiben (er baut auf einem veralteten Stand auf) – einzeln
setzen und **nachlesen**.

---

## 3. Warmhalter: `workersMin=1` auf Zeit (`scripts/runpod-warm.py`)

Während einer Session ist der Worker schon da – es gibt weder Kaltstart noch
Deadlock. Das Skript setzt für **eine** Rolle `workersMin=1`, wartet die
vereinbarte Zeit und stellt den **Ausgangswert garantiert** wieder her (auch bei
Strg-C oder Fehler, im `finally`); der Ausgangswert wird vorher gelesen, nicht
angenommen. Danach wird zurückgelesen und der Beleg gedruckt.

```bash
# 1) Trockenlauf: rechnet, zeigt den Plan, sendet KEINEN HTTP-Aufruf
python3 scripts/runpod-warm.py --role voiceGen --minutes 30 --price-per-hour 0.69 --dry-run

# 2) Echter Lauf (ohne --yes: Exit 3, kein einziger HTTP-Aufruf)
python3 scripts/runpod-warm.py --role voiceGen --minutes 30 --price-per-hour 0.69 --yes
```

**Der Stundensatz ist eine Eingabe des Betreibers** – das Skript erfindet keinen
Preis und liest ihn auch nicht selbst (jeder Lese-Aufruf wäre schon ein API-Aufruf).
Quelle zum Ablesen:

```bash
runpodctl gpu list        # Feld securePricePerHr (bzw. communityPricePerHr)
```

Alternativ per Umgebung: `RP_WARM_PRICE_PER_H` (Alias: `RP_GPU_PRICE_PER_H`),
`RP_WARM_MINUTES`, `RP_WARM_IDLE_TAIL_MINUTES`, `RP_WARM_APPROVE=1` (Freigabe).

### Bedienung im Detail

| Option / Variable | Bedeutung |
|---|---|
| `--role` | Pflicht. Rollen: `brain`, `ears`, `voiceGen`, `music`, `imageHq`, `videoReal`, `videoAbstract`, `orchestrator` (Altnamen `vision`/`video` werden abgebildet) |
| `--minutes` | Dauer des Warmhalters, Default 30, **harte Obergrenze 120** (`RP_WARM_MINUTES`) |
| `--price-per-hour` | Pflicht (siehe oben) |
| `--idle-tail-minutes` | Idle-Nachlauf nach dem Zurückstellen; Default = `idleTimeout` der Rolle |
| `--endpoint-id` | Endpoint-ID direkt (schlägt die `.env`) |
| `--yes` | Freigabe. Ohne sie: **Exit 3, kein HTTP-Aufruf** |
| `--dry-run` | Nur rechnen und zeigen, kein HTTP-Aufruf |
| `RP_ENDPOINT_ID_<TOKEN>` | Endpoint-ID je Rolle (`.env`), kanonisch `RP_ENDPOINT_ID_VOICE`; Fallback: `RP_ENDPOINT_ID_VOICE_GEN`, `RP_ENDPOINT_ID_VOICE_GEN`-Variante ohne Trenner und zuletzt das generische `RP_ENDPOINT_ID` |
| `RP_API_KEY` | Token aus der `.env` (oder `RP_AGENT_KEY`/`RUNPOD_API_KEY`) |

### Kostenrechnung (Beispiel, Preis = Eingabe)

```
Kosten = Stundensatz × (--minutes + Idle-Nachlauf der Rolle) / 60
```

| Rolle | `--minutes` | idleTimeout | Rechenzeit | Kosten bei 0,69 $/h |
|---|---|---|---|---|
| voiceGen | 30 | 120 s | 0,53 h | ≈ 0,37 $ (~0,34 €) |
| voiceGen | 60 | 120 s | 1,03 h | ≈ 0,71 $ (~0,65 €) |
| voiceGen | 120 (Maximum) | 120 s | 2,03 h | ≈ 1,40 $ (~1,29 €) |

Der Idle-Nachlauf ist **echt**: nach `PATCH workersMin=0` läuft der Worker noch
seinen `idleTimeout` weiter und wird in dieser Zeit weiter abgerechnet. Die
Umrechnung $ → € ist nur Anzeige (Satz 0,92 wie in `docs/AI_COST_GUIDE.md`).

### Exit-Codes

| Code | Bedeutung |
|---|---|
| 0 | Warmhalter gefahren **und** zurückgestellt (Rücklesung belegt es) |
| 2 | Aufruf-/Konfigurationsfehler (Rolle, Endpoint-ID, Preis, Minuten-Grenze, `workersMin` nicht lesbar) |
| 3 | Freigabe fehlt – es wurde **kein** HTTP-Aufruf gesendet |
| 4 | Lauf abgebrochen/fehlgeschlagen – **zurückgestellt wurde trotzdem** |
| 5 | Zurückstellen fehlgeschlagen oder Rücklesung weicht ab → **jetzt handeln**: `runpodctl endpoint update --id <id> --min-workers <wert>` |

---

## 4. Bake: Gewichte ins Rollen-Image (Workflow-Input)

Zweiter Hebel gegen den **langen** Kaltstart: Gewichte in das Image einbacken, dann
muss kein Worker sie je wieder herunterladen. Der Bake-Pfad ist ein **optionaler
Zusatz** – der normale Push auf `main` baut unverändert das schlanke Image
(`AI_BAKE_ROLE=` leer).

**Starten:** Actions → Workflow `runpod-deploy` → *Run workflow* → `bake_role` setzen.

| Input | Werte | Wirkung |
|---|---|---|
| `bake_role` | leer (Default) / `ears` / `voiceGen` / `orchestrator` | leer = nichts Neues. Gesetzt = baut ZUSÄTZLICH ein Rollen-Image, pusht es und gibt es **nur dieser Rolle** (via `RP_IMAGE_<TOKEN>`) |
| `bake_groups` | Zahl, leer = Repo-Variable `AI_BAKE_GROUPS`, sonst 4 | Anzahl Layer für die Gewichte (kein Einzel-Layer über 10 GB) |
| `role` | leer (= alle acht) oder genau die Bake-Rolle | **Leer lassen**, wenn nur das Rollen-Image der einen Rolle erneuert werden soll. Ein anderer Wert setzt den Override, deployt aber eine andere Rolle – der Deploy meldet das dann als *Override ungenutzt* |

Was der Workflow dabei tut (alles bereits vorhanden, nichts Neues nötig):

1. baut und pusht weiter das schlanke Image `:latest` und `:<sha>`,
2. baut zusätzlich `Dockerfile.runpod` mit `AI_BAKE_ROLE=<bake_role>` und
   `AI_BAKE_GROUPS=<n>` und pusht **eigene Tags**:
   `:<sha>-baked-<rolle>` und `:baked-<rolle>-latest`,
3. setzt im Deploy-Job `RP_IMAGE_<TOKEN>` auf dieses Tag (nur für die eine Rolle),
4. der Deploy (`scripts/runpod-deploy.py`) gibt den Override an die Rolle weiter –
   **mit Vorrang vor dem globalen `IMAGE`** und sichtbarer Quelle in der Ausgabe.

Rollen-Token (kanonisch, gleiche Kennung wie bei den Endpoint-IDs):

| Rolle | Env-Variable | Beispiel-Tag |
|---|---|---|
| `voiceGen` | `RP_IMAGE_VOICE` | `:baked-voicegen-latest` |
| `ears` | `RP_IMAGE_EARS` | `:baked-ears-latest` |
| `orchestrator` | `RP_IMAGE_ORCHESTRATOR` | `:baked-orchestrator-latest` |

**Erlaubt sind nur diese drei Rollen.** `brain` läuft auf dem vorgefertigten
vLLM-Worker, `music`/`imageHq`/`videoReal`/`videoAbstract` auf Hub-Workern, die
ihre Gewichte selbst mitbringen. Ein Override würde diese Rollen mit unserem
Runtime-Image überschreiben und damit kaputt machen – der Workflow bricht bei einem
anderen Rollennamen mit einer klaren Meldung ab.

### Ohne Workflow (lokal, ein Befehl je Rolle)

Der Deploy liest den Override auch lokal; `RUNPOD_ROLE` begrenzt ihn auf die Rolle:

```bash
cd /home/patrick/audioMONASTRY
IMAGE=ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod:<sha> \
RP_IMAGE_VOICE=ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod:<sha>-baked-voicegen \
RUNPOD_ROLE=voiceGen \
RP_API_KEY=$(grep -E '^RP_API_KEY=' .env | cut -d= -f2-) \
python3 scripts/runpod-deploy.py
```

Das Image baut der Workflow – das Skript baut nichts selbst (kein `docker build`,
kein Push). Für ein Rollen-Image per Bild-Lauf steht `AI_BAKE_ROLE`/`AI_BAKE_GROUPS`
im `Dockerfile.runpod` bereit; die Zeilen dort backen die Rollen-Gewichte nach
`/data/hf-cache` (identisch zum `HF_HOME`, damit ein späteres Volume sie überdecken
kann).

### Was ein Override NICHT kann – ehrliche Grenzen

* **Das Image wird größer** (Gewichte liegen im Layer-Stack): der **erste** Pull auf
  einem Host dauert länger. Der Bake verlagert die Zeit vom Kaltstart in den Pull/Build.
* **Das Rollen-Template zeigt danach auf das Bake-Tag.** Wechselt man zurück auf
  `:latest` (kein Override), wird beim nächsten Deploy das Template umgestellt und
  die Rolle zieht wieder das schlanke Image.
* **Das Bake-Tag ist an einen Commit gebunden** (`:<sha>-baked-<rolle>`) plus
  `:baked-<rolle>-latest`. Der Workflow prüft den Tag nach dem Push (best effort),
  die Aussage „die Gewichte sind drin" belegt das Build-Log des Bakes.
* **Bake ersetzt den Warmhalter nicht.** Im Deadlock-Fall hilft nur ein zweiter Slot
  (`workersMax=2`) oder ein bereits laufender Worker (`workersMin=1`).

---

## 5. Abwägungen

| Hebel | Kosten | Wirkung | Grenze |
|---|---|---|---|
| `workersMax=2` | kurzzeitig 2× Stundensatz | hebt den Slot-Deadlock sofort | halbiert das Risiko nicht; zwei Worker können parallel laufen |
| `workersMin=1` (Warmhalter) | **Dauerkosten** ≈ 0,4–0,75 €/h je nach Karte | kein Kaltstart in der Session | läuft gegen „Scale-to-Zero"; nur auf Zeit gedacht (max. 120 min je Lauf) |
| Bake (`AI_BAKE_ROLE`) | größeres Image, längerer erster Pull | kein Gewichts-Download je Kaltstart | Rollen-Image je Rolle pflegen; Rückschalten = Template-Update |
| Network Volume (`networkVolumeId`) | Volume-Grundgebühr | Cache überlebt Worker | nur in einem Teil der Rechenzentren verfügbar, und dort gibt es keinen A40/A6000-Pool (im Dockerfile begründet) |

**Konstitution:** Das Budget erlaubt bis 10 €/h, das Zielband liegt bei 5–7,50 €/h.
Ein Warmhalter über 30 min kostet nach der Rechnung in Abschnitt 3 deutlich unter 1 €
– er ist trotzdem eine **Betreiber-Entscheidung**, weil er dauerhaft läuft und
niemand die Kosten „im Vorbeigehen" sieht.

---

## 6. Was der Betreiber tun muss

1. **Deadlock jetzt auflösen** (falls Jobs hängen): Abschnitt 2, `workersMax: 2`,
   danach zurücklesen und nach dem Lauf auf `1` zurückstellen.
2. **Session vorwärmen:** `python3 scripts/runpod-warm.py --role voiceGen --minutes 30 --price-per-hour <Satz aus runpodctl gpu list> --yes`
   (erst mit `--dry-run` rechnen lassen).
3. **Rollen-Image mit Gewichten ausrollen** (einmalig, dauerhafte Abhilfe):
   Actions → `runpod-deploy` → *Run workflow* → `bake_role: voiceGen` (optional
   `bake_groups`) → der Job baut, pusht und setzt den Override der Rolle.
4. **Nach dem Rollout prüfen:** im Deploy-Log steht je Rolle
   `Image-Quelle: Override RP_IMAGE_VOICE …` und die genutzte Image-URL; einen
   echten Job über den voice-Endpoint schicken und `delayTime` mit dem Wert aus
   Abschnitt 1 vergleichen (19,6 min war der Ausfallwert).
5. **Entscheidung dokumentieren:** Wenn `workersMin=1` / `workersMax=2` dauerhaft
   gefahren werden soll, gehört das in die Kostenzeile der Konstitution – nicht in
   einen stillen Endpunkt-Patch.

Offen bleibt: Worker-Logs aus der Konsole, um Startfehler von Zeitüberschreitung zu
trennen (das kann kein Skript aus dem Repo belegen).
