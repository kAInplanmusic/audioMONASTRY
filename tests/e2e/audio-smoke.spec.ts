import { test, expect } from '@playwright/test';

/**
 * PREP-1 UI-Smoke – verhindert Regressionen wie den AudioWorklet-Export-Bug:
 * App startet, mixerMONK ist offen und die Audio-Engine erreicht RUNNING
 * (48 kHz) OHNE Worklet-/Konsolenfehler.
 *
 * Modernisiert 2026-09-17 (CI-P1-002): mixerMONK startet seit der Betreiberregel
 * vom 2026-09-17 aktiv (COLLAB-P0-004: „die anderen spielen zu, mixerMONK
 * entscheidet") und lässt sich nicht schließen - der Power-Button ist bewusst
 * gesperrt, ein Klick darauf lief deshalb in den Timeout. Der Klick entfällt;
 * geprüft wird, dass das Mixer-Terminal von Anfang an offen ist.
 */
test('App startet, Mixer ist offen und Audio wird RUNNING (kein Worklet-Crash)', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('/');
  await page.getByRole('button', { name: /starten/i }).click();

  // Kein Einschalten nötig - der Mixer ist die Main-Einspeisung und startet aktiv.
  await expect(page.getByText(/mixerMONK · 6 CH/i)).toBeVisible({ timeout: 15000 });

  // perfMONK Audio-Health muss RUNNING melden
  await expect(page.getByText('RUNNING', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('48000 Hz', { exact: false }).first()).toBeVisible({ timeout: 15000 });

  // Keine kritischen Fehler: Worklet-Export-Crash wäre sichtbar als
  // "Unexpected token 'export'" bzw. "No valid URL".
  const critical = consoleErrors.filter((e) => /export|No valid URL for .*processor/i.test(e));
  expect(critical).toEqual([]);
});
