/**
 * audioMONASTRY · Capture-Relay-Verdrahtung (IDEA-2026-10-07-A-F1)
 * ===============================================================
 * Verbindet `CaptureRelayBridge` (src/core/capture/captureRelayBridge.ts) mit
 * audioEngine (Eingabe-Log, AudioContext-Uhr, Latenzen), WebRTCManager
 * (Session-Socket, Main-Out-Owner) und masterClock (Offset zur Serveruhr).
 * Wird einmal beim App-Start gestartet.
 */
import { CaptureRelayBridge } from '../core/capture/captureRelayBridge';
import { masterClock } from '../core/clock/MonastryMasterClock';
import { audioEngine } from './audioEngine';
import { webRTCManager } from './WebRTCManager';

let defaultBridge: CaptureRelayBridge | null = null;

/** App-Start: Brücke mit den Singletons verdrahten; liefert Abmeldung. */
export function startCaptureRelayBridge(): () => void {
  if (defaultBridge) return () => {};
  const bridge = new CaptureRelayBridge(
    {
      log: audioEngine.captureLog,
      ctxNowSec: () => audioEngine.getCaptureContextTime(),
      latency: () => audioEngine.getAudioHealth(),
      jitterBufferMs: () => webRTCManager.jitterBufferTargetMs,
    },
    {
      isCaptureHolder: () => webRTCManager.isMainOutOwner,
      inSession: () => webRTCManager.mainOutOwnerId.length > 0,
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
  let wasHolder = webRTCManager.isMainOutOwner;
  const offSessionState = webRTCManager.onSessionState(() => {
    const isHolder = webRTCManager.isMainOutOwner;
    if (isHolder && !wasHolder) bridge.requestHeldOverInputs(`handover-${Date.now()}`);
    wasHolder = isHolder;
  });
  return () => {
    offSessionState();
    bridge.stop();
    if (defaultBridge === bridge) defaultBridge = null;
  };
}
