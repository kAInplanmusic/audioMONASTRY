"""Regressionstest: Voreinstellungen des Deploy-Skripts (scripts/runpod-deploy.py).

Hintergrund: `videoAbstract` wurde aus genau diesem Skript heraus mit dem
**generischen** `COMFYUI`-Image angelegt - das bringt keine Gewichte mit und laedt
auch keine nach, also scheiterte jeder Job (live geprueft am 2026-09-16: der
Worker meldete leere Modell-Listen). Ein Skript, das die kaputte Konfiguration bei
jedem Redeploy wiederherstellt, ist gefaehrlicher als eine falsche Doku. Dieser
Test haelt die Voreinstellungen deshalb auf dem live verifizierten Stand.

Lauf: python3 tests/test_runpod_deploy_defaults.py
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import types
import unittest
from typing import Any
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "runpod-deploy.py"

#: Rollen, deren Idle-Timeout am 2026-09-16 auf 120 s gesetzt wurde, weil Worker
#: ueber den 900-s-Wert hinaus auf RUNNING blieben und weiter abgerechnet wurden.
GEMESSENE_ROLLEN = ("music", "imageHq", "videoReal", "videoAbstract", "orchestrator")


def load_deploy() -> Any:
    """Skript laden, ohne das RunPod-SDK zu installieren.

    Das Skript importiert `runpod` auf Modulebene; geprueft werden hier nur die
    Konstanten (ROLE_DEFAULTS, PREBUILT_IMAGES), also genuegt ein Platzhalter.
    So laeuft der Test ohne Netz, GPU und SDK.
    """
    sys.modules.setdefault("runpod", mock.MagicMock(spec=types.ModuleType("runpod")))
    spec = importlib.util.spec_from_file_location("runpod_deploy", SCRIPT)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"Skript nicht ladbar: {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


deploy = load_deploy()


class RoleDefaultsTest(unittest.TestCase):
    def test_video_abstract_nutzt_den_wan_worker_mit_gewichten(self) -> None:
        # Der eigentliche Regressionsschutz: nicht das gewichtslose Generik-Image.
        self.assertEqual(deploy.ROLE_DEFAULTS["videoAbstract"]["imageDefault"], "WAN22")
        self.assertEqual(deploy.ROLE_DEFAULTS["videoReal"]["imageDefault"], "WAN22")
        self.assertIn("generate-video-ksampler", deploy.PREBUILT_IMAGES["WAN22"])

    def test_imagehq_nutzt_das_live_image_und_nicht_den_generik_worker(self) -> None:
        self.assertEqual(deploy.ROLE_DEFAULTS["imageHq"]["imageDefault"], "FLUX_DEV")
        self.assertIn("prunaai-runpod-worker-flux-1-dev", deploy.PREBUILT_IMAGES["FLUX_DEV"])

    def test_keine_rolle_der_flotte_laeuft_auf_dem_gewichtslosen_worker(self) -> None:
        for role, defaults in deploy.ROLE_DEFAULTS.items():
            with self.subTest(role=role):
                if defaults.get("imageKind") == "prebuilt":
                    self.assertNotEqual(
                        defaults.get("imageDefault"),
                        "COMFYUI",
                        f"{role}: COMFYUI bringt keine Gewichte mit – es laedt auch keine nach",
                    )

    def test_idle_timeout_der_gemessenen_rollen_ist_120(self) -> None:
        for role in GEMESSENE_ROLLEN:
            with self.subTest(role=role):
                self.assertEqual(deploy.ROLE_DEFAULTS[role]["idleTimeout"], 120)

    def test_videorollen_laufen_auf_dem_ada_pool(self) -> None:
        # Die Wan-Images sind auf CUDA 12.8/Ada ausgelegt.
        self.assertEqual(deploy.ROLE_DEFAULTS["videoReal"]["gpuPoolId"], "ADA_24")
        self.assertEqual(deploy.ROLE_DEFAULTS["videoAbstract"]["gpuPoolId"], "ADA_24")

    def test_brain_und_ears_bleiben_kurz_und_auf_ampere(self) -> None:
        self.assertEqual(deploy.ROLE_DEFAULTS["brain"]["idleTimeout"], 15)
        self.assertEqual(deploy.ROLE_DEFAULTS["ears"]["idleTimeout"], 15)
        self.assertEqual(deploy.ROLE_DEFAULTS["brain"]["gpuPoolId"], "AMPERE_48")


class DeployGegeManifestTest(unittest.TestCase):
    """INFRA-RUNPOD-002/005: Deploy-Defaults, Manifest und Live-Werte sind EINE Wahrheit.

    Vorher kodierten zwei gruene Tests zwei widersprechende Pool-Wahrheiten
    (ADA_24 im Deploy-Skript vs. AMPERE_48 im Manifest), und sechs Rollen
    deklarierten 900 s idleTimeout gegen live 120 s. Dieser Test vergleicht die
    beiden Seiten direkt - eine Abweichung ist ab jetzt ein roter Test.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(
            (ROOT / "services" / "audiomonastry-ai-runtime" / "model_manifest.json").read_text(encoding="utf-8")
        )

    def test_gpu_pool_stimmt_mit_dem_manifest_ueberein(self) -> None:
        roles = self.manifest["roles"]
        for role, defaults in deploy.ROLE_DEFAULTS.items():
            with self.subTest(role=role):
                self.assertIn(role, roles, f"{role} fehlt im Manifest")
                self.assertEqual(
                    defaults["gpuPoolId"],
                    roles[role]["gpuPoolId"],
                    f"{role}: Deploy-Skript und Manifest nennen verschiedene GPU-Pools",
                )
                self.assertEqual(defaults["gpuCount"], roles[role]["gpuCount"])

    def test_idle_timeout_stimmt_mit_dem_manifest_ueberein(self) -> None:
        roles = self.manifest["roles"]
        for role, defaults in deploy.ROLE_DEFAULTS.items():
            with self.subTest(role=role):
                self.assertEqual(
                    defaults["idleTimeout"],
                    roles[role].get("idleTimeoutSeconds"),
                    f"{role}: idleTimeout im Deploy-Skript weicht vom Manifest ab",
                )

    def test_manifest_vram_budget_passt_zum_pool(self) -> None:
        # 24-GB-Pool mit 48-GB-Budget (oder umgekehrt) waere eine Planung gegen
        # die falsche Hardware - genau der Befund aus dem Audit.
        expected = {"ADA_24": 24, "AMPERE_48": 48}
        for role, spec in self.manifest["roles"].items():
            with self.subTest(role=role):
                self.assertEqual(spec["vramBudgetGb"], expected[spec["gpuPoolId"]])


