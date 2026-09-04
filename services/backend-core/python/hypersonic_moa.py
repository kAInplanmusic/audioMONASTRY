#!/usr/bin/env python3
"""
HyperSonicMOA – GOOGLE/FIRESTORE-ENTKOPPELT (lokaler Rebuild).

Dies ist eine vollstaendig NEUGEBAUTE, selbstgehostete Orchestrierung. Sie besteht
ausschliesslich aus LOKALEN Komponenten:

  * Optionaler lokaler LLM via Ollama (POST http://127.0.0.1:11434/api/generate)
    → moderner, selbstgehosteter Standard (gleiche Auswahl wie in config.yaml).
  * Deterministische, lokale Fallback-Generierung (regex-basierter Extraktor
    + Template) WENN kein Ollama erreichbar ist.

Es wird KEINERLEI Google-, Firebase-, DeepSeek- oder HuggingFace-Endpunkt
aufgerufen. Die Klasse behaelt die API (`HyperSonicMOA.run_pipeline`) bei, damit
aufrufender Code unveraendert funktioniert.
"""
import asyncio
import json
import os
import re

import httpx

# Optional: Ollama Endpunkt (self-hosted). Leer lassen => immer lokaler Fallback.
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434/api/generate")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1")


class HyperSonicMOA:
    """Selbstgehostete Multi-Agent-Orchestrierung (kein Cloud-Backend)."""

    def __init__(self, gemini_key: str = "", hf_token: str = "", deepseek_key: str = None):
        # Fruehere Google/Cloud-Keys werden bewusst NICHT mehr benoetigt.
        # Sie werden ignoriert; nur die Client-/Konfiguration bleibt erhalten.
        self.client = httpx.AsyncClient(timeout=60.0)
        self.ollama_url = OLLAMA_URL
        self.ollama_model = OLLAMA_MODEL

    # ------------------------------------------------------------------ #
    #  Lokaler LLM (Ollama) mit graceful degradation
    # ------------------------------------------------------------------ #
    async def _ollama(self, prompt: str) -> str | None:
        """Ruft ein lokales Ollama-Modell auf. Liefert None bei Fehler/Nichtverfügbarkeit."""
        if not self.ollama_url:
            return None
        try:
            payload = {
                "model": self.ollama_model,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.7},
            }
            resp = await self.client.post(self.ollama_url, json=payload, timeout=60.0)
            if resp.status_code == 200:
                return resp.json().get("response", "")
        except Exception as e:  # pragma: no cover
            print(f"[HyperSonicMOA] Ollama nicht erreichbar ({e}); nutze lokalen Fallback.")
        return None

    # ------------------------------------------------------------------ #
    #  Deterministischer lokaler Fallback-Generator (kein Netzwerk)
    # ------------------------------------------------------------------ #
    def _extract_specs(self, report_text: str) -> tuple[str, str]:
        """Extrahiert grob Name/Kategorie aus einem Text (regex-basiert, lokal)."""
        name = re.search(r"(?i)(?:name|geraet|synth|drum|sampler)[\s:=]+([a-z0-9 -]+)", report_text)
        cat = re.search(r"(?i)kategorie[\s:=]+(synth|drum|sampler|modular|effekt|dynamics|sequenzer)", report_text)
        name_v = name.group(1).strip() if name else "Vintage Rebuild"
        cat_v = cat.group(1).strip().title() if cat else "Synth"
        return name_v, cat_v

    def _template_module(self, report_text: str) -> dict:
        """Erzeugt ein plausibles Modul-JSON lokal, ganz ohne cloud-AI."""
        name, cat = self._extract_specs(report_text)
        return {
            "id": re.sub(r"[^a-z0-9]", "", name.lower())[:20] or "local_rebuild",
            "name": name,
            "kategorie": cat,
            "core_prinzip": "Lokaler, deterministischer Nachbau auf Basis der Eingabe.",
            "controls": [
                {"name": "Cutoff", "type": "Drehregler", "description": "Filterfrequenz"},
                {"name": "Resonanz", "type": "Drehregler", "description": "Filterresonanz"},
                {"name": "Envelope", "type": "Drehregler", "description": "Hüllkurven-Charakter"},
            ],
            "user_friendly_score": 7,
            "kosten": "$",
            "nutzen": "Klarer, druckvoller Klang mit breitem Anwendungsbereich.",
            "nachbau_idee": "Op-Amp-basierte Filterkette mit diskreter Transistorstufe und RC-Envelope.",
            "technische_details": "Lokale, rein deterministische Spezifikation (keine Cloud-AI).",
        }

    # ------------------------------------------------------------------ #
    #  Öffentliche Methoden (kompatibel zur alten API)
    # ------------------------------------------------------------------ #
    async def run_pipeline(self, report_text: str) -> str:
        """
        Fuehrt die (frueher 4-stufige) MOA-Pipeline aus. Statt externer Gemini/
        DeepSeek/HuggingFace nutzt sie Ollama (falls erreichbar) oder den
        deterministischen lokalen Template-Generator.
        """
        report_text = (report_text or "").strip()
        if not report_text:
            report_text = "Ein analoger Polysynth mit vier Stimmen und charakteristischem Filter."
        # 1) Versuche lokales LLM
        prompt = (
            "Generiere ein valides JSON-Modul fuer ein Vintage-Synthesizer-Effektgeraet. "
            "Struktur: {id,name,kategorie,core_prinzip,controls[3],user_friendly_score,kosten,nutzen,"
            "nachbau_idee,technische_details}. Nur das JSON, keine Erklärungen.\n\nReport:\n" + report_text
        )
        raw = await self._ollama(prompt)

        if raw and raw.strip():
            cleaned = raw.strip()
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            try:
                # Validieren, dass es valides JSON und ein Objekt ist
                parsed = json.loads(cleaned)
                if not isinstance(parsed, dict):
                    print("[HyperSonicMOA] Ollama-Antwort war kein JSON-Objekt; nutze Fallback.")
                else:
                    return json.dumps(parsed, ensure_ascii=False)
            except json.JSONDecodeError:
                print("[HyperSonicMOA] Ollama-Antwort war kein valides JSON; nutze Fallback.")

        module = self._template_module(report_text)
        return json.dumps(module, ensure_ascii=False)

    async def close(self):
        await self.client.aclose()


# ---------------------------------------------------------------------- #
#  Komfort-CLI:  python hypersonic_moa.py  "Mein Report-Text..."
# ---------------------------------------------------------------------- #
async def _main():
    import sys
    text = " ".join(sys.argv[1:]) or "Ein analoger Polysynth mit 4 Stimmen."
    moa = HyperSonicMOA()
    try:
        out = await moa.run_pipeline(text)
        print(out)
    finally:
        await moa.close()

if __name__ == "__main__":
    asyncio.run(_main())
