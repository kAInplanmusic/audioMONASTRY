# Startzettel für die nächste Sitzung

**Stand bei der Übergabe: `main` = 19294f7 (== origin), Flotte AUS (0 Server), SSOT = 144 Einträge.**
Dieser Zettel ist die Einstiegsstelle. Die verbindliche Wahrheit steht in `MASTERTODOENDE.json`
(18 offene Punkte: 15 PARTIAL, 3 OPEN) — hier stehen die Reihenfolge und die Kommandos.

## 1. Zuerst: Zustand übernehmen

```bash
cd /home/patrick/audioMONASTRY
git fetch origin && git log --oneline -1 origin/main        # muss 19294f7 oder neuer sein
git worktree list                                           # drei Zweige können noch offen sein
for b in portal scripts lora; do
  echo "--- hermes/$b"; git log --oneline main..hermes/$b | head -5
done
```

Drei Aufträge aus der Vorsitzung lagen noch auf Zweigen. **Prüfen, dann mergen — nicht blind:**

| Zweig | Stand bei Übergabe | Was zu tun ist |
|---|---|---|
| `hermes/portal` | fertig (f030645, 6 Dateien +558/−149) | Zieltests + Gate, dann mergen (PROD-P0-PORTAL-FAILOPEN, PROD-P2-PORTAL-DRIFT) |
| `hermes/scripts` | **mitten in der Arbeit** (2 Dateien entfernt) | warten bis fertig; das Verfahren des Betreibers gilt: Recovery-Bündel zuerst, eine Datei pro Commit, Funktionstest nach JEDEM Schritt |
| `hermes/lora` | **noch kein Commit** | warten; baut Checkpoints/Resume/Fortschrittsmarker/Vorab-Rechnung + Volume-Staging |

Prüf-Routine bei jedem Merge (aus dieser Sitzung bewährt):

```bash
git merge --no-ff hermes/<zweig> -m "merge(hermes/<zweig>): <was>"
npm run test:python:fleet && npx tsc --noEmit && npx vitest run
npm run verify                      # volles Gate VOR dem Push, im Hintergrund starten
git push origin main                # erst bei GATE_EXIT=0
```

## 2. Vor JEDEM Live-Test: Flotte starten und Vernetzung prüfen

```bash
LOCATION=nbg1 bash scripts/hetzner/bring-up-fleet.sh --yes     # ~6 min, legt 5 Knoten an
python3 scripts/hetzner/firewall-ensure.py --dry-run           # MUSS "geaendert=0" melden
```
Warum das wichtig ist: die Firewalls überleben den Abbau und werden über den Namen
wiederverwendet — genau so wanderten früher die alten Quell-IPs in die neue Flotte
(INFRA-HETZNER-014). Der Abgleich läuft beim Flottenstart automatisch (Schritt 3/9),
`--dry-run` ist der Beweis. Die Flotte schaltet sich nach 15 Minuten ohne App-Nutzung
selbst ab (gewollt, PROD-P3-F9); `https://anunnakitools.de` antwortet dann weiter mit 200
— das kommt von Cloudflare, nicht von einer laufenden App.

## 3. LoRA: Abschnittsbetrieb mit vorgefülltem Volume (entschieden, Budget ≤ 5 €)

1. **Vorstagen (CPU-Pod, Cent-Betrag, ausdrücklich genehmigt):** Network Volume 50 GB
   (2,50 USD/Monat ≈ 8 Cent/Tag) anlegen, darauf einmalig FLUX-Gewichte (~24 GB),
   Dataset und Trainer-Checkout. Danach startet jeder GPU-Abschnitt in Minuten statt ~30.
2. **Abschnitt fahren:** 1000 Schritte ≈ 0,35 USD. Danach Vorschaubilder rendern und
   **entscheiden**, ob ein weiterer Abschnitt kommt (mehr Daten schlagen mehr Schritte:
   37 Bilder sind nach 1000–2000 Schritten ausgereizt, mehr riskiert Überanpassung).
3. **Aufräumen:** Volume nach der Trainingsphase löschen (`--print-config` nennt den Befehl).
   Die 2,0 s/Schritt sind eine ANNAHME — der Fortschrittsmarker liefert erstmals echte Zahlen.
   Bilder zum Ansehen: `/home/patrick/am-cosmic-vorschau/{rohdaten-40,datensatz-37}`.

## 4. Nächste Arbeitspakete (Reihenfolge nach Wirkung)

1. **SFU scharf** (INFRA-HETZNER-015, Entscheidung „go"): ACME-Caddyfile in den Flottenstart,
   `ENABLE_SFU=1`, echte Sitzung gegen `wss://sfu.<domain>` prüfen. Ohne Vorteil: rückstandsfrei zurückbauen.
2. **Prompts auf Englisch** (AI-P1-PROMPTS-002): alle Rollen-Prompts englisch, Deutsch nur in
   Kommentaren/Doku; masterplayer bleibt rein visuell (kein Prompt, keine Eingabe, kein Knopf —
   als Testvertrag verankern); Score-Gate für Bild/Video, Gates 4.00/4.50 getrennt; Latein nur
   bei belegten Wörtern (cantus, lumen, ordo, vox, silentium, imago, motus) — Auswahl dem Betreiber vorlegen.
3. **Weitere Themen** (VISUAL-P1-009): wartet auf `/home/patrick/am-vis-themen/<thema>/` vom Betreiber.
4. **Deploy am Ende der Skript-Runde** (PROD-P3-SKRIPTE-01): aktueller Deploy + Push, Recovery-Bündel
   und Dateien lokal bereithalten, erst nach erfolgreichem Deploy löschen.

## 5. Was in der Vorsitzung bewiesen wurde (nicht erneut prüfen, nur nutzen)

Registry-Deploy ohne lokale Ressourcen (`DEPLOY_IMAGE_SOURCE=registry`, gemessen 1,43 GB in 168 s),
Remote-Build als Flottenstart-Default, paralleler Medienweg über R2 (`--via-r2`), Firewall-Abgleich,
Grafana-Panels repariert (inkl. korrigiertem Metrik-Präfix `audiomonastry_`) mit neuem Vertragstest,
Duplikate 34 → 4, Deep-Audit 26 → 3 Findings. Zwei Zugangsdaten-Regeln gelten seither überall:
**die `.env` schlägt die Prozessumgebung** (GHCR und R2), Overrides nur ausdrücklich; und bei
Cloudflare-IP-Ausfall bleibt der Origin **zu** (fail-closed).