class EndpointBudgetTest(unittest.TestCase):
    """INFRA-RUNPOD-001: die Flotte bricht ab, bevor sie die Obergrenze reisst."""

    def test_acht_vorhandene_endpoints_blockieren_den_neunten(self) -> None:
        existing = [f"audiomonastry-ai-x{i}" for i in range(8)]
        ok, new_names, message = deploy.plan_endpoint_budget(existing, existing + ["audiomonastry-ai-neu"], limit=8)
        self.assertFalse(ok)
        self.assertEqual(new_names, ["audiomonastry-ai-neu"])
        self.assertIn("Grenze 8", message)

    def test_redeploy_vorhandener_rollen_bleibt_erlaubt(self) -> None:
        existing = [f"audiomonastry-ai-{r}" for r in deploy.ROLE_DEFAULTS]
        planned = [f"audiomonastry-ai-{r}" for r in deploy.ROLE_DEFAULTS]
        ok, new_names, _ = deploy.plan_endpoint_budget(existing, planned, limit=8)
        self.assertTrue(ok)
        self.assertEqual(new_names, [])

    def test_konto_ueber_der_grenze_wird_gemeldet(self) -> None:
        existing = [f"fremd-{i}" for i in range(9)]
        ok, _new, message = deploy.plan_endpoint_budget(existing, ["audiomonastry-ai-brain"], limit=8)
        self.assertFalse(ok)
        self.assertIn("hoechstens 8", message)

    def test_default_grenze_ist_acht(self) -> None:
        self.assertEqual(deploy.ENDPOINT_LIMIT_DEFAULT, 8)

    def test_verwaiste_flotten_endpoints_werden_erkannt(self) -> None:
        existing = ["audiomonastry-ai-brain", "audiomonastry-ai-vision", "fremd-endpoint"]
        orphans = deploy.orphan_endpoint_names(existing, ["audiomonastry-ai-brain"])
        self.assertEqual(orphans, ["audiomonastry-ai-vision"])


