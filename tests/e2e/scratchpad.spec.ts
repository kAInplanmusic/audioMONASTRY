import { test, expect, type Page } from '@playwright/test';

/**
 * P1-4 Prüfpunkt (Browser-Live, automatisiert):
 * Session-Zwischenspeicher (Scratchpad) – IndexedDB-Snapshots überleben Reload,
 * Drag & Drop funktioniert in beide Richtungen (Modul → Ablage, Ablage → Modul)
 * und der Clipboard-Roundtrip (Copy → Paste) liefert gültiges JSON.
 *
 * Wichtig: Der ZWISCHENSPEICHER-Button im Header ist erst ab dem `xl`-Breakpoint
 * sichtbar (Tailwind `hidden xl:flex`), daher läuft der Test mit 1600×900.
 */

test.use({ viewport: { width: 1600, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });

const MONK_DRAG_MIME = 'application/x-monk-item';
const MONK_SCRATCH_MIME = 'application/x-monk-scratchpad';

async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 30_000 });
}

async function openScratchpad(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Zwischenspeicher' }).click();
  await expect(page.getByRole('dialog', { name: 'Zwischenspeicher' })).toBeVisible();
}

test('P1-4 Scratchpad: Snapshot überlebt Reload, DnD beide Richtungen, Clipboard-Roundtrip', async ({ page }) => {
  test.setTimeout(150_000);

  // ---------------------------------------------------------------- 1) Boot
  await enterStudio(page);

  // --------------------------------- 2) Snapshot speichern (IndexedDB-Pfad)
  await openScratchpad(page);
  const dialog = page.getByRole('dialog', { name: 'Zwischenspeicher' });
  await dialog.getByPlaceholder('Name').fill('Test-Snapshot');
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(dialog.getByText('Test-Snapshot')).toBeVisible();

  // ------------------------------------------------- 3) Reload: Snapshot überlebt
  await page.reload();
  await enterStudio(page);
  await openScratchpad(page);
  const dialogAfterReload = page.getByRole('dialog', { name: 'Zwischenspeicher' });
  const snapshotButton = dialogAfterReload.getByRole('button', { name: /Test-Snapshot \d+ BPM/ });
  await expect(snapshotButton).toBeVisible();

  // Laden nach Reload: Klick wendet den Snapshot an und schließt das Panel.
  await snapshotButton.click();
  await expect(page.getByRole('dialog', { name: 'Zwischenspeicher' })).toHaveCount(0);

  // ------------------------------- 4) DnD Richtung 1: Modul → Scratchpad-Ablage
  await openScratchpad(page);
  await page.evaluate(({ mime }) => {
    const source = document.querySelector<HTMLElement>('[aria-label="mixerMONK in den Zwischenspeicher ziehen"]');
    const target = Array.from(document.querySelectorAll<HTMLElement>('div')).find((d) => d.textContent?.trim() === 'HIERHER ZIEHEN');
    if (!source || !target) throw new Error('DnD-Quelle oder -Ziel nicht gefunden');
    const dt = new DataTransfer();
    // dragstart befüllt das DataTransfer über den React-Handler (MONK_DRAG_MIME).
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    if (!dt.types.includes(mime)) throw new Error(`dragstart hat ${mime} nicht gesetzt`);
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { mime: MONK_DRAG_MIME });
  await expect(page.getByRole('dialog', { name: 'Zwischenspeicher' }).getByText('mixerMONK')).toBeVisible();

  // ------------------------------- 5) DnD Richtung 2: Ablage-Eintrag → Modul
  await page.evaluate(({ mime }) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Zwischenspeicher"]');
    const source = Array.from(dialog?.querySelectorAll<HTMLElement>('div[draggable="true"]') ?? []).find((d) => d.textContent?.includes('mixerMONK'));
    const target = document.querySelector<HTMLElement>('#rack-mixer');
    if (!source || !target) throw new Error('Ablage-Eintrag oder Modul-Ziel nicht gefunden');
    const dt = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    if (!dt.types.includes(mime)) throw new Error(`dragstart hat ${mime} nicht gesetzt`);
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { mime: MONK_SCRATCH_MIME });
  // Modul wurde aktiviert (AUTO_AI), weil der Eintrag zum Modul passt.
  await expect(page.locator('#rack-mixer button[aria-pressed="true"]')).toBeVisible({ timeout: 10_000 });

  // ------------------------------ 6) Clipboard: Copy → Paste liefert gültiges JSON
  // Scratchpad-Overlay schließen, damit der Copy-Button im Rack klickbar ist.
  await page.getByRole('dialog', { name: 'Zwischenspeicher' }).getByRole('button', { name: 'Schließen' }).click();
  await expect(page.getByRole('dialog', { name: 'Zwischenspeicher' })).toHaveCount(0);
  await page.locator('#rack-mixer button[aria-label="mixerMONK in Zwischenablage senden"]').first().click();

  // 6a) Clipboard direkt auslesen und parsen.
  const clipText = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  });
  expect(clipText).toBeTruthy();
  const parsed = JSON.parse(clipText!);
  expect(parsed.pluginId).toBe('mixer');
  expect(parsed.name).toBe('mixerMONK');
  expect(typeof parsed.snapshot?.bpm).toBe('number');
  expect(parsed.snapshot?.moduleStates).toBeTruthy();
  expect(typeof parsed.ts).toBe('number');

  // 6b) Echter Paste-Roundtrip: In ein Textfeld einfügen und erneut parsen.
  await page.evaluate(() => {
    const ta = document.createElement('textarea');
    ta.id = 'e2e-clipboard-target';
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
  });
  await page.keyboard.press('ControlOrMeta+V');
  const pasted = await page.evaluate(() => (document.getElementById('e2e-clipboard-target') as HTMLTextAreaElement | null)?.value ?? '');
  expect(pasted).toBeTruthy();
  const reparsed = JSON.parse(pasted);
  expect(reparsed.pluginId).toBe('mixer');
  expect(reparsed.snapshot?.moduleStates).toBeTruthy();
});
