#!/usr/bin/env node
/**
 * cerebras-agent.mjs – Cerebras Coding-/Plan-Agent (kosten-tiered)
 * ================================================================
 * Entlastet den Haupt-Agenten bei schweren Aufgaben:
 *   - simple   → qwen-3.8-27b   (Kurzantworten, kleine Diffs)
 *   - moderate → gemma-4-31b    (Plan + Code-Skizzen)
 *   - complex  → gpt-oss-120b   (tiefes Reasoning, Strukturpläne)
 *
 * JSON-Modus: liefert { summary, steps:[{file, action, detail}], testHints }.
 *
 * Aufruf:
 *   node scripts/cerebras-agent.mjs "TODO-Beschreibung" --complexity complex
 *   cat task.txt | node scripts/cerebras-agent.mjs --complexity moderate
 */
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
dotenv.config();

const COMPLEXITY = process.argv.includes('--complexity')
  ? process.argv[process.argv.indexOf('--complexity') + 1]
  : 'moderate';
const TIERS = { simple: 'qwen-3.8-27b', moderate: 'gemma-4-31b', complex: 'gpt-oss-120b' };
const MODEL = TIERS[COMPLEXITY] || TIERS.moderate;
const API_KEY = process.env.CB_API_KEY?.trim();
if (!API_KEY) { console.error('CB_API_KEY fehlt (.env)'); process.exit(1); }

const argTask = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ');
const task = argTask || (process.stdin.isTTY ? '' : readFileSync(0, 'utf8')).trim();
if (!task) { console.error('Aufgabe fehlt.'); process.exit(1); }

const system = `Du bist ein präziser Coding-Plan-Agent (Stufe ${COMPLEXITY}). Erzeuge NUR gültiges JSON:
{"summary":"…","steps":[{"file":"pfad","action":"analyze|edit|create|test","detail":"…"}],"testHints":["…"]}`;

const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: task },
    ],
    temperature: 0.1,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  }),
});
const text = await res.text();
if (!res.ok) { console.error(`Cerebras ${res.status}: ${text.slice(0, 300)}`); process.exit(1); }
const data = JSON.parse(text);
console.log(data.choices?.[0]?.message?.content ?? '');