class BrainModellIdentitaetTest(unittest.TestCase):
    """INFRA-RUNPOD-003: der Deploy-Brain nennt dasselbe Modell wie das Manifest."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(
            (ROOT / "services" / "audiomonastry-ai-runtime" / "model_manifest.json").read_text(encoding="utf-8")
        )

    def test_brain_realisiert_das_manifest_modell(self) -> None:
        repository = deploy.BRAIN_VLLM_MODEL_DEFAULT
        entries = [m for m in self.manifest["models"] if m.get("repository") == repository]
        self.assertTrue(entries, f"{repository} fehlt im Manifest")
        model_id = entries[0]["id"]
        self.assertIn(model_id, self.manifest["roles"]["brain"]["models"])
        self.assertIn(model_id, self.manifest["roles"]["brain"]["preloadModels"])

    def test_revision_des_brain_deployments_ist_die_des_manifests(self) -> None:
        repository = deploy.BRAIN_VLLM_MODEL_DEFAULT
        entry = next(m for m in self.manifest["models"] if m.get("repository") == repository)
        self.assertEqual(entry["revision"], deploy.BRAIN_VLLM_REVISION_DEFAULT)


class TemplateFallbackTest(unittest.TestCase):
    """INFRA-RUNPOD-009: Template-Handling darf den Rollout nicht halbieren.

    Live-Befund 2026-09-20: `myself.podTemplates` listet nicht jedes Template des
    Kontos (der music-Endpoint haengt an `9q9c60p6xh`, das in der Liste fehlt).
    Die Vorfassung wollte es neu anlegen, RunPod antwortete 'Template name must be
    unique', und der Lauf brach ab - nachdem voiceGen und ears schon auf das neue
    Image gezogen waren. Diese Tests halten den Fix fest.
    """

    def setUp(self) -> None:
        self.calls: list[str] = []

    def _install_fake(self, responses: list[Any], raise_on_create: Exception | None = None) -> None:
        # Das Platzhalter-`runpod` ist ein spec-Mock und legt keine Attribute an -
        # die Untermodule deshalb explizit in sys.modules einhaengen. Genau so
        # loest `save_template` den Import auf (from runpod.api.graphql import
        # run_graphql_query), also trifft der Fake den echten Aufrufpfad.
        api_module = types.ModuleType("runpod.api")
        graphql_module = types.ModuleType("runpod.api.graphql")

        def fake(query: str) -> Any:
            self.calls.append(query)
            is_create = 'id: "' not in query
            if is_create and raise_on_create is not None:
                raise raise_on_create
            return responses.pop(0)

        graphql_module.run_graphql_query = fake  # type: ignore[attr-defined]
        api_module.graphql = graphql_module  # type: ignore[attr-defined]
        sys.modules["runpod.api"] = api_module
        sys.modules["runpod.api.graphql"] = graphql_module
        import runpod  # type: ignore

        runpod.api = api_module  # type: ignore[attr-defined]

    def test_fallback_id_wird_aktualisiert_statt_neu_angelegt(self) -> None:
        responses = [
            {"data": {"myself": {"podTemplates": []}}},
            {"data": {"saveTemplate": {"id": "9q9c60p6xh"}}},
        ]
        self._install_fake(responses)
        result = deploy.save_template(
            "audiomonastry-ai-music-template", "img:tag", {}, 150, fallback_template_id="9q9c60p6xh"
        )
        self.assertEqual(result.get("id"), "9q9c60p6xh")
        self.assertEqual(len(self.calls), 2, "es darf KEIN Create-Aufruf entstehen")
        self.assertIn('id: "9q9c60p6xh"', self.calls[1], "der zweite Aufruf muss das Update sein")

    def test_gefundene_id_gewinnt_gegen_den_fallback(self) -> None:
        responses = [
            {"data": {"myself": {"podTemplates": [{"id": "gefunden", "name": "audiomonastry-ai-music-template"}]}}},
            {"data": {"saveTemplate": {"id": "gefunden"}}},
        ]
        self._install_fake(responses)
        result = deploy.save_template(
            "audiomonastry-ai-music-template", "img:tag", {}, 150, fallback_template_id="anders"
        )
        self.assertEqual(result.get("id"), "gefunden")
        self.assertIn('id: "gefunden"', self.calls[1])

    def test_unique_fehler_ueberspringt_die_rolle_statt_zu_crashen(self) -> None:
        responses = [{"data": {"myself": {"podTemplates": []}}}]
        self._install_fake(responses, raise_on_create=Exception("Template name must be unique."))
        result = deploy.save_template("audiomonastry-ai-music-template", "img:tag", {}, 150)
        self.assertEqual(result, {}, "kein Traceback, sondern ein leeres Ergebnis fuer den Aufrufer")

    def test_andere_fehler_werden_nicht_verschluckt(self) -> None:
        responses = [{"data": {"myself": {"podTemplates": []}}}]
        self._install_fake(responses, raise_on_create=Exception("boom"))
        with self.assertRaises(Exception):
            deploy.save_template("audiomonastry-ai-music-template", "img:tag", {}, 150)


class RolleFehlschlagTest(unittest.TestCase):
    """INFRA-RUNPOD-009: eine fehlgeschlagene Rolle beendet nicht mehr den Lauf."""

    def test_alle_rollen_laufen_durch_und_der_exitcode_bleibt_5(self) -> None:
        seen: list[str] = []

        def fake_deploy_role(role: str, defaults: Any) -> str | None:
            seen.append(role)
            return None if role == "music" else f"ep-{role}"

        with mock.patch.dict("os.environ", {"RP_API_KEY": "test", "IMAGE": "img:tag"}, clear=False):
            with mock.patch.object(deploy, "resolve_roles", return_value=["music", "ears", "voiceGen"]):
                with mock.patch.object(deploy, "deploy_role", side_effect=fake_deploy_role):
                    # create=True: das Platzhalter-SDK ist ein spec-Mock und hat das
                    # Attribut nicht - es soll hier nur die Live-Abfrage ersetzen.
                    with mock.patch.object(deploy.runpod, "get_endpoints", create=True, return_value=[]):
                        code = deploy.main()

        self.assertEqual(code, 5, "Teilausfall muss sichtbar bleiben")
        self.assertEqual(seen, ["music", "ears", "voiceGen"], "kein Abbruch nach der ersten fehlerhaften Rolle")

    def test_exception_einer_rolle_beendet_den_lauf_nicht(self) -> None:
        # Live passiert (35398610401): `update_endpoint_template` warf
        # "This endpoint has a bound template." und der Lauf starb an einer
        # ungefangenen Exception - nachdem andere Rollen schon deployt waren.
        seen: list[str] = []

        def fake_deploy_role(role: str, defaults: Any) -> str | None:
            seen.append(role)
            if role == "music":
                raise RuntimeError("This endpoint has a bound template.")
            return f"ep-{role}"

        with mock.patch.dict("os.environ", {"RP_API_KEY": "test", "IMAGE": "img:tag"}, clear=False):
            with mock.patch.object(deploy, "resolve_roles", return_value=["music", "ears"]):
                with mock.patch.object(deploy, "deploy_role", side_effect=fake_deploy_role):
                    with mock.patch.object(deploy.runpod, "get_endpoints", create=True, return_value=[]):
                        code = deploy.main()

        self.assertEqual(seen, ["music", "ears"])
        self.assertEqual(code, 5, "echte Exception = Fehler, nicht Ueberspringen")

    def test_gebundenes_template_ist_ueberspringen_statt_fehler(self) -> None:
        # Ein gebundenes Template ist kein Deploy-Fehler, sondern ein
        # Betreiber-Schritt - sonst waere CI dauerhaft rot und der echte Fehler
        # unsichtbar.
        def fake_deploy_role(role: str, defaults: Any) -> str | None:
            if role == "music":
                raise deploy.BoundTemplateError("audiomonastry-ai-music")
            return f"ep-{role}"

        with mock.patch.dict("os.environ", {"RP_API_KEY": "test", "IMAGE": "img:tag"}, clear=False):
            with mock.patch.object(deploy, "resolve_roles", return_value=["music", "ears"]):
                with mock.patch.object(deploy, "deploy_role", side_effect=fake_deploy_role):
                    with mock.patch.object(deploy.runpod, "get_endpoints", create=True, return_value=[]):
                        code = deploy.main()

        self.assertEqual(code, 0, "gebundenes Template darf den Lauf nicht rot machen")


if __name__ == "__main__":
    unittest.main()
