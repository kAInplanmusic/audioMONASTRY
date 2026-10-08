import { test, expect, type Page } from '@playwright/test';
import { entryButton } from './helpers/studioNav';

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
const VM_DIALOG = '[role="dialog"][aria-label="Visual-Liveshow"]';

async function startStudio(page: Page) {
  await page.goto('/');
  await entryButton(page).click();
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
    await page.getByLabel('Visual-Liveshow öffnen').click();
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
      await page.getByLabel('Visual-Liveshow öffnen').click();
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
      // BEFUND 2026-09-29 (gemessen mit einer Ad-hoc-Probe, 20 Proben à 400 ms):
      // Die Liveshow-Eröffnung ist auch unter reduced-motion eine kurze
      // Transition – der Canvas steht erst ~4,2 s nach dem Öffnen still
      // (Proben 2,5/2,9/3,3/3,7/4,1 s verändern sich, ab 4,5 s sind 16/16 Proben
      // byte-identisch). Das frühere waitForTimeout(2500) sampelte MITTEN in
      // diese Transition und der Vergleich schlug fehl, obwohl die
      // Reduced-Motion-Zusage hält (data-reduced-motion=true, danach Stillstand).
      // Deshalb: auf den Stillstand WARTEN (zwei Folgeproben identisch), erst dann
      // die eigentliche Zusicherung prüfen. Die Zusicherung selbst bleibt hart –
      // beruhigt sich der Canvas nie, läuft der poll in den Timeout = rot.
      // BEFUND 2026-09-29 (zweite Messung, nach dem Reduced-Motion-Fix): Die
      // Fläche ist nach dem Öffnen zunächst ruhig, wechselt aber EINMAL legitim,
      // sobald das Szenen-Video dekodiert ist und die Show ihren ersten Frame
      // zeichnet (gemessen: 1280x504:6766112 -> 1280x504:6000180, danach dauerhaft
      // stabil über 12 Proben à 400 ms). Ein Poll auf nur ZWEI gleiche Proben
      // konnte in dieses ruhige Fenster fallen und danach am echten Wechsel
      // scheitern. Deshalb: Stillstand über DREI Folgeproben (~1,8 s Fenster) –
      // das ist länger als jeder Settle-Schritt und weicht die eigentliche
      // Zusicherung unten (second === first) nicht auf.
      const stableOver = async (): Promise<string> => {
        const a = await fingerprint();
        await page.waitForTimeout(600);
        const b = await fingerprint();
        if (a !== b) return `instabil(${a} -> ${b})`;
        await page.waitForTimeout(600);
        const c = await fingerprint();
        return b === c ? 'stabil' : `instabil(${b} -> ${c})`;
      };
      await expect
        .poll(stableOver, { timeout: 25_000, intervals: [400] })
        .toBe('stabil');

      const first = await fingerprint();
      await page.waitForTimeout(800);
      const second = await fingerprint();

      expect(first.length).toBeGreaterThan(3);
      expect(second).toBe(first);
    });
  });
});
