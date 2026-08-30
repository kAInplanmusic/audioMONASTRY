import 'dotenv/config';
import { llmRouter } from '../src/core/ai/LlmRouter';

(async () => {
  // 1) DeepSeek (Standard-Rang)
  const ds = await llmRouter.complete({ prompt: 'Antworte mit genau einem Wort: Bereit', complexity: 'moderate' });
  console.log('DEEPSEEK', JSON.stringify({ provider: ds.provider, latencyMs: ds.latencyMs, text: ds.text.slice(0, 120) }));

  // 2) Hugging Face erzwingen (DeepSeek-Key temporär entfernen)
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const hf = await llmRouter.complete({ prompt: 'Antworte mit genau einem Wort: Bereit', complexity: 'simple' });
    console.log('HF', JSON.stringify({ provider: hf.provider, latencyMs: hf.latencyMs, text: hf.text.slice(0, 120) }));
  } finally {
    if (saved) process.env.DEEPSEEK_API_KEY = saved;
  }
})().catch((e) => { console.error('AI-VERIFY-FAIL', e.message); process.exit(1); });
