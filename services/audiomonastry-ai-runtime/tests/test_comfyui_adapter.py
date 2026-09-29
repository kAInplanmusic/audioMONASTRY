"""Regressionstest: ComfyUI-Adapter (Instanz 5/6/7 + music) ohne GPU.

Reiner Python-Smoke (nur stdlib + `comfyui_adapter`):

    python3 services/audiomonastry-ai-runtime/tests/test_comfyui_adapter.py

Geprueft wird die Uebersetzung in beide Richtungen gegen die DOKUMENTIERTEN
Vertraege der vorgefertigten Worker (Wan2.2 prompt-basiert, ACE-Step und
worker-comfyui workflow-basiert) sowie die Formtoleranz fuer die nicht mehr
oeffentlich dokumentierten Worker (imageHq/videoReal).
"""
from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import comfyui_adapter as adapter  # noqa: E402

VIDEO_URI = "data:video/mp4;base64,AAAA"
IMAGE_URI = "data:image/png;base64,BBBB"


class PromptRequestTest(unittest.TestCase):
    def test_wan22_ti2v_shape(self) -> None:
        request = adapter.build_prompt_request(
            {
                "prompt": "neon alley",
                "negative_prompt": "blurry",
                "image_url": "https://example.com/a.png",
                "width": 480,
                "height": 832,
                "length": 81,
                "steps": 10,
                "cfg": 2.0,
                "seed": 42,
            },
            "wan22-ti2v-5b",
        )
        self.assertEqual(request["prompt"], "neon alley")
        self.assertEqual(request["negative_prompt"], "blurry")
        self.assertEqual((request["width"], request["height"]), (480, 832))
        self.assertEqual(request["seed"], 42)

    def test_text_alias_and_camel_negative(self) -> None:
        request = adapter.build_prompt_request({"text": "a tree", "negativePrompt": "ugly"}, "flux")
        self.assertEqual(request["prompt"], "a tree")
        self.assertEqual(request["negative_prompt"], "ugly")

    def test_empty_request_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            adapter.build_prompt_request({}, "flux")

    def test_none_values_are_dropped(self) -> None:
        request = adapter.build_prompt_request({"prompt": "x", "seed": None, "cfg": None}, "flux")
        self.assertNotIn("seed", request)
        self.assertNotIn("cfg", request)


class PromptRoleRoutingTest(unittest.TestCase):
    def test_image_role_is_prompt_based(self) -> None:
        request = adapter.build_request("image.generate", "imageHq", "flux1-dev-juiced", {"prompt": "a cat"})
        self.assertEqual(request, {"prompt": "a cat"})

    def test_video_role_is_prompt_based(self) -> None:
        request = adapter.build_request("video_real.text2video", "videoReal", "wan22", {"prompt": "drone shot"})
        self.assertEqual(request["prompt"], "drone shot")

    def test_videoAbstract_laeuft_jetzt_ueber_den_prompt_worker(self) -> None:
        # Bis 2026-09-16 war die Rolle workflow-basiert; das deployte
        # worker-comfyui hatte aber keine Gewichte. Jetzt derselbe Wan-Worker
        # wie videoReal, also prompt-basiert - ohne Workflow-Zwang.
        request = adapter.build_request(
            "video_abstract.text2video", "videoAbstract", "wan22-ti2v-5b", {"prompt": "flowing colors"}
        )
        self.assertEqual(request["prompt"], "flowing colors")
        self.assertNotIn("workflow", request)
        self.assertEqual(adapter.COMFY_ROLES["videoAbstract"]["protocol"], "prompt")

    def test_unknown_role_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            adapter.build_request("x", "ears", "whisper", {"prompt": "y"})


