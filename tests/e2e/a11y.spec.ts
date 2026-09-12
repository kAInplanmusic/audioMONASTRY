import { test, expect, type Page } from '@playwright/test';

/**
 * UI-P1-002 · A11y-Matrix
 * =======================
 * Ergänzt die Responsive-/Browser-Matrix (UI-P1-001) um die Punkte, die dort
 * fehlten: Tastatur-Bedienbarkeit der Toolbar, Fokusführung im Dialog
 * (Initial-Fokus + Fokusfalle + Escape) und `prefers-reduced-motion`
 * (Canvas-Animation steht still).
 *
 * Aufruf: npm run test:e2e:a11y
 */

const TOOLBAR = 'nav[aria-label="Studio-Navigation"]';
const VM_DIALOG = '[role="dialog"][aria-label="VisualMONK Liveshow"]';

async function startStudio(page: Page) {
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator(TOOLBAR)).toBeVisible({ timeout: 30_000 });
}

test.describe('A11y (UI-P1-002)', () => {
  test('Toolbar ist per Tastatur erreichbar; jeder Button hat einen Namen', async ({ page }) => {
    await startStudio(page);
    const buttons = page.locator(`${TOOLBAR} button`);
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(16);

    // Zugänglicher Name: title oder sichtbarer Text (Screenreader-freundlich).
    const names = await buttons.evaluateAll((els) =>
      els.map((el) => (el.getAttribute('title') || el.textContent || '').trim()),
    );
    expect(names.filter((n) => n.length === 0)).toEqual([]);

    // Fokus setzen und per Tastatur aktivieren (Enter).
    await buttons.first().focus();
    await expect(buttons.first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(buttons.first()).toHaveAttribute('aria-current', 'page');
  });

  test('VisualMONK-Dialog: Initial-Fokus, Fokusfalle und Escape schließt', async ({ page }) => {
    await startStudio(page);
    await page.getByLabel('VisualMONK Liveshow oeffnen').click();
    const dialog = page.locator(VM_DIALOG);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Initial-Fokus liegt im Dialog.
    await expect(dialog).toBeFocused();

    // Fokusfalle: 40 Tab-Schritte bleiben im Dialog.
    for (let i = 0; i < 40; i += 1) await page.keyboard.press('Tab');
    const focusInside = await page.evaluate((sel) => {
      const d = document.querySelector(sel);
      return !!d && d.contains(document.activeElement);
    }, VM_DIALOG);
    expect(focusInside).toBe(true);

    // Escape schließt den Dialog.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test.describe('prefers-reduced-motion', () => {
    test('friert die Canvas-Animation (identische Frames)', async ({ page }) => {
      // Explizit VOR dem Laden emulieren (die Context-Option allein greift hier nicht).
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await startStudio(page);
      await page.getByLabel('VisualMONK Liveshow oeffnen').click();
      const dialog = page.locator(VM_DIALOG);
      await expect(dialog).toHaveAttribute('data-reduced-motion', 'true');

      const fingerprint = () =>
        page.evaluate((sel) => {
          const c = document.querySelector(`${sel} canvas`);
          if (!(c instanceof HTMLCanvasElement)) return '';
          const ctx = c.getContext('2d');
          if (!ctx) return '';
          const w = Math.min(64, c.width);
          const h = Math.min(64, c.height);
          const sx = Math.max(0, Math.floor(c.width / 2 - w / 2));
          const sy = Math.max(0, Math.floor(c.height / 2 - h / 2));
          const d = ctx.getImageData(sx, sy, w, h).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum = (sum + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
          return `${c.width}x${c.height}:${sum}`;
        }, VM_DIALOG);

      // Erst nach dem Anlauf (Analyser-/Layout-Settle) messen, dann zwei Proben.
      await page.waitForTimeout(2500);
      const first = await fingerprint();
      await page.waitForTimeout(800);
      const second = await fingerprint();

      expect(first.length).toBeGreaterThan(3);
      expect(second).toBe(first);
    });
  });
});
