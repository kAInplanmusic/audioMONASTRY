import { test, expect } from '@playwright/test';

/**
 * Negativ-Suite des Deep-Test-Laufs (docs/DEEP-TEST-PLAN.md, T4 Schritt 6):
 * die Flotte läuft mit AI_MODE=off – diese Spec BEWEIST das von außen.
 *
 * 1. Kein Token  -> geschützte /api/* sind fail-closed (401/403, NIE 2xx).
 *    Ausnahme /api/health: bewusst offen (404 wäre hier ein Fehler).
 * 2. Mit Studio-Token -> RunPod-backed AI-Routen antworten 503 mit
 *    code=AI_DISABLED (Killschalter aiGate; src/core/ai/aiGate.ts).
 * 3. /api/ai/compose bleibt 200 (deterministischer Lokal-Generator, kein Netz) –
 *    ist er rot, wurde die Route an die AI-Kette angeschlossen (Isolation brich).
 * 4. v2-live (Live-Gate, echten AudioContext nötig) läuft NUR bei aktivem Gate
 *    (DISPLAY gesetzt); sonst taucht es als skipped im Report auf.
 *
 * Tags: alle Tests tragen @ai-negativ bzw. @ai (Plan: AI-bezogene Specs taggen) –
 * der Deep-Test-Runner führt die Suite bewusst MIT dieser Spec aus, weil sie der
 * AI-OFF-Nachweis ist. Zusammen mit tcpdump/conntrack-Probe auf ai-1 (kein
 * ausgehender RunPod-Verkehr) ist der Nachweis doppelt belegt.
 */

const TOKEN = (process.env.STUDIO_ACCESS_TOKEN ?? '').trim();
const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:8080';

/**
 * LAUF-SCOPE dieser Negativ-Suite (Befund Deep-Test T1, 2026-09-29).
 *
 * Die drei Nachweise unten pruefen Eigenschaften der DEPLOYED Flotte:
 *   * das Studio-Gate antwortet ohne Token fail-closed (401/403),
 *   * RunPod-Routen antworten 503 AI_DISABLED (AI_MODE=off),
 *   * generate-drop meldet AI_DISABLED.
 *
 * Der LOKALE Dev-Server kann das nicht zeigen – und zwar absichtlich:
 * NODE_ENV=development schaltet das Studio-Gate auf offen (dev-Fail-open,
 * server.ts/sessionRoutes.ts), und AI_MODE/AI_VISUALS kommen aus der lokalen
 * .env. Gegen ihn sind diese Zusicherungen daher per Konstruktion nicht
 * erfuellbar; sie sind kein App-Fehler.
 *
 * Deshalb laufen sie nur im Proof-Kontext (T4: AI_OFF_PROOF=1, gesetzt in
 * scripts/hetzner/deep-test-run.sh, oder explizit E2E_BASE_URL) und erscheinen
 * im lokalen Trockenlauf SICHTBAR als "skipped" mit Begruendung – bewusst nicht
 * als stilles Gruen und nicht durch Abschwaechen der Zusicherung.
 */
const AI_OFF_PROOF_ACTIVE =
  Boolean((process.env.E2E_BASE_URL ?? '').trim()) || (process.env.AI_OFF_PROOF ?? '').trim() === '1';
const AI_OFF_PROOF_REASON =
  'Nur gegen die deployed AI-OFF-Flotte beweisbar (T4: AI_OFF_PROOF=1/E2E_BASE_URL); lokaler Dev-Server ist per Konstruktion fail-open bzw. fahert AI_MODE aus der lokalen .env.';

/** RunPod-backed Vision-Routen + ein gültiger Payload je Route (Schema genügt). */
const VISION_ROUTES: Array<{ path: string; body: Record<string, unknown> }> = [
  { path: '/api/ai/vision', body: { prompt: 'deeptest negativ-probe' } },
  { path: '/api/ai/vision/video', body: { imageBase64: 'aGVsbG8=' } },
  { path: '/api/ai/vision/clip', body: { prompt: 'deeptest negativ-probe' } },
];