class WorkflowRequestTest(unittest.TestCase):
    def test_rolle_ohne_workflow_wird_mit_klarer_meldung_abgelehnt(self) -> None:
        # Ohne `COMFY_WORKFLOW_<ROLLE>` und ohne workflows/<rolle>.json muss der
        # Adapter sagen, WAS fehlt – nicht still einen leeren Graphen schicken.
        # (Direkt gegen build_workflow_request, weil derzeit nur `music` das
        # Workflow-Protokoll nutzt und einen Graphen mitbringt.)
        with tempfile.TemporaryDirectory() as tmp:
            original = adapter.WORKFLOW_DIR
            adapter.WORKFLOW_DIR = pathlib.Path(tmp)
            try:
                with self.assertRaises(ValueError) as ctx:
                    adapter.build_workflow_request("someRole", {"prompt": "x"}, None, {})
            finally:
                adapter.WORKFLOW_DIR = original
        self.assertIn("COMFY_WORKFLOW_SOMEROLE", str(ctx.exception))

    def test_music_workflow_kommt_aus_der_mitgelieferten_datei(self) -> None:
        # music hat seit 2026-09-16 einen geprueften Graphen im Repo.
        request = adapter.build_request("music.generate", "music", "acestep-v15-xl-base", {"prompt": "techno"})
        classes = {node["class_type"] for node in request["workflow"].values()}
        self.assertIn("TextEncodeAceStepAudio1.5", classes)
        # Und der Prompt sitzt im Graphen, nicht nur im Request.
        text = next(n for n in request["workflow"].values() if n["class_type"] == "TextEncodeAceStepAudio1.5")
        self.assertEqual(text["inputs"]["tags"], "techno")

    def test_inline_workflow_wins(self) -> None:
        workflow = {"3": {"class_type": "KSampler", "inputs": {}}}
        request = adapter.build_request("music.generate", "music", "acestep", {"workflow": workflow})
        self.assertEqual(request, {"workflow": workflow})

    def test_verdrahteter_seed_wird_nicht_ueberschrieben(self) -> None:
        # Zeigt der Seed auf einen anderen Knoten, darf der Adapter ihn nicht
        # durch eine Zahl ersetzen – sonst zerreisst er die Verdrahtung.
        workflow = {
            "3": {"class_type": "KSampler", "inputs": {"seed": ["9", 0]}},
            "9": {"class_type": "PrimitiveInt", "inputs": {}},
        }
        request = adapter.build_request("music.generate", "music", "acestep", {"workflow": workflow, "seed": 5})
        self.assertEqual(request["workflow"]["3"]["inputs"]["seed"], ["9", 0])

    def test_workflow_from_env_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "wf.json"
            path.write_text('{"1": {"class_type": "EmptyLatentImage", "inputs": {}}}', encoding="utf-8")
            request = adapter.build_workflow_request(
                "someRole", {"prompt": "x"}, None, {"COMFY_WORKFLOW_SOMEROLE": str(path)}
            )
            self.assertIn("workflow", request)
            self.assertEqual(request["workflow"]["1"]["class_type"], "EmptyLatentImage")

    def test_images_are_passed_through_and_validated(self) -> None:
        workflow = {"1": {"class_type": "LoadImage", "inputs": {}}}
        request = adapter.build_request(
            "image.img2img",
            "imageHq",
            "flux",
            {"workflow": workflow, "images": [{"name": "a.png", "image": IMAGE_URI}, {"name": "broken"}]},
        )
        self.assertEqual(request["images"], [{"name": "a.png", "image": IMAGE_URI}])


