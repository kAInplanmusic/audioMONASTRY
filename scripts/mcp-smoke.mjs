#!/usr/bin/env node
/**
 * audioMONASTRY · MNOA-MCP Smoke-Test (REST-Tool-Registry)
 * ==========================================================
 * Reproduzierbarer Smoke-Test für den serverseitigen MCP-Pfad:
 *   GET  /api/health
 *   GET  /api/ai/mcp/tools
 *   POST /api/ai/mcp/tools/models.list   (harmloses READ-Tool)
 *   POST /api/ai/mcp/tools/<unbekannt>  (Fehlerfall)
 *   POST /api/ai/mcp/tools/<invalid>    (Input-Validierung)
 *
 * Der Test ist für Wiederholung ausgelegt (Kaltstart-Nachweis = erneuter Lauf
 * nach Server-Neustart liefert identische Ergebnisse).
 *
 * Nutzung:
 *   BASE_URL=http://localhost:8080 STUDIO_ACCESS_TOKEN=... node scripts/mcp-smoke.mjs
 *   npm run mcp:smoke
 *
 * Exit-Code: 0 = alle Schritte grün, 1 = mindestens ein Schritt rot.
 */

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const TOKEN = (process.env.STUDIO_ACCESS_TOKEN || '').trim();

let failures = 0;

function ok(name, detail) {
  console.log(`  [ok] ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  failures += 1;
  console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(cond, name, detail) {
  if (cond) ok(name, detail);
  else fail(name, detail);
}

async function jsonFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { 'x-studio-token': TOKEN } : {}),
      ...(options.headers ?? {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

async function stepHealth() {
  const { status, body } = await jsonFetch('/api/health');
  assert(status === 200 && body?.status === 'ok', 'healthcheck', `HTTP ${status}`);
}

async function stepListTools() {
  const { status, body } = await jsonFetch('/api/ai/mcp/tools');
  assert(status === 200 && Array.isArray(body?.tools), 'tools auflisten', `${body?.tools?.length ?? 0} Tools`);
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const names = tools.map((t) => t?.name);
  for (const expected of ['models.list', 'session.getState', 'runtime.status']) {
    assert(names.includes(expected), `tool vorhanden: ${expected}`);
  }
  for (const t of tools) {
    assert(typeof t?.permission === 'string' && ['READ', 'WRITE', 'EXECUTION', 'DESTRUCTIVE'].includes(t.permission), `tool-permission gültig: ${t?.name}`);
    assert(typeof t?.description === 'string' && t.description.length > 0, `tool-beschreibung vorhanden: ${t?.name}`);
  }
  return tools;
}

async function stepInvokeHarmless() {
  const { status, body } = await jsonFetch('/api/ai/mcp/tools/models.list', {
    method: 'POST',
    body: JSON.stringify({ permission: 'READ' }),
  });
  assert(status === 200 && body?.ok === true && Array.isArray(body?.result), 'harmloses Tool (models.list)', `HTTP ${status}`);
}

async function stepUnknownTool() {
  const { status, body } = await jsonFetch('/api/ai/mcp/tools/does.not.exist', {
    method: 'POST',
    body: JSON.stringify({ permission: 'READ' }),
  });
  assert(status === 404 && body?.error === 'unknown tool', 'unbekanntes Tool → 404', `HTTP ${status}`);
}

async function stepInvalidPayload() {
  const { status, body } = await jsonFetch('/api/ai/mcp/tools/models.list', {
    method: 'POST',
    body: '{invalid json',
  });
  // Express + body-parser liefert 400; toleriere auch 500-Fallback, solange kein 200.
  assert(status !== 200, 'ungültiger Payload wird abgelehnt', `HTTP ${status}`);
  void body;
}

async function stepPermissionDenied() {
  // model.load verlangt EXECUTION; mit READ muss der Permission-Check greifen.
  const { status, body } = await jsonFetch('/api/ai/mcp/tools/model.load', {
    method: 'POST',
    body: JSON.stringify({ permission: 'READ', model: 'ast-audioset' }),
  });
  assert(status === 200 && body?.ok === false && String(body?.error ?? '').includes('permission denied'), 'permission-deny (READ auf EXECUTION-Tool)', `HTTP ${status}`);
}

async function main() {
  console.log(`MNOA-MCP Smoke-Test gegen ${BASE_URL}`);
  console.log(`Token gesetzt: ${TOKEN ? 'ja' : 'NEIN (erwartet 401 auf /api/ai/*)'}`);

  await stepHealth();

  if (!TOKEN) {
    // Ohne Token sind MCP-Routen fail-closed (401) — genau das prüfen.
    const list401 = await jsonFetch('/api/ai/mcp/tools');
    assert(list401.status === 401, 'mcp/tools fail-closed ohne Studio-Token', `HTTP ${list401.status}`);
    const invoke401 = await jsonFetch('/api/ai/mcp/tools/models.list', { method: 'POST', body: JSON.stringify({ permission: 'READ' }) });
    assert(invoke401.status === 401, 'mcp/invoke fail-closed ohne Studio-Token', `HTTP ${invoke401.status}`);
    console.log('\nTool-Anzahl: 0 (fail-closed)');
    console.log(failures === 0 ? '\nSMOKE OK (fail-closed-Modus)' : `\nSMOKE FAILED (${failures} Schritt(e) rot)`);
    process.exit(failures === 0 ? 0 : 1);
  }

  const tools = await stepListTools();
  await stepInvokeHarmless();
  await stepUnknownTool();
  await stepInvalidPayload();
  await stepPermissionDenied();

  // „Verbindung trennen + kalt neu“ ist bei REST gleichbedeutend mit einem
  // frischen Prozesslauf: Der Test ist daher bewusst ohne langlebigen Client-
  // Zustand und liefert bei jedem Lauf dasselbe Ergebnis.
  console.log(`\nTool-Anzahl: ${tools.length}`);
  console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures} Schritt(e) rot)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('SMOKE ABGEBROCHEN:', err?.message ?? err);
  process.exit(1);
});