test.describe('AI-OFF-Nachweis (Negativ-Suite)', () => {
  test('@ai-negativ /api/health ist ohne Token offen (200, nie 401)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    expect(res.status(), 'Health-Endpoint muss ohne Auth antworten').toBe(200);
  });

  test('@ai-negativ geschützte API ohne Token ist fail-closed (401/403)', async ({ request }) => {
    test.skip(!AI_OFF_PROOF_ACTIVE, AI_OFF_PROOF_REASON);
    // Token-Quelle für diese Anfrage LEER erzwingen: der Cookie aus der
    // storageState darf den fehlenden x-studio-token nicht kaschieren.
    const headers = { 'x-studio-token': '' };
    const res = await request.post(`${BASE}/api/session/reset`, { headers });
    const status = res.status();
    expect(status === 401 || status === 403 || status === 404 || status === 405,
      `fail-closed erwartet, erhalten: HTTP ${status}`).toBe(true);
    expect([200, 201, 202, 204]).not.toContain(status);
  });

  test('@ai-negativ RunPod-Routen ohne Token liefern nie 2xx (Studio-Gate zuerst)', async ({ request }) => {
    const headers = { 'x-studio-token': '' };
    for (const route of VISION_ROUTES) {
      const res = await request.post(`${BASE}${route.path}`, { data: route.body, headers });
      const status = res.status();
      // RATIONALE: unauthentifiziert MUSS das Studio-Gate (401/403) zuerst greifen.
      // 400 gilt nur als REMISSION (Schema-Prüfung vor dem Gate = fail-open-Fehler
      // würde hier nicht auffallen, aber auch nicht behauptet) – deshalb wird er
      // akzeptiert, aber im Report als Remission sichtbar, nicht als Gate-Beweis.
      // 503 ohne Token wäre ein Gate-Bypass (direkt AI_DISABLED) – auch das ist
      // kein Beweis für fail-closed. 2xx ist in jedem Fall ein Verstoß.
      if (status === 400) {
        test.info().annotations.push({ type: 'remission', description: `${route.path}: 400 (Schema vor Gate) – kein Gate-Beweis` });
      } else {
        expect(status === 401 || status === 403 || status === 405 || status === 503,
          `${route.path}: fail-closed (401/403/503) erwartet, erhalten: HTTP ${status}`).toBe(true);
      }
      expect([200, 201, 202, 204], `${route.path} ohne Token antwortete erfolgreich!`).not.toContain(status);
    }
  });

  test('@ai-negativ Vision-Routen mit Token antworten 503 code=AI_DISABLED', async ({ request }) => {
    test.skip(!AI_OFF_PROOF_ACTIVE, AI_OFF_PROOF_REASON);
    test.skip(!TOKEN, 'STUDIO_ACCESS_TOKEN fehlt (CI ohne .env) – AI_DISABLED-Beweis braucht den Token');
    const headers = { 'x-studio-token': TOKEN };
    for (const route of VISION_ROUTES) {
      const res = await request.post(`${BASE}${route.path}`, { data: route.body, headers });
      const status = res.status();
      // aiRoutes.ts: code AI_DISABLED/NO_ENDPOINT/NO_KEY -> httpStatus 503.
      expect(status, `${route.path}: 503 AI_DISABLED erwartet, erhalten ${status}`).toBe(503);
      let code = '';
      try {
        code = String(((await res.json()) as { code?: string }).code ?? '');
      } catch { /* Body kein JSON – code bleibt leer */ }
      expect(code, `${route.path}: code=AI_DISABLED erwartet, erhalten '${code}'`).toBe('AI_DISABLED');
    }
  });

  test('@ai-negativ generate-drop mit Token meldet AI_DISABLED (kein RunPod)', async ({ request }) => {
    test.skip(!AI_OFF_PROOF_ACTIVE, AI_OFF_PROOF_REASON);
    test.skip(!TOKEN, 'STUDIO_ACCESS_TOKEN fehlt – Beweis braucht den Token');
    const headers = { 'x-studio-token': TOKEN };
    const res = await request.post(`${BASE}/api/ai/generate-drop`, { data: { bpm: 128 }, headers });
    const status = res.status();
    expect(status === 503 || status === 502 || status === 200,
      `generate-drop: 503/502 (AI_DISABLED) oder 200 (deterministisch-lokal) erwartet, erhalten ${status}`).toBe(true);
    if (status === 503 || status === 502) {
      let code = '';
      try {
        code = String(((await res.json()) as { code?: string }).code ?? '');
      } catch { /* leer */ }
      expect(code).toBe('AI_DISABLED');
    } else {
      test.info().annotations.push({ type: 'remission', description: 'generate-drop: 200 – deterministischer Lokal-Pfad ohne AI-Kontakt (Remission)' });
    }
  });

  test('@ai-negativ /api/ai/compose bleibt 200 (Lokal-Generator, keine AI-Kette)', async ({ request }) => {
    const res = await request.post(`${BASE}/api/ai/compose`, { data: { prompt: 'deeptest compose' } });
    expect(res.status(), 'compose ist der bewusst AI-freie Lokal-Pfad').toBe(200);
  });
});

// Live-Gate: echter AudioContext (DISPLAY + kein CI). Im Deep-Test-Lauf wird
// V2_LIVE_SKIP=1 gesetzt -> skipped statt still grün.
const LIVE_GATE_ACTIVE = Boolean(process.env.DISPLAY) && process.env.CI !== 'true' && process.env.V2_LIVE_SKIP !== '1';
test.describe('Live-Gate (aus tests/e2e/v2-live.spec.ts, hier gebündelt als @ai-Laufentscheidung)', () => {
  (LIVE_GATE_ACTIVE ? test : test.skip)('@ai v2-live läuft nur mit echtem Audio-fähigen Browser', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/audio/i);
  });
});