class ImageLoraRequestTest(unittest.TestCase):
    """Rolle `imageLora`: zwei Basismodelle, LoRA-Kette, echter Prompt im Graphen.

    Der Kern dieser Rolle ist, dass die LoRA **wirkt**. Eine LoRA, die im Request
    steht, aber nicht im Graphen landet, erzeugt Bilder, die sich nicht
    unterscheiden – und genau das kann man ohne diesen Test nicht von einer
    wirkungslosen LoRA unterscheiden.
    """

    def _request(self, **args):
        payload = {"prompt": "mstyle_taenzer, a dancer", "seed": 4711}
        payload.update(args)
        return adapter.build_request("image.lora", "imageLora", "image-lora-stack", payload)

    def test_sdxl_ist_die_vorgabe_und_prompt_landet_im_graphen(self) -> None:
        workflow = self._request()["workflow"]
        self.assertEqual(workflow["1"]["inputs"]["ckpt_name"], "sd_xl_base_1.0.safetensors")
        self.assertEqual(workflow["2"]["inputs"]["text"], "mstyle_taenzer, a dancer")
        self.assertEqual(workflow["5"]["inputs"]["seed"], 4711)

    def test_base_flux1_waehlt_den_anderen_graphen(self) -> None:
        workflow = self._request(base="flux1")["workflow"]
        self.assertEqual(workflow["1"]["inputs"]["ckpt_name"], "flux1-dev-fp8.safetensors")
        # FLUX.1-dev laeuft mit cfg 1 – der Negative-Knoten ist wirkungslos,
        # muss aber verdrahtet bleiben (ComfyUI verlangt den Eingang).
        self.assertEqual(workflow["5"]["inputs"]["cfg"], 1.0)
        self.assertEqual(workflow["3"]["inputs"]["text"], "")

    def test_negative_und_samplerwerte_werden_gesetzt(self) -> None:
        workflow = self._request(negative_prompt="blurry", steps=12, cfg=4.5, width=768, height=1344)["workflow"]
        self.assertEqual(workflow["3"]["inputs"]["text"], "blurry")
        self.assertEqual(workflow["5"]["inputs"]["steps"], 12)
        self.assertEqual(workflow["5"]["inputs"]["cfg"], 4.5)
        self.assertEqual(workflow["4"]["inputs"]["width"], 768)
        self.assertEqual(workflow["4"]["inputs"]["height"], 1344)

    def test_verdrahteter_seed_bleibt_verdrahtet(self) -> None:
        workflow = {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "x.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "alt", "clip": ["1", 1]}},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
            "5": {
                "class_type": "KSampler",
                "inputs": {"seed": ["9", 0], "positive": ["2", 0], "negative": ["3", 0]},
            },
            "9": {"class_type": "PrimitiveInt", "inputs": {}},
        }
        request = adapter.build_request(
            "image.lora", "imageLora", "m", {"workflow": workflow, "prompt": "x", "seed": 5}
        )
        self.assertEqual(request["workflow"]["5"]["inputs"]["seed"], ["9", 0])

    def test_prompt_durch_durchleitknoten_hindurch(self) -> None:
        # Aus ComfyUI exportierte FLUX-Graphen haben oft ein FluxGuidance
        # zwischen Sampler und Textknoten.
        workflow = {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "x.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "alt", "clip": ["1", 1]}},
            "4": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024}},
            "7": {"class_type": "FluxGuidance", "inputs": {"conditioning": ["2", 0], "guidance": 3.5}},
            "5": {"class_type": "KSampler", "inputs": {"positive": ["7", 0], "negative": ["2", 0], "latent_image": ["4", 0]}},
        }
        request = adapter.build_request(
            "image.lora", "imageLora", "m", {"workflow": workflow, "prompt": "neu"}
        )
        self.assertEqual(request["workflow"]["2"]["inputs"]["text"], "neu")

    def test_prompt_ohne_textknoten_wird_gemeldet_statt_still_ignoriert(self) -> None:
        workflow = {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "x.safetensors"}},
            "5": {"class_type": "KSampler", "inputs": {"positive": ["2", 0], "negative": ["2", 0]}},
        }
        with self.assertLogs("comfyui_adapter", level="WARNING") as logs:
            result = adapter.apply_prompt_to_image_workflow(workflow, {"prompt": "kommt nicht an"})
        self.assertIs(result, workflow)
        self.assertIn("Demo-Bild", " ".join(logs.output))

    def test_lora_kette_wird_eingezogen_und_verbraucher_umgehaengt(self) -> None:
        workflow = self._request(
            lora_pairs=[
                {"name": "mstyle_comic.safetensors", "weight": 0.8},
                {"name": "dark_ornament.safetensors", "weight": 0.5},
            ]
        )["workflow"]
        # Kette: loader -> lora1 -> lora2, jede Stufe gewichtet.
        self.assertEqual(workflow["lora1"]["inputs"]["model"], ["1", 0])
        self.assertEqual(workflow["lora1"]["inputs"]["clip"], ["1", 1])
        self.assertEqual(workflow["lora1"]["inputs"]["strength_model"], 0.8)
        self.assertEqual(workflow["lora2"]["inputs"]["model"], ["lora1", 0])
        self.assertEqual(workflow["lora2"]["inputs"]["clip"], ["lora1", 1])
        self.assertEqual(workflow["lora2"]["inputs"]["strength_clip"], 0.5)
        # Und die Verbraucher zeigen auf das ENDE der Kette …
        self.assertEqual(workflow["2"]["inputs"]["clip"], ["lora2", 1])
        self.assertEqual(workflow["5"]["inputs"]["model"], ["lora2", 0])
        # … aber der VAE nicht: LoRAs aendern den VAE nicht.
        self.assertEqual(workflow["6"]["inputs"]["vae"], ["1", 2])

    def test_ohne_lora_pairs_bleibt_der_graph_ohne_lora_knoten(self) -> None:
        workflow = self._request()["workflow"]
        self.assertNotIn("LoraLoader", {n["class_type"] for n in workflow.values()})

    def test_lora_eintrag_als_string_und_liste_ergeben_gewicht_1(self) -> None:
        for entry in ("mstyle_comic.safetensors", ["mstyle_comic.safetensors"]):
            with self.subTest(entry=entry):
                workflow = self._request(lora_pairs=[entry])["workflow"]
                self.assertEqual(workflow["lora1"]["inputs"]["strength_model"], 1.0)

    def test_ungueltiger_lora_name_wird_abgelehnt(self) -> None:
        # Ein Pfad oder eine falsche Endung darf NIE still durchfallen: eine
        # weggelassene LoRA sieht wie eine wirkungslose LoRA aus.
        for name in ("../etc/passwd", "/abs/x.safetensors", "ordner/x.safetensors", "x.pt", ""):
            with self.subTest(name=name):
                with self.assertRaises(ValueError) as ctx:
                    self._request(lora_pairs=[{"name": name}])
                self.assertIn("LoRA-Name", str(ctx.exception))

    def test_ungueltiges_gewicht_wird_abgelehnt(self) -> None:
        with self.assertRaises(ValueError):
            self._request(lora_pairs=[{"name": "a.safetensors", "weight": "stark"}])

    def test_unbekannte_base_wird_abgelehnt(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            self._request(base="sd15")
        self.assertIn("sd15", str(ctx.exception))

    def test_mitgelieferte_workflows_bleiben_unveraendert(self) -> None:
        # Der Adapter arbeitet auf einer Kopie; die Datei im Repo ist die Vorlage.
        path = adapter.WORKFLOW_DIR / "image_sdxl.json"
        before = path.read_text(encoding="utf-8")
        self._request(prompt="anders", seed=99, lora_pairs=["mstyle_comic.safetensors"])
        self.assertEqual(path.read_text(encoding="utf-8"), before)


class ApplyPromptToWorkflowTest(unittest.TestCase):
    """Prompt-Werte muessen IM Graphen landen – sonst erzeugt jedes Lied dasselbe."""

    def _workflow(self) -> dict:
        return {
            "94": {
                "class_type": "TextEncodeAceStepAudio1.5",
                "inputs": {"clip": ["105", 0], "tags": "Demo-Song", "lyrics": "Demo", "bpm": 95, "duration": 120, "seed": 0},
            },
            "98": {"class_type": "EmptyAceStep1.5LatentAudio", "inputs": {"seconds": 120, "batch_size": 1}},
            "3": {"class_type": "KSampler", "inputs": {"seed": 0, "steps": 8, "latent_image": ["98", 0]}},
        }

    def test_prompt_lyrics_tempo_und_laenge_landen_im_graphen(self) -> None:
        filled = adapter.apply_prompt_to_workflow(
            self._workflow(), {"prompt": "Dark Techno", "lyrics": "[verse]", "bpm": 128, "duration": 30, "seed": 4711}
        )
        text = filled["94"]["inputs"]
        self.assertEqual(text["tags"], "Dark Techno")
        self.assertEqual(text["lyrics"], "[verse]")
        self.assertEqual(text["bpm"], 128)
        self.assertEqual(text["duration"], 30.0)
        self.assertEqual(text["seed"], 4711)
        self.assertEqual(filled["3"]["inputs"]["seed"], 4711)
        # Die Latent-Laenge muss mitwandern, sonst passt sie nicht zur Duration.
        self.assertEqual(filled["98"]["inputs"]["seconds"], 30.0)

    def test_original_workflow_bleibt_unveraendert(self) -> None:
        original = self._workflow()
        adapter.apply_prompt_to_workflow(original, {"prompt": "anders"})
        self.assertEqual(original["94"]["inputs"]["tags"], "Demo-Song")

    def test_ohne_prompt_argumente_bleibt_alles(self) -> None:
        original = self._workflow()
        self.assertIs(adapter.apply_prompt_to_workflow(original, {}), original)

    def test_verdrahtete_laenge_wird_nicht_ueberschrieben(self) -> None:
        workflow = self._workflow()
        workflow["94"]["inputs"]["duration"] = ["99", 0]
        workflow["98"]["inputs"]["seconds"] = ["99", 0]
        filled = adapter.apply_prompt_to_workflow(workflow, {"prompt": "x", "duration": 30})
        self.assertEqual(filled["94"]["inputs"]["duration"], ["99", 0])
        self.assertEqual(filled["98"]["inputs"]["seconds"], ["99", 0])

    def test_workflow_ohne_ace_knoten_wird_gemeldet_statt_still_ignoriert(self) -> None:
        workflow = {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}}
        with self.assertLogs("comfyui_adapter", level="WARNING") as logs:
            result = adapter.apply_prompt_to_workflow(workflow, {"prompt": "kommt nicht an"})
        self.assertIs(result, workflow)
        self.assertIn("NICHT eingesetzt", " ".join(logs.output))


