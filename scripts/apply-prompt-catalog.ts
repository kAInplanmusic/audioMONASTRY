/**
 * Prompt-Katalog (englisch) in die Datenbank schreiben — ohne laufenden Server.
 *
 * WARUM ES DIESES SKRIPT GIBT
 * ---------------------------
 * Normalerweise schreibt `aiPersistence.ts` die Rollenprompts beim Serverstart.
 * Dafuer braucht der Server den Service-Role-Schluessel, und die Datenbank muss
 * gerade erreichbar sein. Am 2026-09-23 war beides nicht so: die Prompts lagen
 * auf DEUTSCH in der Datenbank, obwohl der Katalog im Repo auf ENGLISCH
 * umgestellt war (AI-P1-PROMPTS-002). Eine Aenderung im Repo ist noch kein
 * Vollzug in der Datenbank — dieselbe Lehre wie bei DB-P2-002.
 *
 * WAS ES TUT
 * ----------
 *   1. Holt die Soll-Zeilen AUS DEM REPO-CODE (`buildPromptEvalSeed`) — kein
 *      zweiter Prompt-Text in diesem Skript.
 *   2. Entfernt die bestehenden Zeilen der Rollen in `system_prompts`
 *      (dort gab es KEINE Eindeutigkeit, daher Duplikate) und schreibt die
 *      englischen neu.
 *   3. Haengt `plugin_prompt_versions.prompt_id` wieder an die neuen Zeilen.
 *   4. Prueft am Ende, dass keine deutsche Prompt-Zeile uebrig ist.
 *
 * Aufruf: npx tsx scripts/apply-prompt-catalog.ts
 * Idempotent: mehrfaches Ausfuehren aendert nichts.
 */
import { readFileSync } from 'node:fs';
import { buildPromptEvalSeed } from '../src/core/ai/orchestrator/promptSeed';

function envAusDatei(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const zeile of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(zeile.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = envAusDatei();
const URL_ = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const KEY = env.SB_SERVICE_ROLE;
if (!URL_ || !KEY) throw new Error('SUPABASE_URL/SUPABASE_URL+VITE und SB_SERVICE_ROLE muessen in .env stehen');

const kopf = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function rest(pfad: string, init: RequestInit = {}) {
  const res = await fetch(`${URL_}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pfad} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const seed = buildPromptEvalSeed();
const zeilen = seed.system_prompts;
console.log(`Soll-Zeilen aus dem Repo: ${zeilen.length}`);

// 1) Deutsche Zeilen finden (Nachweis vorher)
const vorher = await rest('system_prompts?select=plugin_id,role,version,length:content&limit=1000');
const deutschMuster = /(Du bist|Antworte|Erlaubte Kommandos|Fehlerregel|wähle|Eingabe:)/;
const inhaltVorher = await rest('system_prompts?select=plugin_id,role,version,content&limit=1000');
const deutschVorher = inhaltVorher.filter((r: { content: string }) => deutschMuster.test(r.content));
console.log(`Vorher in der Datenbank: ${vorher.length} Zeilen, davon deutsch: ${deutschVorher.length}`);

// 2) Alte Zeilen der Rollen entfernen
const rollen = zeilen.map((z) => z.plugin_id);
const liste = rollen.map((r) => `"${r}"`).join(',');
await rest(`system_prompts?plugin_id=in.(${encodeURIComponent(liste)})`, { method: 'DELETE' });
console.log(`Alte Zeilen entfernt (${rollen.length} Rollen)`);

// 3) Englische Zeilen schreiben
await rest('system_prompts', {
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify(zeilen),
});
console.log(`Englische Zeilen geschrieben: ${zeilen.length}`);

// 4) plugin_prompt_versions.prompt_id wieder anhaengen
const neu = await rest('system_prompts?select=id,plugin_id,role,version');
const nachId = new Map(neu.map((r: { plugin_id: string; role: string; version: number; id: string }) => [`${r.plugin_id}|${r.role}|${r.version}`, r.id]));
let verknuepft = 0;
for (const p of seed.plugin_prompt_versions) {
  const id = nachId.get(`${p.plugin_id}|system|${p.version}`);
  if (!id) continue;
  await rest(`plugin_prompt_versions?plugin_id=eq.${encodeURIComponent(p.plugin_id)}&version=eq.${p.version}`, {
    method: 'PATCH',
    body: JSON.stringify({ prompt_id: id }),
  });
  verknuepft += 1;
}
console.log(`Verknuepft: ${verknuepft} plugin_prompt_versions`);

// 5) Gegenprobe
const inhaltNachher = await rest('system_prompts?select=plugin_id,role,version,content&limit=1000');
const deutschNachher = inhaltNachher.filter((r: { content: string }) => deutschMuster.test(r.content));
console.log(`\nNachher: ${inhaltNachher.length} Zeilen, davon deutsch: ${deutschNachher.length}`);
if (deutschNachher.length > 0) {
  console.log('  NOCH DEUTSCH: ' + deutschNachher.map((r: { plugin_id: string }) => r.plugin_id).join(', '));
  process.exit(1);
}
console.log('Alle Rollen-Prompts sind englisch.');
