"""Acceptance requests keep inputs and inherit production quality defaults."""
import importlib.util
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('vast_qa', ROOT / 'scripts/vast-http-fleet-qa.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class ProductionRequestsTests(TestCase):
    def test_does_not_override_production_quality_or_shorten_input(self):
        source = {'audioBase64': 'complete-input-bytes', 'prompt': 'Enhance the clarity.',
            'inferenceSteps': 2, 'steps': 2, 'maxTokens': 16, 'maxSemanticTokens': 64,
            'planning': 'off', 'enableThinking': False, 'durationSeconds': 1}
        with patch.object(qa.runtime_probe, 'request', return_value=('audio.enhance', source)):
            task, payload = qa.production_request('sonicmaster', {'task': 'audio.enhance'})
        self.assertEqual('audio.enhance', task)
        self.assertEqual({'audioBase64': 'complete-input-bytes', 'prompt': 'Enhance the clarity.'}, payload)


if __name__ == '__main__':
    main()