class NormalizeOutputTest(unittest.TestCase):
    def test_wan22_video_field(self) -> None:
        result = adapter.normalize_output({"video": VIDEO_URI})
        self.assertEqual((result["kind"], result["count"]), ("video", 1))
        self.assertEqual(result["items"][0]["data"], VIDEO_URI)

    def test_acestep_files_field(self) -> None:
        result = adapter.normalize_output(
            {"files": [{"filename": "song.flac", "kind": "audio", "node_id": "12", "data": "AAAA"}]}
        )
        self.assertEqual(result["kind"], "audio")
        self.assertEqual(result["items"][0]["filename"], "song.flac")
        self.assertEqual(result["items"][0]["nodeId"], "12")

    def test_worker_comfyui_images_field(self) -> None:
        result = adapter.normalize_output({"images": [{"filename": "out.png", "type": "base64", "data": IMAGE_URI}]})
        self.assertEqual(result["kind"], "image")
        self.assertEqual(result["items"][0]["filename"], "out.png")

    def test_worker_comfyui_rohes_base64_wird_zum_data_uri(self) -> None:
        """worker-comfyui liefert `type: "base64"` mit ROHEM base64 (kein Praefix).

        Live-Form (handler.py des Workers, 5.11.0):
        `{"images": [{"filename": "…png", "type": "base64", "data": "iVBORw0…"}]}`.
        `imageHq` liefert dagegen `data:image/png;base64,…` – beide Formen muessen
        beim Aufrufer als dasselbe ankommen.
        """
        result = adapter.normalize_output(
            {"images": [{"filename": "out.png", "type": "base64", "data": "iVBORw0KGgoAAA"}]}
        )
        self.assertEqual(result["items"][0]["data"], "data:image/png;base64,iVBORw0KGgoAAA")
        self.assertNotIn("url", result["items"][0])

    def test_worker_comfyui_s3_ausgabe_wird_zur_url_nicht_zum_base64(self) -> None:
        result = adapter.normalize_output(
            {"images": [{"filename": "out.png", "type": "s3", "data": "s3://bucket/out.png"}]}
        )
        self.assertEqual(result["items"][0]["url"], "s3://bucket/out.png")
        self.assertNotIn("data", result["items"][0])

    def test_legacy_message_field_is_unwrapped(self) -> None:
        result = adapter.normalize_output({"message": IMAGE_URI})
        self.assertEqual((result["kind"], result["count"]), ("image", 1))

    def test_flux_image_url_und_images_ergeben_genau_ein_item(self) -> None:
        """Live-Form von imageHq (2026-09-16): die Nutzlast kommt DOPPELT.

        Die FLUX-Antwort traegt `image_url` und `images[0]` mit demselben
        data:-URI (gemessen: je 1.198.258 Zeichen, dazu `seed`). Beide Felder
        duerfen nicht zu zwei Items fuehren – sonst wandert dasselbe Bild
        zweimal durch die Pipeline.
        """
        result = adapter.normalize_output({"image_url": IMAGE_URI, "images": [IMAGE_URI], "seed": 9030})
        self.assertEqual((result["kind"], result["count"]), ("image", 1))
        self.assertEqual(result["items"][0]["data"], IMAGE_URI)

    def test_flux_image_url_allein_wird_erkannt(self) -> None:
        # Rueckfall, falls ein Worker nur image_url liefert.
        result = adapter.normalize_output({"image_url": IMAGE_URI})
        self.assertEqual((result["kind"], result["count"]), ("image", 1))
        self.assertEqual(result["items"][0]["data"], IMAGE_URI)

    def test_unbekanntes_feld_mit_data_uri_wird_erkannt(self) -> None:
        # Formtoleranz: ein neuer Feldname darf nicht still als "raw" enden.
        result = adapter.normalize_output({"output_png": IMAGE_URI})
        self.assertEqual((result["kind"], result["count"]), ("image", 1))

    def test_plain_url_list(self) -> None:
        result = adapter.normalize_output(["https://example.com/a.png"])
        self.assertEqual(result["count"], 1)

    def test_unknown_shape_is_preserved(self) -> None:
        raw = {"something": "else"}
        result = adapter.normalize_output(raw)
        self.assertEqual(result["kind"], "raw")
        self.assertEqual(result["payload"], raw)

    def test_empty_output(self) -> None:
        self.assertEqual(adapter.normalize_output(None)["count"], 0)


