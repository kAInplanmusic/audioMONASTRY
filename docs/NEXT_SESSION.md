# Startzettel für die nächste Sitzung

**Stand: 2026-09-23 (nach ReleaseCycle Iteration 3). `main` = `6c2e3c8`, sieben Commits
über `e71cb7d`. Arbeitsbaum sauber, nichts ungetrackt. Flotte AUS (0 Server).
SSOT = `MASTERTODOENDE.json` mit 161 Einträgen (139 DONE · 15 PARTIAL · 6 OPEN · 1 BLOCKED).**

Gates dieser Runde, gemessen: `tsc` exit 0 · `eslint` exit 0 · `vitest` **283/283 Dateien,
2 150/2 150 Tests grün** · `npx knip` **keine ungenutzten Dateien** mehr.

```bash
git log --oneline e71cb7d..HEAD
# 6c2e3c8 docs: PRINCIPLES, Recht-Entwurf, Token-Rotation, README-Kopf, Audit-Report, SSOT
# 096ba2e fix(db): supabase-Migrationssatz konsolidiert, database/ als historisch markiert
# 130ea0f refactor: belegt-toten Code entfernt, knip.jsonc bereinigt
# d357dca fix(legal): drei Demo-Tracks entfernt, Lizenz gesetzt
# e2adc9e fix(audio): Hörprobe nur noch über den V2-Sink
# 91eca69 feat(server): Kill-Switch, /music-Zugangsschutz, Build-Stempel, Ruhe-Modus
# e547069 chore(security): .env-Rechte 600, Schlüssel-Muster in .gitignore
```

Die verbindliche Wahrheit steht in `MASTERTODOENDE.json`. Dieser Zettel nennt Reihenfolge und
Kommandos. Vollständiger Audit: `docs/AUDIT_REPORT_2026-09-23.md` (mit Nachträgen für
Iteration 1 und 2).

## 0. Zuerst: Zustand übernehmen

```bash
cd /home/patrick/audioMONASTRY
git log --oneline -1                    # muss 6c2e3c8 oder neuer sein
git status --porcelain                  # muss leer sein
git worktree list
git branch -a | grep hermes             # nur noch hermes/lora-trainer-anbindung
```

Die drei Übergabe-Zweige aus der Vorsitzung sind **gemergt** – hier ist nichts mehr zu tun
(Korrektur zum früheren Zettel, der sie noch als offen führte):

| Zweig | Stand | Beleg |
|---|---|---|
| `hermes/portal` | gemergt | `f030645` → `96999f4` |
| `hermes/scripts` | gemergt | `24fa7e8` |
| `hermes/lora` | gemergt | `7bf688b` → `e71cb7d` |

Prüf-Routine bei jedem Merge (bewährt):

```bash
git merge --no-ff hermes/<zweig> -m "merge(hermes/<zweig>): <was>"
npm run test:python:fleet && npx tsc --noEmit && npx vitest run
npm run verify                      # volles Gate VOR dem Push, im Hintergrund starten
git push origin main                # erst bei GATE_EXIT=0
```

## 1. Offene Betreiber-Aufgaben (kein Agent kann das erledigen) – zuerst

