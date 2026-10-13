# Fixpaket D — samplemonk-Legacy-Shim-Ausmusterung (Phase 1+2)

Stand: 2026-09-29 · Basis: docs/PROPOSAL_legacy-shim-removal.md · Umsetzung: Worker (Phase 1) + Haupt-Agent (Phase 2 + Abschluss)

## Umgesetzt
- **Phase 1 (Commit `6e8a3d5`):** fleet-names.sh / fleet-status.sh / lifecycle.sh / fleet-deploy-live.sh / auto-repair.sh / delete-fleet.sh einpräfixig umgebaut; `git rm migrate-project-name.sh cleanup-legacy-firewalls.py`; fleetWiring.ts ohne FLEET_LEGACY_NAME_PREFIX; index.js Phase-1-Teil; fleetWiring/py-Tests kanonisch; Wächter-ALLOWED Phase-1-Stand; PROPOSAL aufgenommen.
- **Phase 2 (Commit nach diesem Report):** index.js ohne LEGACY_SNAPSHOT_PREFIXES/ALL_SNAPSHOT_PREFIXES; snapshotRoleOf/findSnapshot einpräfixig; portalWorkerSnapshots-Fixtures kanonisch; py-LEGACY_ALLOWED_FILES = {Dockerfile.manifest}; Wächter-ALLOWED Z.36+41 entfernt, Assert → `not.toMatch(/samplemonk/i)`; HETZNER_DEPLOY-Nachtrag 2026-09-29.
- **Vorbedingung Phase 2 live belegt:** `/v1/images?type=snapshot` → 13 Snapshots, **0** mit Alt-Präfix (10 kanonisch, 3 fremd `pa-test-01`).

## Verifikation
- `bash -n` auf 6 Skripten OK · `node --check index.js` OK · `py_compile` OK
- `NODE_ENV=test vitest run` namingConventions + fleetWiring + portalWorkerSnapshots: **24/24**
- `python3 tests/test_hetzner_scripts.py`: NamespaceParitaet 11/11, FirewallLebenszyklus 4/4
- Wächter-grep-Simulation: `git grep -l -I -i -E 'sample[-_]?monk'` = **exakt 10 Belegdateien** (deckungsgleich PROPOSAL §5.2)

## Abweichungen vom Proposal
- NamespaceParitaetTest prüft Passthrough-Identität statt bare==project (Semantik ohne Zweit-Schreibweise obsolet)
- bring-up-fleet.sh nicht angefasst (nicht im Datei-Scope; LEGACY-Fallback dort war env-optional)

## Bekanntes Umgebungs-Thema (nicht Paket D)
- `IdleShutdownTimerTest.test_units_bestehen_systemd_analyze_verify` (2 subTests) schlägt auf diesem NTFS-Mount wegen systemd-analyze Exec-Bit-Monierung an — per Stash-Roundtrip am unveränderten HEAD reproduziert. Umgebung, nicht Regression.

## Offen
- Nichts. Revert-Strategie: `git revert` je Phase (NTFS — keine stash-Operationen).
