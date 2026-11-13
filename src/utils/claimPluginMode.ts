/** Resolve only after the server attests ownership. Promise continuation runs
 * after all synchronous lock listeners, including ModuleState's authority shadow.
 */
export function claimPluginMode(options: {
  pluginId: string; actorId: string; request: () => boolean; signal: AbortSignal;
  onLock: (cb: (message: any) => void) => () => void;
  onDenied: (cb: (message: any) => void) => () => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let offLock = () => {}, offDenied = () => {};
    const cleanup = () => { clearTimeout(timer); offLock(); offDenied(); options.signal.removeEventListener('abort', abort); };
    const fail = (reason: string) => { cleanup(); reject(new Error(reason)); };
    const abort = () => fail('Moduswechsel abgebrochen.');
    const timer = setTimeout(() => fail('Keine Lock-Bestätigung vom Server. Bitte erneut versuchen.'), 5000);
    offLock = options.onLock(message => {
      if (message?.pluginId !== options.pluginId) return;
      if (message.lockedBy !== options.actorId) { fail('Plugin ist inzwischen anderweitig belegt.'); return; }
      cleanup(); resolve();
    });
    offDenied = options.onDenied(message => {
      if (message?.pluginId === options.pluginId) fail('Plugin ist bereits belegt.');
    });
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) { abort(); return; }
    if (!options.request()) fail('Plugin ist bereits belegt.');
  });
}
