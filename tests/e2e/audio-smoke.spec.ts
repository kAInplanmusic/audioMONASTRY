import { test, expect } from '@playwright/test';

/**
 * PREP-1 UI-Smoke – verhindert Regressionen wie den AudioWorklet-Export-Bug:
 * App startet, mixerMONK öffnet sich und die Audio-Engine erreicht RUNNING
 * (48 kHz) OHNE Worklet-/Konsolenfehler.
 */
test('App startet, Mixer öffnet und Audio wird RUNNING (kein Worklet-Crash)', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('/');
  await page.getByRole('button', { name: /starten/i }).click();

  // mixerMONK einschalten
  await page.getByRole('button', { name: /mixerMONK Power/i }).click();
  await expect(page.getByText(/mixerMONK · 6 CH/i)).toBeVisible({ timeout: 15000 });

  // perfMONK Audio-Health muss RUNNING melden
  await expect(page.getByText('RUNNING', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('48000 Hz', { exact: false }).first()).toBeVisible({ timeout: 15000 });

  // Keine kritischen Fehler: Worklet-Export-Crash wäre sichtbar als
  // "Unexpected token 'export'" bzw. "No valid URL".
  const critical = consoleErrors.filter((e) => /export|No valid URL for .*processor/i.test(e));
  expect(critical).toEqual([]);
});