1. **`CF_API_TOKEN` im Cloudflare-Dashboard widerrufen und neu erzeugen** (`SEC-P1-005`, PARTIAL).
   Anleitung und Prüfprozedur: `docs/SEC_CF_TOKEN_ROTATION.md`. Wichtig: der alte Worker-Token
   hatte **kein DNS-Recht** (`wire-fleet` scheiterte mit „Cloudflare-Zone nicht gefunden") – beim
   Neuanlegen `Zone → DNS → Edit` vergeben. Danach meldet der Betreiber, ich lasse die
   Prüfprozedur laufen.
2. **Rechts-Entwurf prüfen und veröffentlichen** (`PROD-P0-005`, PARTIAL). Entwurf liegt in
   `docs/RECHT_ENTWURF_DATENSCHUTZ_IMPRESSUM.md`; die Anschrift und die rechtliche Bewertung
   (Rechtsgrundlagen, Drittlandtransfer, Löschfristen, Einordnung der Stimme nach Art. 9) kann
   ich nicht liefern. Die Seiten `/datenschutz` und `/impressum` existieren noch **nicht**.
3. **Entscheidungen offen:** `DB-P3-001` (Tabelle `library_links` hat keinen Codepfad – löschen
   oder Nutzen belegen), `PROD-P2-003` (`README_DE.md` auf den neuen Kopf ziehen),
   `OPS-P2-002`-Rest (Signup-/Zugangs-Kurratierung).

Zur Erinnerung: `SEC-P1-004` ist **erledigt** – vier weltlesbare `.env`-Dateien wurden am
2026-09-23 auf 600 gesetzt; nur die drei `.example`-Templates sind noch lesbar und enthalten
ausschließlich Platzhalter. `PROD-P1-005` (LICENSE) und `PROD-P1-007`/`PROD-P0-006` (drei
extremistische Demo-Tracks entfernt) sind ebenfalls erledigt.

## 2. Vor JEDEM Live-Test: Flotte starten und Vernetzung prüfen

```bash
LOCATION=nbg1 bash scripts/hetzner/bring-up-fleet.sh --yes     # ~6 min, legt 5 Knoten an
python3 scripts/hetzner/firewall-ensure.py --dry-run           # MUSS "geaendert=0" melden
```

Warum das wichtig ist: die Firewalls überleben den Abbau und werden über den Namen
wiederverwendet – genau so wanderten früher die alten Quell-IPs in die neue Flotte
(`INFRA-HETZNER-014`). Der Abgleich läuft beim Flottenstart automatisch, `--dry-run` ist der Beweis.
Die Flotte schaltet sich nach 15 Minuten ohne App-Nutzung selbst ab (gewollt, `PROD-P3-F9`);
`https://anunnakitools.de` antwortet dann weiter mit 200 – das kommt von Cloudflare, nicht von
einer laufenden App.

## 3. Nächste Arbeitspakete (Reihenfolge nach Wirkung)

1. **SFU scharf** (`INFRA-HETZNER-015`, Entscheidung „go"): ACME-Caddyfile in den Flottenstart,
   `ENABLE_SFU=1`, echte Sitzung gegen `wss://sfu.<domain>` prüfen. Ohne Vorteil: rückstandsfrei
   zurückbauen.
2. **Prompts auf Englisch** (`AI-P1-PROMPTS-002`): alle Rollen-Prompts englisch, Deutsch nur in
   Kommentaren/Doku; masterplayer bleibt rein visuell (kein Prompt, keine Eingabe, kein Knopf – als
   Testvertrag verankern); Score-Gate für Bild/Video, Gates 4.00/4.50 getrennt; Latein nur bei
   belegten Wörtern (cantus, lumen, ordo, vox, silentium, imago, motus) – Auswahl dem Betreiber vorlegen.
   Fundort der Texte: `src/core/ai/orchestrator/promptRoles.ts` (`composeRoleSystemPrompt`,
   `MOA_GLOBAL_SYSTEM_PROMPT`) plus `server/routes/aiRoutes.ts` (`/api/ai/generate`, `/api/ai/describe`).
3. **Weitere Themen** (`VISUAL-P1-009`): wartet auf `/home/patrick/am-vis-themen/<thema>/` vom Betreiber.
4. **Deploy am Ende der Skript-Runde** (`PROD-P3-SKRIPTE-01`): aktueller Deploy + Push,
   Recovery-Bündel und Dateien lokal bereithalten, erst nach erfolgreichem Deploy löschen.

## 4. Offene technische Punkte aus dem Audit 2026-09-23

| ID | Was |
|---|---|
| `ARCH-P2-003` | Ignorierliste erledigt (`knip.jsonc` mit Begründung je Eintrag, 4 tote Dateien entfernt). **Rest:** `MasterPlayerTerminal.tsx` ist als tot belegt – Entscheidung „weg oder wieder verdrahten" steht aus. |
| `AUDIO-P3-001` | Drei `ctx.destination`-Zweige entfernt (Hörprobe klang doppelt). **Rest:** `connectLiveWorkletChain()` und `applyMasterOutputRouting()`/`outputGain` sind geparkt und im `init()`-Kommentar als solche benannt. |
| net (neu) | **`npm run check:deadcode` (knip) ist rot** – `exit 1` mit 195 ungenutzten Exporten, 88 ungenutzten Typen, 1 ungenutzten Datei und 1 ungenutzten Abhängigkeit (`axios`). Das Gate läuft **nicht** in `verify`, deshalb ist es niemandem aufgefallen. |

## 5. Was in dieser Runde gemessen wurde (nicht erneut prüfen, nur nutzen)

Alle Gates am 2026-09-23 real ausgeführt:

| Gate | Ergebnis |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx eslint . --max-warnings=0` | exit 0 |
| `npx vitest run` | 280/280 Dateien, **2097/2097 Tests** grün |
| `node scripts/validate-interface-boundaries.mjs` | 451 Dateien, 0 Verstöße |
| `public/plugin-manifest.json` | genau 16 `ui_plugins` |
| `npx knip` | **exit 1** (siehe oben) |

Ebenfalls geprüft und in Ordnung: Plugin-Lifecycle `OFF`/`AUTO_AI`/`PRO`, Monitor-Routing
(`MAIN` wird nie getrennt), `BasePluginAdapter`-Vertrag (OFF-Bypass, Lock-Guard, idempotentes
`dispose()`), RT-Safety der 16 Worklets, keine doppelten Routen, keine Secrets im Repo oder
Client-Bundle.