class DecodeItemTest(unittest.TestCase):
    def test_data_uri_is_written(self) -> None:
        import base64

        with tempfile.TemporaryDirectory() as tmp:
            payload = base64.b64encode(b"hello").decode()
            target = pathlib.Path(tmp) / "out.bin"
            written = adapter.decode_item({"data": f"data:audio/flac;base64,{payload}"}, target)
            self.assertEqual(written.read_bytes(), b"hello")

    def test_invalid_base64_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(adapter.decode_item({"data": "not base64 !!"}, pathlib.Path(tmp) / "x.bin"))

    def test_rohes_base64_ohne_data_praefix_wird_geschrieben(self) -> None:
        """videoReal (Wan ksampler) liefert rohes base64, keinen data:-URI.

        Live gemessen 2026-09-16: die Antwort ist `{"video": "AAAAIGZ0eXBpc29t…"}`
        (MP4, beginnt mit der ftyp-Box) – ein Adapter, der nur data:-URIs
        dekodiert, schreibt hier nichts.
        """
        import base64

        with tempfile.TemporaryDirectory() as tmp:
            payload = base64.b64encode(b"\x00\x00\x00\x18ftypmp42").decode()
            target = pathlib.Path(tmp) / "clip.mp4"
            written = adapter.decode_item({"data": payload}, target)
            self.assertEqual(written.read_bytes(), b"\x00\x00\x00\x18ftypmp42")

    def test_missing_data_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(adapter.decode_item({}, pathlib.Path(tmp) / "x.bin"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
