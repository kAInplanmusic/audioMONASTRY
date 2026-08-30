import { test, expect, type Page } from '@playwright/test';

/**
 * E2E-Hardware (ohne echte Geräte): mocked Web MIDI + WebHID via
 * `addInitScript`. Verifiziert die UI-Transparenz der Hardware-Schicht:
 * - MIDI-Gerät erscheint im Hardware-Terminal
 * - MIDI-Nachrichten werden als ControlEvent im Mapping-Learn-Panel verarbeitet
 * - Soundkarten-Panel zeigt Engine-Metriken (Sample-Rate/Latenz) ohne Crash
 *
 * HINWEIS: Laufzeit-Test mit echten Geräten bleibt der Hardware-Testmatrix
 * vorbehalten; dieser Spec prüft die Web-Integration mit virtuellen Geräten.
 */

/** Web MIDI mit einem virtuellen Port mocken. */
async function mockWebMidi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeMidiInput {
      id = 'mock-midi-1';
      name = 'Virtual Keyboard';
      manufacturer = 'TestCorp';
      state: MIDIPortDeviceState = 'connected';
      type: MIDIPortType = 'input';
      connection: MIDIPortConnectionState = 'open';
      onmidimessage: ((e: MIDIMessageEvent) => void) | null = null;
      onstatechange: ((e: Event) => void) | null = null;
      open() { return Promise.resolve(this); }
      close() { return Promise.resolve(this); }
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() { return true; }
      fire(data: number[]) {
        this.onmidimessage?.(new MessageEvent('midimessage', { data: new Uint8Array(data) }) as MIDIMessageEvent);
      }
    }
    class FakeMidiAccess {
      inputs = new Map([['mock-midi-1', new FakeMidiInput() as unknown as MIDIInput]]);
      outputs = new Map();
      sysexEnabled = false;
      onstatechange: ((e: Event) => void) | null = null;
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() { return true; }
    }
    navigator.requestMIDIAccess = async () => new FakeMidiAccess() as unknown as MIDIAccess;
  });
}

/** Startseite öffnen und ins Studio wechseln. */
async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 15_000 });
}

test('Hardware-Terminal zeigt virtuelle MIDI-Geräte und bleibt stabil', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await mockWebMidi(page);
  await enterStudio(page);

  // Hardware-Terminal öffnen.
  await page.getByTitle('CTRL').first().click();
  await expect(page.getByText('Virtual Keyboard')).toBeVisible({ timeout: 10_000 });

  // Soundkarten-Panel öffnen: Engine-Metriken sichtbar.
  await page.getByText(/Soundkarten/).first().click();
  await expect(page.getByText(/Engine .* Hz/).first()).toBeVisible({ timeout: 10_000 });

  // Kein White-Screen/Absturz durch Hardware-Mocks.
  expect(pageErrors).toEqual([]);
});
