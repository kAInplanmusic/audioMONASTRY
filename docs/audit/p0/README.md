# Historische Phase-0-Prüfbelege

Die ursprünglichen Konsolenartefakte wurden unverändert als Dateisnapshots in `EVIDENCE_REGISTRY.json` archiviert. Jeder Eintrag enthält den tatsächlich ausgeführten `git show`-Befehl, dessen Originalausgabe und Archivierungsdatum; die Original-JSON-Ausgabe bewahrt zusätzlich Ausführungszeit, Befehl und Exitcode der damaligen Prüfung. SHA-256 in claim ermöglicht die Rückprüfung der ursprünglichen Dateibytes. Die Quellcommits bleiben in der Git-Historie erhalten.

Diese Dateien sind historische Auditdaten, keine aktiven Deploy- oder Runtime-Konfigurationen. Die Pfadnennungen in den Phase-0-Berichten beziehen sich auf die folgende Archivzuordnung. Aktuelle Integrationsprüfungen werden gesondert dokumentiert.

| Ursprüngliche Datei unter docs/audit/p0/ | Registry-ID |
|---|---|
| `all-tests.log` | `R2-P0-ARCHIVE-ALL-TESTS` |
| `audit-deep-static.log` | `R2-P0-ARCHIVE-AUDIT-DEEP-STATIC` |
| `baseline-checks.log` | `R2-P0-ARCHIVE-BASELINE-CHECKS` |
| `changed-tests-2.log` | `R2-P0-ARCHIVE-CHANGED-TESTS-2` |
| `changed-tests.log` | `R2-P0-ARCHIVE-CHANGED-TESTS` |
| `check-deadfiles.log` | `R2-P0-ARCHIVE-CHECK-DEADFILES` |
| `checkpoint-brain-final.log` | `R2-P0-ARCHIVE-CHECKPOINT-BRAIN-FINAL` |
| `checkpoint-focused-actual.log` | `R2-P0-ARCHIVE-CHECKPOINT-FOCUSED-ACTUAL` |
| `checkpoint-focused.log` | `R2-P0-ARCHIVE-CHECKPOINT-FOCUSED` |
| `checkpoint-verify.log` | `R2-P0-ARCHIVE-CHECKPOINT-VERIFY` |
| `deep-static-direct-node22.log` | `R2-P0-ARCHIVE-DEEP-STATIC-DIRECT-NODE22` |
| `final-lint-verified.log` | `R2-P0-ARCHIVE-FINAL-LINT-VERIFIED` |
| `final-lint.log` | `R2-P0-ARCHIVE-FINAL-LINT` |
| `final-tests.log` | `R2-P0-ARCHIVE-FINAL-TESTS` |
| `final-typecheck.log` | `R2-P0-ARCHIVE-FINAL-TYPECHECK` |
| `final-verify.log` | `R2-P0-ARCHIVE-FINAL-VERIFY` |
| `focused-final.log` | `R2-P0-ARCHIVE-FOCUSED-FINAL` |
| `focused-verified.log` | `R2-P0-ARCHIVE-FOCUSED-VERIFIED` |
| `historical-runtime-helper.log` | `R2-P0-ARCHIVE-HISTORICAL-RUNTIME-HELPER` |
| `history-fixture-recheck.log` | `R2-P0-ARCHIVE-HISTORY-FIXTURE-RECHECK` |
| `lint-current.log` | `R2-P0-ARCHIVE-LINT-CURRENT` |
| `migration-tests-remaining.log` | `R2-P0-ARCHIVE-MIGRATION-TESTS-REMAINING` |
| `native-fleet-tests.log` | `R2-P0-ARCHIVE-NATIVE-FLEET-TESTS` |
| `native-helper-ast-parity-final.log` | `R2-P0-ARCHIVE-NATIVE-HELPER-AST-PARITY-FINAL` |
| `native-helper-ast-parity.log` | `R2-P0-ARCHIVE-NATIVE-HELPER-AST-PARITY` |
| `native-packaging-test.log` | `R2-P0-ARCHIVE-NATIVE-PACKAGING-TEST` |
| `native-python-production.log` | `R2-P0-ARCHIVE-NATIVE-PYTHON-PRODUCTION` |
| `native-python-runtime-final.log` | `R2-P0-ARCHIVE-NATIVE-PYTHON-RUNTIME-FINAL` |
| `native-python-runtime.log` | `R2-P0-ARCHIVE-NATIVE-PYTHON-RUNTIME` |
| `native-tests.log` | `R2-P0-ARCHIVE-NATIVE-TESTS` |
| `rt-gate.log` | `R2-P0-ARCHIVE-RT-GATE` |
| `security-with-proxy.log` | `R2-P0-ARCHIVE-SECURITY-WITH-PROXY` |
| `security.log` | `R2-P0-ARCHIVE-SECURITY` |
| `targeted-lint.log` | `R2-P0-ARCHIVE-TARGETED-LINT` |
| `test-python-after.log` | `R2-P0-ARCHIVE-TEST-PYTHON-AFTER` |
| `test-python-device.log` | `R2-P0-ARCHIVE-TEST-PYTHON-DEVICE` |
| `test-python-fleet.log` | `R2-P0-ARCHIVE-TEST-PYTHON-FLEET` |
| `test-python-lora-aitk.log` | `R2-P0-ARCHIVE-TEST-PYTHON-LORA-AITK` |
| `test-python-lora-segments.log` | `R2-P0-ARCHIVE-TEST-PYTHON-LORA-SEGMENTS` |
| `test-python-lora.log` | `R2-P0-ARCHIVE-TEST-PYTHON-LORA` |
| `test-python-production.log` | `R2-P0-ARCHIVE-TEST-PYTHON-PRODUCTION` |
| `test-python-runtime.log` | `R2-P0-ARCHIVE-TEST-PYTHON-RUNTIME` |
| `test-python-services.log` | `R2-P0-ARCHIVE-TEST-PYTHON-SERVICES` |
| `test-python.log` | `R2-P0-ARCHIVE-TEST-PYTHON` |
| `test-rls.log` | `R2-P0-ARCHIVE-TEST-RLS` |
| `typecheck-after.log` | `R2-P0-ARCHIVE-TYPECHECK-AFTER` |
| `typecheck-before.log` | `R2-P0-ARCHIVE-TYPECHECK-BEFORE` |
| `typecheck-current.log` | `R2-P0-ARCHIVE-TYPECHECK-CURRENT` |
| `verified-typecheck.log` | `R2-P0-ARCHIVE-VERIFIED-TYPECHECK` |
| `verify-summary.log` | `R2-P0-ARCHIVE-VERIFY-SUMMARY` |
| `verify.log` | `R2-P0-ARCHIVE-VERIFY` |
| `typecheck-groups.json` | `R2-P0-ARCHIVE-TYPECHECK-GROUPS` |
| `retired-training-aitk.log` | `R2-P0-ARCHIVE-RETIRED-TRAINING-AITK` |
| `retired-training-media.log` | `R2-P0-ARCHIVE-RETIRED-TRAINING-MEDIA` |
| `retired-training-segments.log` | `R2-P0-ARCHIVE-RETIRED-TRAINING-SEGMENTS` |
| `retired-training-test-inventory.log` | `R2-P0-ARCHIVE-RETIRED-TRAINING-TEST-INVENTORY` |
