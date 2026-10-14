/**
 * audioMONASTRY · Capture-Relay-Verdrahtung (IDEA-2026-10-07-A-F1)
 * ===============================================================
 * Verbindet `CaptureRelayBridge` (src/core/capture/captureRelayBridge.ts) mit
 * audioEngine (Eingabe-Log, AudioContext-Uhr, Latenzen), WebRTCManager
 * (Session-Socket, Main-Out-Owner, Locks) und masterClock (Offset zur
 * Serveruhr). Wird einmal beim App-Start gestartet.
 *
 * IDEA-2026-10-07-A-F2: zusätzlich der gespiegelte Engine-Pattern-Stand
 * (`capturePatternMirror.ts`). Die Brücke hält eine schlanke lokale Kopie der
 * Lock-Wahrheit (aus dem Session-Snapshot + plugin-lock/unlock-Broadcasts,
 * denselben serverautoritativen Quellen wie der PluginManagerContext), denn
 *  - nur der drumsampler-Halter darf 'pattern' senden (der Server prüft es
 *    zusätzlich), und
 *  - ein Lock-Wechsel löst einen Pattern-Abgleich aus: wer den Lock neu hält,
 *    kennt den Session-Stand noch nicht und holt ihn, BEVOR er sendet - sonst
 *    überschreibt der eigene Leerstand den Stand der anderen Geräte still.
 */
import { CaptureRelayBridge } from '../core/capture/captureRelayBridge';
import { masterClock } from '../core/clock/MonastryMasterClock';
import { audioEngine } from './audioEngine';
import { webRTCManager } from './WebRTCManager';
import { CAPTURE_TARGET_PLUGIN_ID } from '../core/capture/captureRelay';
import { parseSessionSnapshot } from '../core/session/sessionStateBridge';

let defaultBridge: CaptureRelayBridge | null = null;

/** App-Start: Brücke mit den Singletons verdrahten; liefert Abmeldung. */
export function startCaptureRelayBridge(): () => void {
  if (defaultBridge) return () => {};

  // Lokale Kopie der Lock-Wahrheit (serverautoritativ; React-Context ist hier
  // nicht lesbar - startCaptureRelayBridge läuft außerhalb der Komponente).
  const locks: Record<string, { active: boolean; lockedBy: string | null }> = {};
  const holdsSequencerNow = (): boolean => {
    const lock = locks[CAPTURE_TARGET_PLUGIN_ID];
    return !!lock?.active && !!lock.lockedBy && lock.lockedBy === webRTCManager.userId;
  };

  const bridge = new CaptureRelayBridge(
    {
      log: audioEngine.captureLog,
      ctxNowSec: () => audioEngine.getCaptureContextTime(),
      latency: () => audioEngine.getAudioHealth(),
      jitterBufferMs: () => webRTCManager.jitterBufferTargetMs,
      // IDEA-2026-10-07-A-F2: gespiegelte Engine-Patterns in die lokale Engine.
      applySessionPatterns: (patterns) => audioEngine.applySessionPatterns(patterns),
    },
    {
      isCaptureHolder: () => webRTCManager.isMainOutOwner,
      inSession: () => webRTCManager.mainOutOwnerId.length > 0,
      ownUserId: () => webRTCManager.userId,
      holdsSequencer: holdsSequencerNow,
      send: (msg) => webRTCManager.sendCaptureRelay(msg),
      onMessage: (cb) => webRTCManager.onCaptureRelay(cb),
    },
    {
      perfNow: () => performance.now(),
      serverOffsetMs: () => masterClock.getServerOffsetMs(),
      rttMs: () => masterClock.getServerRttMs(),
    },
  );
  bridge.start();
  defaultBridge = bridge;

  // Übergabe (IDEA-2026-10-07-A-F2): sobald DIESES Gerät den Main-Out (= Capture-
  // Halter) übernimmt, holt es die Eingaben ab, die der Server seit dem letzten
  // Weiterleiten vorhält - sonst fehlt der Anfang des Takts, in dem übergeben wurde.
  // Zusätzlich der Pattern-Abgleich (oben beschrieben). Geprüft wird bei JEDEM
  // relevanten Ereignis: der Session-Snapshot (Join/Resync) UND die plugin-
  // lock/unlock-Broadcasts (die feuern KEIN session-state).
  let wasHolder = webRTCManager.isMainOutOwner;
  let wasSequencerHolder = holdsSequencerNow();
  const checkHandover = (): void => {
    const isHolder = webRTCManager.isMainOutOwner;
    const seqHolder = holdsSequencerNow();
    if (isHolder && !wasHolder) bridge.requestHeldOverInputs(`handover-${Date.now()}`);
    if ((isHolder && !wasHolder) || (seqHolder && !wasSequencerHolder)) {
      bridge.requestSessionPatternState();
    }
    wasHolder = isHolder;
    wasSequencerHolder = seqHolder;
  };

  // Lock-Listener: den Stand SOFORT schreiben und erst dann die Übergabe
  // prüfen (sonst liest checkHandover den alten Stand).
  const offSnapshotLocks = webRTCManager.onSessionState((snapshot: unknown) => {
    const parsed = parseSessionSnapshot(snapshot);
    if (!parsed) return;
    for (const [pluginId, lock] of Object.entries(parsed.locks)) {
      locks[pluginId] = { active: lock.active, lockedBy: lock.lockedBy };
    }
    checkHandover();
  });
  const offLock = webRTCManager.onPluginLock((msg: { pluginId?: unknown; lockedBy?: unknown }) => {
    const pluginId = String(msg?.pluginId ?? '');
    const lockedBy = String(msg?.lockedBy ?? '');
    if (!pluginId || !lockedBy) return;
    locks[pluginId] = { active: true, lockedBy };
    checkHandover();
  });
  const offUnlock = webRTCManager.onPluginUnlock((msg: { pluginId?: unknown }) => {
    const pluginId = String(msg?.pluginId ?? '');
    if (!pluginId) return;
    locks[pluginId] = { active: false, lockedBy: null };
    checkHandover();
  });
  return () => {
    offSnapshotLocks();
    offLock();
    offUnlock();
    bridge.stop();
    if (defaultBridge === bridge) defaultBridge = null;
  };
}
