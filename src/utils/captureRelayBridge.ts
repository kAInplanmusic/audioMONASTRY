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
  return () => {
    bridge.stop();
    if (defaultBridge === bridge) defaultBridge = null;
  };
}
