import { test, expect } from '@playwright/test';
import { entryButton, modeButton, rackRow } from './helpers/studioNav';
import { resetSession } from './helpers/studioAuth';

/**
 * Tastatur-Navigation: Skip-Link, Fokus-Falle im Settings-Dialog und
 * Escape-Schließen. Basis für das A11y-Audit (Tastatur-Bedienbarkeit).
 */
test.describe('Tastatur-Navigation', () => {
  test('Skip-Link springt zum Studio-Inhalt', async ({ page }) => {
    await page.goto('/');
    await entryButton(page).click();
    await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });

    await page.keyboard.press('Tab');
    const skipText = await page.evaluate(() => document.activeElement?.textContent ?? '');
    expect(skipText).toContain('Zum Studio-Inhalt springen');

    await page.keyboard.press('Enter');
    const focusId = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? '');
    expect(focusId).toBe('studio-main');
  });

  test('Settings-Dialog hält den Fokus gefangen und schließt per Escape', async ({ page }) => {
    await page.goto('/');
    await entryButton(page).click();
    await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });

    await page.getByLabel('Audio / I-O Einstellungen öffnen').click();
    // autoFocus setzt den Fokus auf den Schließen-Button.
    const initial = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? '');
    expect(initial).toBe('Einstellungen schließen');

    // Mehrere Tabs: Fokus muss im Dialog bleiben.
    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
    const insideDialog = await page.evaluate(() => {
      const el = document.activeElement;
      return !!el && !!el.closest('[role="dialog"]');
    });
    expect(insideDialog).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('Keyboard-Hotkeys (P1-6): Space, Ctrl/Cmd+1..9, Eingabefelder', () => {
  // Frischer Server-Stand je Test: Halter und Modi der Vorgänger-Tests würden
  // sonst den Modus-Zyklus verschieben.
  test.beforeEach(async () => { await resetSession(); });

  test('Space startet/stoppt den Transport für den Mixer-Halter (UI2-P0-001)', async ({ page }) => {
    await page.goto('/');
    await entryButton(page).click();
    await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });

    // P0-1: Play/Stop darf NUR der mixerMONK-Halter. UI2-P0-001: der Mixer hat
    // immer genau einen Halter - in einer Einzelsitzung ist das der einzige
    // Nutzer, die Leertaste wirkt also. Der Fall „ohne Halter" existiert nicht mehr.
    await expect(page.locator('#rack-mixer')).toHaveAttribute('data-plugin-owner', 'me', { timeout: 15_000 });
    const transport = page.locator('#rack-masterplayer');
    await expect(transport.getByText('STOP', { exact: true })).toBeVisible();

    await page.keyboard.press('Space');
    await expect(transport.getByText('PLAY', { exact: true })).toBeVisible();

    await page.keyboard.press('Space');
    await expect(transport.getByText('STOP', { exact: true })).toBeVisible();
  });

  test('Ctrl/Cmd+1 schaltet das erste Registry-Plugin (dropMONK) OFF → STBY → ON → OFF', async ({ page }) => {
    await page.goto('/');
    await entryButton(page).click();
    await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });

    // Hotkey-Mapping (App.tsx P1-6): Ctrl+N = Modus-Button von getPluginRegistry()[n].
    // Registry-Reihenfolge: Index 0 = mixer, Index 1 = drop. Das Nav-Icon ist
    // markiert (aria-current), solange man das Plugin hält.
    const dropNav = page.locator('nav[aria-label="Studio-Navigation"]').getByTitle('dropMONK').first();
    const dropRack = page.locator('#rack-drop');
    await expect(dropRack).toHaveAttribute('data-plugin-mode', 'OFF');
    await expect(dropNav).not.toHaveAttribute('aria-current', /.+/);

    await page.keyboard.press('Control+Digit1');
    await expect(dropRack).toHaveAttribute('data-plugin-mode', 'STBY');
    await expect(dropNav).toHaveAttribute('aria-current', 'page');

    await page.keyboard.press('Control+Digit1');
    await expect(dropRack).toHaveAttribute('data-plugin-mode', 'ON');
    await expect(dropNav).toHaveAttribute('aria-current', 'page');

    await page.keyboard.press('Control+Digit1');
    await expect(dropRack).toHaveAttribute('data-plugin-mode', 'OFF');
    await expect(dropNav).not.toHaveAttribute('aria-current', /.+/);
  });

  test('UI2-P3-003: Modus-Button ist per Tastatur bedienbar (Enter: OFF → STBY → ON → OFF)', async ({ page }) => {
    await page.goto('/');
    await entryButton(page).click();
    await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });

    const eq = rackRow(page, 'eq');
    const button = modeButton(page, 'eqMONK');
    await expect(eq).toHaveAttribute('data-plugin-mode', 'OFF');
    for (const expected of ['STBY', 'ON', 'OFF']) {
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(eq).toHaveAttribute('data-plugin-mode', expected);
    }
    // Zustand steht als Text am Button, nicht nur als Farbe.
    await expect(button).toHaveText(/OFF/);
  });

  test('Hotkeys brechen Eingabefelder nicht (Space tippt Leerzeichen, Ctrl+1 togglet ohne die Eingabe zu verändern)', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 }); // ZWISCHENSPEICHER-Button ist xl-only.
    await page.goto('/');
    await entryButton(page).click();
    await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Zwischenspeicher' }).click();
    const nameInput = page.getByPlaceholder('Name');
    await nameInput.fill('abc');

    const transport = page.locator('#rack-masterplayer');
    await expect(transport.getByText('STOP', { exact: true })).toBeVisible();

    // Space im Eingabefeld: tippt ein Leerzeichen, startet aber NICHT den Transport.
    await page.keyboard.press('Space');
    await expect(nameInput).toHaveValue('abc ');
    await expect(transport.getByText('STOP', { exact: true })).toBeVisible();

    // Ctrl+1 im Eingabefeld: schaltet das Plugin, verändert aber die Eingabe nicht.
    const dropNav = page.locator('nav[aria-label="Studio-Navigation"]').getByTitle('dropMONK').first();
    await page.keyboard.press('Control+Digit1');
    await expect(nameInput).toHaveValue('abc ');
    await expect(dropNav).toHaveAttribute('aria-current', 'page');
  });
});
