# Flotten-Pipeline: Belege gegen die Herstellerdokumentation

Stand 2026-11-18. Rohtexte der abgerufenen Seiten liegen nicht im Repository; `docs/evidence/SOURCES.json` hält URL, Abrufzeit und
SHA-256 je Seite. Die Aussagen unten sind kurze Zitate bzw. Paraphrasen. Jede Zeile nennt den Test, der sie am Code absichert
(`tests/test_fleet_doc_contracts.py`, außer wo anders angegeben). Urteil: **ok** = Code stimmt mit der Doku überein, **korrigiert** = Abweichung
gefunden und behoben, **offen** = Doku sagt nichts bzw. nicht belegbar, **Messung nötig**.

## Vast.ai (docs.vast.ai)
| # | Aussage der Doku | Quelle | Unser Code | Urteil / Test |
| --- | --- | --- | --- | --- |
| V1 | Instanz = `PUT /api/v0/asks/{id}`; Antwort liefert `new_contract` als Instanz-ID | api-reference/instances/create-instance | `vast-pods.py` `run()` | ok (`test_the_new_instance_id_comes_from_new_contract`) |
| V2 | Erlaubte Felder u. a. `image, label, disk, runtype, target_state, env, cancel_unavail, onstart, args, args_str, image_login` | create-instance | `create_body()` | ok (`test_only_documented_fields_with_documented_values`) |
| V3 | `runtype` ∈ ssh/jupyter/args/ssh_proxy/ssh_direct/jupyter_proxy/jupyter_direct; `args` behält den Image-Entrypoint, kein SSH | create-instance, creating-instances-with-api | `runtype: 'args'` | ok (`test_args_runtype_keeps_the_image_entrypoint_and_needs_no_onstart`) |
| V4 | `env` ist ein Objekt; Ports als `-p`-Schlüssel mit Wert `"1"`; max. 64 offene Ports | creating-instances-with-api, connect/networking | `'-p 8000:8000': '1'` | ok (`test_env_is_an_object_with_dash_p_port_keys_valued_one`). Die Referenzseite nennt `env` einen String, der Leitfaden ein Objekt; wir folgen dem Leitfaden (so liefen alle bisherigen Instanzen). |
| V5 | `image_login`: `-u username -p access_token docker.io` | create-instance, creating-instances-with-api | `-u USER -p TOKEN ghcr.io` | ok (`test_image_login_uses_the_documented_format`) |
| V6 | `onstart` ist auf **4048 Zeichen** begrenzt (länger: gzip+base64) | create-instance (Key Quirks) | wir nutzen `args`, kein `onstart` in der Flotte; Selbsttests nutzten ≤1,2 KB | **korrigiert**: frühere Annahme „16384" war falsch; Test erzwingt ≤4048 |
| V7 | `cancel_unavail`: abbrechen, wenn die Instanz nicht sofort startet (Standard true bei On-Demand) | create-instance | `True` | ok |
| V8 | Statuswerte `exited`, `unknown`, `offline` erreichen nie `running` („Poll trap") → zerstören und neu versuchen | create-instance (Key Quirks) | `fail_on_terminal_instance()` | ok (`test_statuses_that_never_reach_running_are_terminal`) |
| V9 | `loading` = Docker-Image wird geladen; `scheduling` = wartet auf GPU | guides/instances/manage-instances | `wait_ready()` wertet nur Endstatus aus | ok; **Messung nötig** (Dauer von `loading`, siehe Beobachter) |
| V10 | Gestoppte Instanzen kosten weiter Speicher; zerstören beendet alle Kosten | manage-instances | `down` zerstört, `stop` hält Snapshot | ok |
| V11 | Offene Ports werden auf zufällige externe Ports abgebildet (`PUBLIC_IP:PORT -> 8000/tcp`) | connect/networking | liest `ports['8000/tcp'][0].HostPort` | ok |
| V12 | Suchfilter laut OpenAPI (u. a. `gpu_ram` in **MB**, `type` ∈ ondemand/bid/reserved) | api-reference/search/search-offers, create-instance (Quirks) | `planner.query()` | ok (`test_every_query_key_is_a_documented_filter`, `test_gpu_ram_is_sent_in_megabytes`) |
| V13 | HTTP 429, keine `Retry-After`-Header; Client soll selbst zurückhalten, Abfragen bündeln, weniger pollen | api-reference/rate-limits-and-errors | `api()`: ≥1,1 s Abstand, bei Mietanfrage ≥5 s, kein bezahlter Wiederholungsversuch | ok (`test_a_rate_limited_create_never_buys_twice`) |
| V14 | Container-Logs: `PUT /api/v0/instances/request_logs/{id}` → `result_url` (S3) | api-reference/instances/show-logs | neu: `scripts/vast-observe.py` | **neu**, getestet (`tests/test_vast_observe.py`) |
| V15 | Der Suchzeilen-Tageswert (20.000) steht **nicht** in der Doku; er stammt aus der API-Fehlermeldung | – | `VAST_PLAN_OFFER_LIMIT` (max. 1000) | offen (belegt nur durch Fehlermeldung); Limit gedeckelt (`test_offer_limit_is_bounded...`) |
| V16 | Die „32 KB" Grenze für `env` in `compact_environment()` steht nicht in der Doku | – | konservative 28 KB | **offen**, bewusst vorsichtig belassen |

## GitHub (docs.github.com)
| # | Aussage der Doku | Quelle | Unser Code | Urteil / Test |
| --- | --- | --- | --- | --- |
| G1 | Die Container-Registry unterstützt **nur Personal Access Tokens (classic)**; Pull braucht mindestens `read:packages` | packages/…/working-with-the-container-registry | `GHCR_PASSWORD`, `ghcr_token_problem()` | **korrigiert**: `up` weist fine-grained Token (`github_pat_…`) ab (`test_only_classic_personal_access_tokens_are_accepted`) |
| G2 | Ein veröffentlichtes Paket ist standardmäßig privat; ohne Verknüpfung mit dem Repository hat `GITHUB_TOKEN` keinen Schreibzugriff | …container-registry, about-permissions-for-github-packages | CI-Push-403 vom 2026-11-17 | erklärt: Paket war nicht verknüpft; „Manage Actions access → Add Repository" (Write) behob es |
| G3 | Öffentliche Pakete lassen sich ohne Anmeldung ziehen | about-permissions-for-github-packages | Images sind privat | ok, bewusst privat |
| G4 | `docker login ghcr.io -u USER --password-stdin` | …container-registry | Vast erhält `image_login` | ok |

## Cloudflare R2 (developers.cloudflare.com/r2)
| # | Aussage der Doku | Quelle | Unser Code | Urteil / Test |
| --- | --- | --- | --- | --- |
| R1 | Vorsignierte Links: Methode GET/PUT/HEAD/DELETE, Gültigkeit **1 s bis 7 Tage (604.800 s)** | api/s3/presigned-urls | `s3lite.presign()` | **korrigiert**: Python prüfte das nicht (TypeScript-Server schon, `server/s3Presign.ts`); jetzt `ValueError` (`test_expiry_is_limited_to_the_documented_range`) |
| R2 | Signatur gilt je Methode; ein GET-Link taugt nicht für HEAD | api/s3/presigned-urls | Pods proben per `Range`-GET | ok (`test_methods_are_limited_and_signed_per_method`, `test_pods_probe_and_download_with_range_get_not_head`) |
| R3 | `GetObject` unterstützt Range | api/s3/api | `pod_start.download_ranged` (8 Streams) | ok |
| R4 | Einzel-PUT ≤ 5 GiB, mehrteilig bis 4,995 TiB; 1 Schreibvorgang/s je Schlüssel | platform/limits | `s3lite` Mehrteil-Upload (`tests/test_r2_upload_bounds.py`) | ok |
| R5 | Gewichts-Links gelten 21.600 s (6 h) | – | `pod-fleet.json` `urlTtlSeconds` | ok (`test_weight_url_ttl_in_the_fleet_config_is_within_range`) |

## Nicht durch Dokumentation belegbar: Kaltstart-Dauer
Der Abbruch am 2026-11-18 („priority executor" nicht bereit nach 8 Minuten) lässt sich aus der Doku nicht erklären. Bekannte Größen für `audio-brain`:
13,5 GB (Image 4,15 GB + Gewichte), gemeldete Bandbreite des Hosts 898 Mbit/s, ideal ≈ 2 Minuten (`vast_transfer_budget.transfer_minutes`), Frist 8 Minuten
(`EXECUTOR_STARTUP_MINUTES`). Reale Durchsätze (GHCR-Pull, R2-Gewichte) sind nicht bekannt. Deshalb zeichnet `scripts/vast-observe.py` beim nächsten Lauf
Statuswechsel mit Zeitstempel und Pod-Logs auf; die Frist wird erst nach diesen Messwerten angepasst.

## Kaltstart-Ziel (Betreiber 2026-11-18)
Ziel: alle Rollen in **15 Minuten** bereit (`coldStartTargetMinutes`). Dauert eine **einzelne** Rolle länger, darf sie bis zu **15 weitere Minuten** laufen
(`coldStartGraceMinutes`, Höchstgrenze 30 min, gedeckelt durch `maxTestMinutes − 2`), bevor die Flotte abgeschaltet wird. Sind am Ziel **zwei oder mehr**
Rollen noch nicht bereit, bricht der Lauf am Ziel ab. Jede Rolle über dem Ziel erzeugt einen **Hinweis** (gemessene Zeit, Payload, gemeldete Bandbreite,
Optimierungsoptionen): ausgegeben im Lauf und gespeichert in `<state-dir>/cold-start-report.json` (`scripts/cold_start_report.py`, `wait_ready()` in
`scripts/vast-pods.py`). Der Bericht wird auch bei Abbruch geschrieben. Test: `tests/test_cold_start_report.py` (reine Regeln + echte `wait_ready()` mit
simulierter Uhr). Offen: wo der Hinweis zusätzlich erscheinen soll („Basis" laut Betreiber, derzeit Bericht + Lauf-Ausgabe).
