import {  Suspense, lazy, useCallback, useEffect, useRef, useState, useSyncExternalStore  } from 'react';
import { getPluginRegistry, discoverPlugins } from './plugins/registry';
import { audioEngine } from './utils/audioEngine';
import { masterClock } from './core/clock/MonastryMasterClock';
import { usePluginManager } from './context/PluginManagerContext';
import { useModuleState, ModuleState } from './context/ModuleStateContext';
import { useSessionAutosave } from './hooks/useSessionAutosave';
import { RackRow } from './components/RackRow';
import { headerIconStatus } from './components/HeaderPluginIcon';
import { nextModeStep, pluginModeOf, pluginOwnerOf, pluginPanelOpen, pluginSummary } from './core/session/pluginMode';
import { isPluginSynced, isSyncPlugin, pluginSyncVersion, setPluginSync, subscribePluginSync } from './core/session/pluginSync';
import { TECHNO_PRESETS } from './presets';
import { SafeModuleBoundary } from './components/SafeModuleBoundary';
import { FEATURE_FLAGS } from './config/featureFlags';
import { APP_VERSION } from './config/appVersion';
const VoiceGenTerminal = lazy(() => import('./components/VoiceGenTerminal').then(m => ({ default: m.VoiceGenTerminal })));
const VoiceMonkPanel = lazy(() => import('./components/VoiceMonkPanel').then(m => ({ default: m.VoiceMonkPanel })));
const VisualMonkOverlay = lazy(() => import('./components/visual/VisualMonkOverlay').then(m => ({ default: m.VisualMonkOverlay })));
import { MoaHistoryPanel } from './components/MoaHistoryPanel';
import { AudioActionMenuHost } from './components/AudioActionMenuHost';
import { MasteringOverlay } from './components/MasteringOverlay';
import { useAudio } from './context/AudioContext';
import { useSamples } from './context/SampleContext';
import { SettingsDialog } from './components/SettingsDialog';
import { MasterStreamToggle } from './components/MasterStreamToggle';
import { OutputsPanel } from './components/OutputsPanel';
import { Gauge } from 'lucide-react';
import { useDeviceLayout, requestAppFullscreen, exitAppFullscreen, dismissInstallHint } from './hooks/useDeviceLayout';
import { flushPluginSettings } from './utils/pluginSettings';
import { Logo } from './components/Logo';
import { AM_ICON, AM_MODULES, AM_PATH, AmDefs, AmSvg } from './components/am/amUi';
import { StudioMasterplayer } from './components/am/StudioMasterplayer';
import { personColor, personLabel, setSessionPeople, useSessionPeople } from './core/session/sessionPeople';
import { AiMonkDock } from './components/AiMonkDock';
import { Scratchpad } from './components/Scratchpad';
import { SessionScratchpadPanel } from './components/SessionScratchpadPanel';
import { getPluginRoute, routeModuleState } from './core/pluginAudioRouter';
import { buildSessionSnapshot, createScratchpadSnapshot, type SessionScratchpadItem } from './core/session/sessionScratchpad';
const PerformanceMonitorTerminal = lazy(() => import('./components/PerformanceMonitorTerminal').then(m => ({ default: m.PerformanceMonitorTerminal })));
const DrumMachineTerminal = lazy(() => import('./components/DrumMachineTerminal').then(m => ({ default: m.DrumMachineTerminal })));
import { webRTCManager } from './utils/WebRTCManager';
import { storageGetJson } from './utils/storage';

// Rack-Reihenfolge (ARCH-PLUGIN-001, 16 echte MONKs):
//   DJ:        mixer(1) · drop(2) · song(3) · effect(4)
//   PRODUCING: syntisampler(5) · drumsampler(6) · instru(7) · biblio(8)
//   AI:        voice(9) · sound(10) · stem(11) · spatial(12)
//   MASTERING: eq(13) · dsp(14) · master(15) · record(16)
// System-Module (fix, alle 4 User):
//   oben  = masterplayerMONK · nach recordMONK = aiMONK · ganz unten = perforMONK
// MIDI/Controller ist KEIN Plugin (Settings → MIDI / Controllers).
const RACK_ORDER = [
  'mixer', 'drop', 'song', 'effect',
  'syntisampler', 'drumsampler', 'instru', 'biblio',
  'voice', 'sound', 'stem', 'spatial',
  'eq', 'dsp', 'master', 'record',
];

// Header-Navigation: 16 Plugin-Icons in ZWEI Reihen à 8. System-Module
// (aiMONK/perforMONK) haben kein Header-Icon; masterplayerMONK ist die
// feste Kopfzeile oberhalb der Toolbar.

const MON_USERS = ['MON1', 'MON2', 'MON3', 'MON4'] as const;
type MonUser = (typeof MON_USERS)[number];
type MonMix = 'MAIN' | 'MIX' | 'PLUGIN_ONLY';



export default function App() {
  return (
    <SafeModuleBoundary>
      <AppComponent />
    </SafeModuleBoundary>
  );
}

function AppComponent() {
  const { startAudio } = useAudio();
  const { moduleStates, setModuleState } = useModuleState();
  const { requestLock, releaseLock, pluginLocks, transferLock } = usePluginManager();
  const people = useSessionPeople();
  // Eigene Kennung sofort eintragen (vor dem ersten Session-Update).
  useEffect(() => { setSessionPeople(webRTCManager.userId, []); }, []);

  // COLLAB-P1-005: eingehende Main-Out-Parameter anderer Session-User anwenden.
  // EINE Stelle fuer die AudioEngine (die Terminals spiegeln nur ihre Anzeige),
  // damit es keinen doppelten/verschachtelten Aufruf gibt.
  useEffect(() => webRTCManager.addMainOutUpdateListener((msg: { param?: unknown; value?: unknown }) => {
    const param = String(msg?.param ?? '');
    const value = Number(msg?.value);
    if (!param || !Number.isFinite(value)) return;
    if (param === 'masterVolume') audioEngine.setMasterVolume(value);
    else if (param === 'masterVolumeDb') audioEngine.setMasterVolumeDb(value, 0.05);
  }), []);
  const { pendingSample, setPendingSample } = useSamples();

  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(128);
  const [isStarted, setIsStarted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [masteringOpen, setMasteringOpen] = useState(false);
  const [scratchOpen, setScratchOpen] = useState(false);
  const [visualOpen, setVisualOpen] = useState(false);
  const [monitorUser, setMonitorUser] = useState<MonUser>('MON1');
  const [monitorMixes, setMonitorMixes] = useState<Record<MonUser, MonMix>>({
    MON1: 'MAIN', MON2: 'MAIN', MON3: 'MAIN', MON4: 'MAIN',
  });
  const [sessionMembers, setSessionMembers] = useState(0);
  /** COLLAB-P0-004 Teil 2: die Session-Nutzer, damit der Halter auswaehlen kann. */
  const [sessionPeers, setSessionPeers] = useState<{ socketId: string; userId: string }[]>([]);
  const [sessionFull, setSessionFull] = useState(false);
  // Betreiberentscheidung 2026-09-17: Wenn beim Start eine Ansicht markiert ist,
  // dann das Mischpult (mixerMONK) - vorher 'instru'. Die Markierung sagt nur,
  // welche Ansicht gewaehlt ist; Module bleiben davon unberuehrt und starten OFF (P0-1).
  const [activeNav, setActiveNav] = useState<string>('mixer');
  // COLLAB-P1-004: aktive Plugin-Navigation der anderen Session-User (userId → pluginId).
  const [remoteNav, setRemoteNav] = useState<Record<string, { pluginId: string; ts: number }>>({});
  // Formate (Betreiber 2026-10-06): Handy quer · Handy hochkant (vereinfacht) ·
  // Pad quer · PC/Laptop – automatisch aus Gerät, Ausrichtung und Auflösung.
  const deviceLayout = useDeviceLayout();
  // Session-Ausgänge: dieser Nutzer meldet Format und Auflösung, in der er die
  // UI bekommt – jeder der 1–4 Nutzer hat seine eigene (Ausgänge-Panel).
  useEffect(() => {
    webRTCManager.sendEndpointReport({
      layout: deviceLayout.layout,
      // Echter Bildschirm (nicht die gezeichnete Referenzbreite der Kopie).
      width: deviceLayout.resolution.screenWidth,
      height: deviceLayout.resolution.screenHeight,
      devicePixelRatio: deviceLayout.resolution.dpr,
    });
  }, [deviceLayout.layout, deviceLayout.resolution.screenWidth, deviceLayout.resolution.screenHeight, deviceLayout.resolution.dpr]);


  // PERSIST-P1-002: lokaler Autosave (IndexedDB-Fallback) + flush bei pagehide
  // + best-effort Remote-Sync. Der Payload wird bei jeder relevanten
  // Zustandsänderung debounced gespeichert.
  const sessionAutosave = useSessionAutosave();
  useEffect(() => {
    try {
      sessionAutosave.schedule({
        moduleStates,
        bpm,
        isPlaying,
        graph: audioEngine.exportGraphState(),
      });
    } catch {
      // Audio-Graph noch nicht initialisiert – dann nur die UI-Wahrheit sichern.
      sessionAutosave.schedule({ moduleStates, bpm, isPlaying });
    }
  }, [moduleStates, bpm, isPlaying, sessionAutosave]);

  // UI2-P0-002: Hinweiszeile fuer abgelehnte Moduswechsel (fremdes Plugin, Mixer).
  const [modeNotice, setModeNotice] = useState('');
  useEffect(() => {
    if (!modeNotice) return;
    const t = window.setTimeout(() => setModeNotice(''), 3800);
    return () => window.clearTimeout(t);
  }, [modeNotice]);

  /**
   * UI2-P0-002: Modus-Button rechts am Plugin, OFF → STBY → ON → OFF.
   * OFF = frei (kein Halter) · STBY = Lock gehalten, Modul aus (Bypass) ·
   * ON = Lock gehalten, Modul aktiv (PRO, Bedienflaeche offen).
   * Fremde Plugins: kein Anfragen, kein Uebernehmen. mixerMONK: nur Uebergabe.
   */
  const cycleMode = useCallback((id: string) => {
    const me = webRTCManager.userId;
    const lock = pluginLocks[id];
    const owner = pluginOwnerOf(lock);
    const mode = pluginModeOf(id, moduleStates[id], lock);
    const step = nextModeStep(id, mode, owner, me);
    if (step.kind === 'denied') { setModeNotice(step.reason); return; }
    if (step.kind === 'acquire') {
      if (!requestLock(id, me)) { setModeNotice('Gerade von jemand anderem geholt.'); return; }
      if ((moduleStates[id] || 'OFF') !== 'OFF') setModuleState(id, 'OFF');
      return;
    }
    if (step.kind === 'activate') { setModuleState(id, 'PRO'); return; }
    // Beständige Plugins: letzten Stand sichern, BEVOR der Lock frei wird
    // (danach nimmt der Server keinen Stand dieses Nutzers mehr an).
    flushPluginSettings(id);
    setModuleState(id, 'OFF');
    releaseLock(id, me);
  }, [pluginLocks, moduleStates, requestLock, releaseLock, setModuleState]);

  // UI2-P0-003: SYNC-Zustand (Standard an) fuer spielende Plugins.
  useSyncExternalStore(subscribePluginSync, pluginSyncVersion, pluginSyncVersion);

  // Header-Auswahl: springt zum Modul (Spec: „Tippen springt zum Modul“) und
  // meldet die Ansicht an die Session. Der Modus aendert sich nur ueber den
  // Modus-Button am Plugin.
  const handleNavSelect = useCallback((navId: string) => {
    setActiveNav(navId);
    // COLLAB-P1-004: aktive Navigation an die Session melden (Server-Relay).
    webRTCManager.sendSessionNav(navId);
    document.getElementById(`rack-${navId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // COLLAB-P1-004: Navigation der anderen User empfangen und anzeigen.
  useEffect(() => {
    return webRTCManager.addSessionNavListener((msg: any) => {
      const senderUserId = String(msg?.senderUserId ?? '');
      const pluginId = String(msg?.pluginId ?? '');
      if (!senderUserId || !pluginId) return;
      setRemoteNav((prev) => ({ ...prev, [senderUserId]: { pluginId, ts: Number(msg?.ts) || Date.now() } }));
    });
  }, []);

  // Monitor-Ausgabe pro User: MAIN (nur Gesamtmix), MIX (MAIN + eigene
  // Plugins) oder NUR PLUGIN (Cue-Solo). Wirkt ausschließlich auf den
  // lokalen Cue-/Monitor-Weg – die Master-Kette bleibt unberührt.
  const applyMonitorMix = useCallback((user: MonUser, mix: MonMix) => {
    const activeId = Object.entries(moduleStates).find(([, s]) => s === 'PRO')?.[0]
      ?? getPluginRegistry().find(p => (moduleStates[p.id] && moduleStates[p.id] !== 'OFF'))?.id
      ?? 'mixer';
    const track = getPluginRoute(activeId)?.channels[0] ?? 'channel1';
    const source = mix === 'MAIN' ? 'MAIN' : mix === 'MIX' ? 'MIX' : 'PLUGIN';
    audioEngine.setMonitorSource(source, user, track);
  }, [moduleStates]);

  const setMonitorMixForUser = useCallback((user: MonUser, mix: MonMix) => {
    setMonitorMixes(prev => ({ ...prev, [user]: mix }));
    applyMonitorMix(user, mix);
  }, [applyMonitorMix]);

  // MAIN-Berechtigung (revidiert): NUR der Halter (Lock-Owner) des mixerMONK-
  // Plugins ist der DJ und darf den Main-Sound steuern (Play/Stop/BPM/Fades).
  // Kein Admin, kein Superuser, kein Fallback.
  // UI2-P0-001: mixerMONK ist immer ON; Halter = Lock-Owner (vom Server vergeben).
  const mainHolder = (moduleStates['mixer'] || 'OFF') !== 'OFF'
    && Boolean(pluginLocks['mixer']?.active)
    && pluginLocks['mixer']?.lockedBy === webRTCManager.userId;
  useEffect(() => {
    audioEngine.setMainHolderActive(mainHolder);
  }, [mainHolder]);

  // Eine feste Session pro App-Sitzung: Full-Mesh-Peers live im Header anzeigen.
  // P4-1/P4-2: Host sendet Master-Stream an Peers/SFU; Gäste spielen Main ab.
  // P0-1 Login-Regel: ALLE Plugins starten geschlossen – auch mixerMONK
  // (Mixer-Sonderfall entfernt). Nur masterplayer (oben) und aiMONK (unten)
  // sind als feste Sektionen für alle 4 User immer sichtbar.
  const mainDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  /**
   * Clock-Sync (Live-Befund 2026-09-19): die NTP-artige Messung existierte,
   * wurde aber NIE ausgeloest - niemand sendete einen Ping, der Offset blieb 0.
   * Jetzt pingt jeder Client alle 15 s; der Server spiegelt t1/t2 zurueck, die
   * Auswertung (Standardformel) macht die Master-Clock. Ergebnis ist in der
   * DSP-Konsole sichtbar (CLOCK RTT / DRIFT / MESSUNGEN).
   */
  useEffect(() => {
    const off = webRTCManager.addClockPongListener((data) => {
      const d = (data ?? {}) as { t0?: number; t1?: number; t2?: number };
      masterClock.applyServerClock({ t0: d.t0, t1: d.t1, t2: d.t2, t3: performance.now() });
    });
    const tick = window.setInterval(() => {
      webRTCManager.sendClockPing();
    }, 15_000);
    webRTCManager.sendClockPing();
    return () => {
      off();
      window.clearInterval(tick);
    };
  }, []);

  useEffect(() => {
    webRTCManager.onMainStream = (stream) => {
      try {
        const audio = new Audio();
        audio.srcObject = stream;
        void audio.play().catch(() => { /* Autoplay-Fehler ignorieren */ });
      } catch { /* kein Audio-Element verfügbar */ }
    };
    const startHostMain = () => {
      // ROLLENSYSTEM ENTFERNT: Der mixerMONK-Halter (DJ) ist der Master-Stream-
      // Sender für die /master-out-Listener. Kein Admin/Host-Fallback.
      if (!webRTCManager.isMainOutOwner || mainDestRef.current) return;
      const dest = audioEngine.createMasterStreamDestination();
      if (dest) {
        mainDestRef.current = dest;
        webRTCManager.startMainStream(dest.stream);
        // Diagnose-Marker (produktionssichtbar, wie data-live-value): der
        // Main-Out-Stream existiert jetzt. Ohne ihn ist am Zuschauer nicht
        // unterscheidbar, ob der SENDER fehlt oder die Uebertragung.
        if (typeof document !== 'undefined') document.body.dataset.mainStream = 'on';
      }
    };
    /**
     * Diagnose-Marker fuer die Sender-Kette: sagt, WIE WEIT der Main-Out-Audioweg
     * gediehen ist - 'no-owner' (DJ ist nicht Halter) -> 'owner-no-dest' (Halter,
     * aber die Engine liefert keinen Master-Stream) -> 'on' (Stream laeuft zu den
     * Zuschauern). Ohne diese Unterscheidung ist am Zuhörer nicht erkennbar, ob
     * der Sender fehlt oder die Uebertragung.
     */
    const markMainStreamState = () => {
      if (typeof document === 'undefined' || mainDestRef.current) return;
      document.body.dataset.mainStream = webRTCManager.isMainOutOwner ? 'owner-no-dest' : 'no-owner';
    };
    markMainStreamState();
    if (webRTCManager.isMainOutOwner) {
      startHostMain();
    }
    // Nachziehen: der Master-Stream entsteht erst, wenn die Engine wirklich
    // spielt (V2-Sink verbunden). Solange er fehlt, wird alle 2 s erneut
    // versucht (max. 5 min) – damit Ghostuser 5 (/master-out) und Ghostuser 6
    // (/visual-out) den Main-Ton sicher bekommen, auch wenn der DJ erst nach
    // dem Session-Beitritt abspielt.
    let hostMainAttempts = 0;
    const hostMainRetry = window.setInterval(() => {
      if (mainDestRef.current || hostMainAttempts >= 150) {
        window.clearInterval(hostMainRetry);
        return;
      }
      hostMainAttempts += 1;
      markMainStreamState();
      startHostMain();
    }, 2000);
    webRTCManager.onSessionUpdate = (info) => {
      setSessionMembers(info.members.length);
      setSessionPeers(info.members.map((m) => ({ socketId: m.socketId, userId: m.userId })));
      setSessionPeople(webRTCManager.userId, info.members.map((m) => m.userId));
      setSessionFull(info.full);
      if (webRTCManager.isMainOutOwner) {
        startHostMain();
      }
    };
    return () => {
      window.clearInterval(hostMainRetry);
      webRTCManager.onSessionUpdate = () => {};
      webRTCManager.onMainStream = () => {};
      if (mainDestRef.current) {
        try { audioEngine.disconnectMasterStreamDestination(mainDestRef.current); } catch { /* noop */ }
        mainDestRef.current = null;
      }
    };
  }, []);

  // Keyboard-Transport: Leertaste = Play/Stop. Bewusst NICHT in Eingabefeldern
  // (Input/Textarea/Select/ContentEditable), damit Tippen nicht unterbrochen wird.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // P1-6: Ctrl/Cmd+1..9 = Plugin-Toggle (kein Konflikt mit Eingabefeldern).
      if ((e.ctrlKey || e.metaKey) && !e.repeat) {
        const n = Number.parseInt(e.key, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 9) {
          e.preventDefault();
          const plugins = getPluginRegistry();
          const target = plugins[n];
          if (target) {
            // UI2-P0-002: Hotkey = Modus-Button des Plugins (OFF → STBY → ON → OFF).
            const lock = pluginLocks[target.id];
            const step = nextModeStep(
              target.id,
              pluginModeOf(target.id, moduleStates[target.id], lock),
              pluginOwnerOf(lock),
              webRTCManager.userId,
            );
            cycleMode(target.id);
            if (step.kind === 'denied') return;
            const turningOn = step.kind !== 'release';
            // Konsistenz zum Nav-Icon (handleNavSelect): mit dem Modul auch die
            // ANSICHT markieren bzw. loesen und an die Session melden. Ohne das
            // bleibt nach dem Hotkey ein unmarkiertes Nav-Icon stehen (im Test
            // als fehlendes aria-current sichtbar).
            setActiveNav(turningOn ? target.id : '');
            if (turningOn) webRTCManager.sendSessionNav(target.id);
            document.getElementById(`rack-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
        return;
      }
      if (e.code !== 'Space' || e.repeat) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      // P0-1 (revidiert): NUR der mixerMONK-Halter (DJ) darf Play/Stop.
      if (!mainHolder) return;
      e.preventDefault();
      if (isPlaying) {
        audioEngine.stop();
        setIsPlaying(false);
      } else {
        audioEngine.play();
        setIsPlaying(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPlaying, mainHolder, moduleStates, pluginLocks, cycleMode]);

  // P0: Dropout-/Underrun-Telemetrie aus dem Audio-Thread an /api/telemetry.
  useEffect(() => {
    audioEngine.onDropout = (count) => {
      try {
        fetch('/api/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: [{ type: 'dropout', source: 'audio-thread', message: 'Audio-Dropout erkannt', context: { count }, ts: Date.now() }] }),
          keepalive: true,
        }).catch(() => { /* offline */ });
      } catch { /* noop */ }
    };
    return () => { audioEngine.onDropout = null; };
  }, []);

  // P1: End-to-End-Latenz persistieren (alle 30 s an /api/telemetry).
  useEffect(() => {
    const sendLatency = () => {
      try {
        const health = audioEngine.getAudioHealth();
        fetch('/api/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            events: [{
              type: 'latency',
              source: 'telemetry',
              message: 'Latenz-Snapshot',
              context: {
                baseLatencyMs: Math.round(health.baseLatencyMs * 10) / 10,
                sampleRate: health.sampleRate,
                rttMs: Math.round(webRTCManager.lastRttMs * 10) / 10,
                dropouts: audioEngine.dropoutCount,
              },
              ts: Date.now(),
            }],
          }),
          keepalive: true,
        }).catch(() => { /* offline */ });
      } catch { /* noop */ }
    };
    const interval = setInterval(sendLatency, 30_000);
    return () => clearInterval(interval);
  }, []);

  // P1-4: Session-Zwischenspeicher – Snapshot aus aktuellem Zustand bauen bzw. anwenden.
  const handleSaveScratchSnapshot = useCallback((name: string) => {
    let extra: Partial<SessionScratchpadItem['snapshot']> = {};
    try {
      const graph = audioEngine.exportGraphState();
      extra = { patterns: graph.patterns ?? {}, mixer: {}, routing: {} };
    } catch { /* Audio noch nicht initialisiert – leerer Snapshot-Zusatz */ }
    return createScratchpadSnapshot(name, moduleStates, bpm, isPlaying, extra);
  }, [moduleStates, bpm, isPlaying]);

  const handleLoadScratchSnapshot = useCallback((item: SessionScratchpadItem) => {
    const snap = item.snapshot;
    if (Number.isFinite(snap.bpm)) {
      try { audioEngine.setBpm(snap.bpm); } catch { /* noop */ }
      setBpm(snap.bpm);
    }
    Object.entries(snap.moduleStates ?? {}).forEach(([id, s]) => {
      if (s === 'OFF' || s === 'AUTO_AI' || s === 'PRO') setModuleState(id, s);
    });
  }, [setModuleState]);

  /**
   * Startet einen Initialisierungsschritt mit Zeitgrenze.
   *
   * Befund 2026-09-17 (CI-P1-002): `startAudio()` kann HÄNGEN, ohne abzulehnen -
   * dann lief `await startAudio()` nie weiter, `setIsStarted(true)` wurde nie
   * erreicht und das Studio blieb dauerhaft auf dem Start-Screen stehen. Genau das
   * schließt der Kommentar unten aus („darf NICHT auf dem Start-Screen hängen
   * bleiben"). Ein abgelehnter Schritt war schon vorher abgesichert; jetzt auch der
   * nicht endende: nach `timeoutMs` läuft der Start weiter und der Schritt darf im
   * Hintergrund fertig werden.
   */
  const startStepWithTimeout = async <T,>(step: Promise<T>, label: string, timeoutMs: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[startApp] ${label} ohne Rückmeldung nach ${timeoutMs} ms – App startet trotzdem`);
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([step.then(() => undefined).catch((e) => {
        console.error(`[startApp] ${label} fehlgeschlagen (App startet trotzdem):`, e);
      }), guard]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const startApp = async () => {
      // UX-Debug: markiert den Start-Ablauf sichtbar in der Konsole.
      console.log('[startApp] Aktion ausgelöst – Audio-Init beginnt');
      // UX-Fix: Jeder Initialisierungsschritt wird einzeln abgefangen. Wenn das
      // Backend (WebRTC-Signaling) oder einzelne Worklets nicht verfügbar sind,
      // darf die App NICHT auf dem Start-Screen hängen bleiben – sie startet
      // trotzdem und protokolliert den Fehler konsolen-seitig.
      // 10 s: liegt bewusst UNTER den Wartezeiten der E2E-Specs (15 s), damit die
      // Oberflaeche nie auf dem Start-Screen stehen bleibt. Der Audio-Aufbau laeuft
      // im Hintergrund weiter und wird von den Specs anschliessend abgewartet
      // (live gemessen: mit einer Grenze von 25 s blieb das Studio in den Tests
      // laenger haengen als deren Wartezeit - mit 12 s lief der Start weiter, bevor
      // der Audio-Kontext stand).
      await startStepWithTimeout(startAudio(), 'startAudio', 10_000);
      console.log('[startApp] startAudio done');
      // COLLAB-P0-004: Den Startzustand in den Audio-Router nachziehen.
      // mixerMONK startet aktiv, aber `routeModuleState` wird sonst NUR aus
      // `setModuleState` gerufen - beim Start gibt es diesen Aufruf nicht, die
      // Main-Einspeisung bliebe unkonfiguriert. Live sichtbar wurde das daran,
      // dass die Audio-Health-Anzeige kein RUNNING meldete, solange niemand den
      // (jetzt gesperrten) Mixer-Power-Button klicken konnte.
      for (const [mid, mstate] of Object.entries(moduleStates)) {
        if (mstate && mstate !== 'OFF') {
          try { routeModuleState(mid, mstate); } catch { /* Router noch nicht bereit */ }
        }
      }
      // Mikrofon für die WebRTC-Session erst NACH der User-Geste anfragen
      // (iOS-Safari verweigert getUserMedia ohne Geste). Fehler sind optional.
      // Geräte-Wahl aus den Audio-Settings (falls der Nutzer ein Interface
      // gewählt hat), sonst System-Default.
      let preferredInput = '';
      try {
        preferredInput = storageGetJson<{ inputDeviceId?: string }>('audiomonastry_audio_settings')?.inputDeviceId ?? '';
      } catch { /* Settings nicht lesbar – Default */ }
      webRTCManager.startLocalAudio(preferredInput || undefined).catch((e) => console.warn('[startApp] Mikrofon nicht verfügbar:', e));
      try {
        await discoverPlugins();
      } catch (e) {
        console.error('[startApp] discoverPlugins fehlgeschlagen (Fallback-Registry aktiv):', e);
      }
      console.log('[startApp] discoverPlugins done');
      // KEIN Autoplay: Es darf erst klingen, wenn im Plugin ein Ton gestartet
      // oder im Master-Player Play gedrückt wird.
      // Start-BPM aus dem Default-Preset in die AudioEngine übernehmen.
      try {
        const initialPreset = TECHNO_PRESETS[0];
        audioEngine.setBpm(initialPreset.bpm);
        setBpm(initialPreset.bpm);
      } catch (e) {
        console.warn('[startApp] Preset-Sync fehlgeschlagen:', (e as Error).message);
      }
      // IMMER in den App-Screen wechseln – Backend/Worklet-Defizite brechen die App nicht.
      console.log('[startApp] isStarted=true setzen');
      setIsStarted(true);
      setIsPlaying(false);
      // Formate: KEIN Orientierungs-Lock mehr – Handy hochkant hat eine eigene,
      // vereinfachte Ansicht. Vollbild fordert useDeviceLayout beim Tippen an
      // (Handy quer, Pad quer); der Klick auf „Studio betreten" zählt bereits.
  };

  /** Rendert den Terminal-Inhalt eines Rack-Streifens (Special-Cases wie bisher). */
  const renderRackContent = (plugin: any) => {
    if (plugin.id === 'voice') {
      return (
        <Suspense fallback={<div className="h-16 text-neutral-500 text-xs">Lade Voice-Modul…</div>}>
          <div className="flex flex-col gap-4">
            <VoiceGenTerminal enabled={FEATURE_FLAGS.VOICE_GENERATOR_ENABLED} />
            <VoiceMonkPanel userId="localUser" />
          </div>
        </Suspense>
      );
    }
    if (plugin.id === 'drumsampler') {
      return (
        <Suspense fallback={<div className="h-16 text-neutral-500 text-xs">Lade Drum-Sampler…</div>}>
          <DrumMachineTerminal isPlaying={isPlaying} bpm={bpm} />
        </Suspense>
      );
    }
    if (plugin.id === 'master') {
      return (
        <Suspense fallback={<div className="h-16 text-neutral-500 text-xs">Lade Mastering…</div>}>
          <MasteringOverlay isOpen={masteringOpen} onClose={() => setMasteringOpen(false)} />
          <button
            type="button"
            onClick={() => setMasteringOpen(true)}
            className="w-full px-4 py-3 rounded-lg border border-sky-500/30 bg-sky-500/5 text-sky-200 text-xs font-mono tracking-widest hover:bg-sky-500/15 transition-all cursor-pointer"
          >
            NEXUS KONTROL ÖFFNEN
          </button>
        </Suspense>
      );
    }
    return (
      <Suspense fallback={<div className="h-16 text-neutral-500 text-xs">Lade Modul…</div>}>
        <plugin.component />
      </Suspense>
    );
  };

  if (!isStarted) {
      return (
          // QUAL-P2-011: main-Landmark. Lighthouse meldete "Document does not have a
          // main landmark" - Screenreader springen ueber Landmarks, ohne main gibt es
          // kein Sprungziel fuer den Hauptinhalt.
          <main className="min-h-screen relative flex flex-col items-center justify-center bg-black text-white overflow-hidden">
              {/* Ambient-Aura passend zur Logofarbe (Teal/Cyan) */}
              <div className="absolute inset-0 pointer-events-none opacity-40"
                   style={{ background: 'radial-gradient(520px 380px at 50% 42%, rgba(16,120,130,0.35) 0%, rgba(8,20,24,0.2) 45%, transparent 75%)' }} />
              <div className="absolute w-135 h-135 rounded-full blur-3xl opacity-25"
                   style={{ background: 'radial-gradient(circle, rgba(34,211,238,0.5), transparent 70%)' }} />

              <button type="button"
                onClick={startApp}
                // QUAL-P2-011: KEIN aria-label. Es lautete "audioMONASTRY starten",
                // der sichtbare Text ist aber "STUDIO BETRETEN" - Lighthouse hat den
                // Widerspruch gemeldet (label-content-name-mismatch). Ohne aria-label
                // ist der zugaengliche Name genau der sichtbare Text; das ist die
                // einfachste richtige Loesung.
                className="group relative flex flex-col items-center gap-6 outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 rounded-2xl"
              >
                  {/* Logo mit sanftem Glow + Hover-Orbit */}
                  <div className="relative">
                    <div className="absolute inset-0 rounded-2xl blur-2xl bg-cyan-400/20 group-hover:bg-cyan-300/30 transition-colors duration-700 scale-110 group-hover:scale-125" />
                    <div className="relative ring-1 ring-cyan-400/20 rounded-2xl overflow-hidden">
                      <Logo size={96} glow rounded={false} className="group-hover:scale-[1.03] transition-transform duration-500" />
                    </div>
                    <span className="absolute -inset-3 rounded-2xl border border-cyan-400/0 group-hover:border-cyan-400/30 transition-all duration-500" />
                  </div>

                  <span className="text-[9px] font-mono tracking-[0.5em] text-neutral-500 uppercase">Audio Workstation</span>
                  <span className="text-4xl sm:text-5xl font-black tracking-tight text-transparent bg-clip-text bg-linear-to-r from-cyan-300 via-teal-200 to-fuchsia-400">
                    AUDIO MONASTRY
                  </span>
                  <span className="text-[9px] font-mono tracking-[0.35em] text-cyan-300/70 uppercase">V. {APP_VERSION} · HYPERDAW</span>
                  <span className="px-5 py-2.5 rounded-full border border-cyan-400/40 text-cyan-200 text-xs font-bold tracking-[0.3em] uppercase
                                 bg-cyan-500/8 hover:bg-cyan-500/18 hover:border-cyan-300/70 hover:shadow-[0_0_30px_-6px_var(--monk-glow-teal)]
                                 transition-all duration-300 active:scale-95">
                    ▶ Studio betreten
                  </span>
                  {/* PROD-P0-005: Rechtstexte sind Pflicht und muessen VOR dem
                      Studio-Betreten erreichbar sein - hier, auf der Startseite,
                      ohne Zugangstoken. Neuer Tab, damit die Startseite bleibt. */}
              </button>

              {/* QUAL-P2-011 (2026-09-24): Die Rechtslinks standen INNERHALB des
                  Start-Buttons. Ein Link in einem Button ist ungueltiges HTML und
                  gibt unvorhersehbares Verhalten - ein Klick konnte den Button
                  ausloesen statt den Link. Gefunden hat das Lighthouse
                  (target-size am Pfad button.group und label-content-name-mismatch),
                  eingebaut hatte es mein eigener Footer vom 2026-09-23.
                  Jetzt stehen sie daneben, mit genug Flaeche: die Pruefung
                  verlangt mindestens 24x24 px, vorher waren es 68,9x13,5 px. */}
              <div className="mt-4 flex items-center gap-1 text-[9px] font-mono tracking-[0.25em] uppercase">
                    <a
                      href="/impressum"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center px-3 py-2 min-h-6 text-neutral-500 hover:text-cyan-300 transition-colors"
                    >
                      Impressum
                    </a>
                    <span className="text-neutral-700" aria-hidden="true">·</span>
                    <a
                      href="/datenschutz"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center px-3 py-2 min-h-6 text-neutral-500 hover:text-cyan-300 transition-colors"
                    >
                      Datenschutz
                    </a>
              </div>
          </main>
      );
  }

  return (
    <div id="studio-main" tabIndex={-1} data-layout-label={deviceLayout.label} className="am min-h-screen pb-28"><div className="am-wrap" style={{ margin: '0 auto', padding: '8px 16px 40px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <a href="#studio-main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-cyan-500 focus:text-black focus:rounded focus:font-bold">Zum Studio-Inhalt springen</a>
      <AmDefs />
      {/* Kopf + Masterplayer nach Entwurf (docs/design/audioMONASTRY-design.html) */}
      <div className="am-top">
        <header className="am-box am-head">
          <a
            href="#studio-main"
            onClick={(e) => { e.preventDefault(); setActiveNav(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
            className="am-brand"
            aria-label="audioMONASTRY Dashboard"
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            <Logo size={56} rounded={false} />
            <div>
              <b>audio<span>MONASTRY</span></b>
              <small>4-Person Studio · V. {APP_VERSION}</small>
            </div>
          </a>

          <nav className="am-ics" aria-label="Studio-Navigation">
            {AM_MODULES.map((m) => {
              const lock = pluginLocks[m.id];
              const status = headerIconStatus(lock, webRTCManager.userId);
              const owner = pluginOwnerOf(lock);
              const on = (moduleStates[m.id] || 'OFF') !== 'OFF';
              const statusText = status === 'free' ? 'frei' : status === 'mine' ? 'von dir gehalten' : `gesperrt, gehalten von ${personLabel(owner, people)}`;
              return (
                <button
                  key={m.id}
                  type="button"
                  data-plugin-id={m.id}
                  data-lock-status={status}
                  className={`am-ic am-${status === 'locked' ? 'lock' : status} ${activeNav === m.id ? 'am-cur' : ''}`}
                  style={{ ['--c' as string]: m.color, ['--u' as string]: personColor(owner, people) }}
                  onClick={() => handleNavSelect(m.id)}
                  aria-current={activeNav === m.id ? 'page' : undefined}
                  aria-label={`${m.name}, ${statusText}${on ? ', aktiv' : ''}`}
                  title={`${m.name} · ${statusText}`}
                >
                  <AmSvg d={AM_ICON[m.id]} />
                  <span>{m.short}</span>
                  {on && <i className="am-ondot" aria-hidden="true" />}
                </button>
              );
            })}
          </nav>

          <div className="am-hr am-hr2">
            <div className="am-users" role="status" aria-live="polite" title="Aktive Studio-Session (eine feste Session, max. 4 Nutzer)">
              {[0, 1, 2, 3].map((k) => {
                const p = people.people[k];
                return (
                  <span
                    key={k}
                    className={`am-udot ${p ? '' : 'am-away'}`}
                    style={{ ['--u' as string]: p?.color ?? '#445a82' }}
                    title={p ? `Nutzer ${p.no}${p.me ? ' · du' : ''}` : 'frei'}
                  />
                );
              })}
              <span className="am-hint" style={{ marginLeft: 4, color: sessionFull ? 'var(--hot)' : undefined }}>
                {sessionFull ? 'SESSION VOLL' : `SESSION ${sessionMembers + 1}/4`}
              </span>
              {Object.entries(remoteNav).slice(0, 3).map(([userId, nav]) => (
                <span key={userId} className="am-hint" style={{ marginLeft: 6, color: personColor(userId, people) }} title="Wo die anderen gerade sind">
                  {userId.replace(/^user-/, 'u')}→{nav.pluginId}
                </span>
              ))}
              <span className="am-hint" data-testid="layout-label" title="Erkanntes Format und Auflösung" style={{ marginLeft: 6 }}>{deviceLayout.label}</span>
            </div>
            <div className="am-tools">
              <button type="button"
                onClick={() => setScratchOpen(v => !v)}
                className={`am-tool ${scratchOpen ? 'am-on' : ''}`}
                style={{ ['--c' as string]: '#ffb703' }}
                aria-label="Zwischenspeicher"
                aria-pressed={scratchOpen}
                title="Zwischenspeicher der Session"
              >
                <AmSvg d={AM_PATH.board} />
              </button>
              <Scratchpad />
              <MasterStreamToggle />
              <button type="button"
                onClick={() => setVisualOpen(v => !v)}
                className={`am-tool ${visualOpen ? 'am-on' : ''}`}
                style={{ ['--c' as string]: '#e879f9' }}
                aria-label="Visual-Liveshow öffnen"
                aria-pressed={visualOpen}
                title="Visual-Liveshow (Main Visual)"
              >
                <AmSvg d={AM_PATH.visual} />
              </button>
              <OutputsPanel />
              {deviceLayout.fullscreen.supported && !deviceLayout.standalone && deviceLayout.layout !== 'desktop' && (
                <button type="button"
                  onClick={() => (deviceLayout.fullscreen.active ? exitAppFullscreen() : requestAppFullscreen())}
                  className="am-tool"
                  aria-label={deviceLayout.fullscreen.active ? 'Vollbild beenden' : 'Vollbild'}
                  aria-pressed={deviceLayout.fullscreen.active}
                  title={deviceLayout.fullscreen.active ? 'Vollbild beenden' : 'Vollbild'}
                >
                  <AmSvg d={deviceLayout.fullscreen.active ? AM_PATH.unfull : AM_PATH.full} />
                </button>
              )}
              <button type="button"
                onClick={() => setSettingsOpen(true)}
                className="am-gear"
                title="Audio / I-O Einstellungen"
                aria-label="Audio / I-O Einstellungen öffnen"
              >
                <AmSvg d={AM_PATH.gear} />
              </button>
            </div>
          </div>
        </header>

        <StudioMasterplayer bpm={bpm} isPlaying={isPlaying} />
      </div>

      {/* Icon-Toolbar entfernt (doppelte Navigation, kein Mehrwert). */}

      {/* Rack-Liste: alle Module als Streifen (Signalweg steht im mixerMONK, wie im Entwurf). */}
      <div className="am-rack">
        {deviceLayout.installHint && (
          <div role="note" data-testid="install-hint" className="flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-100">
            <span className="flex-1">Vollbild auf diesem Gerät: im Browser <b>Teilen → „Zum Home-Bildschirm“</b> wählen und das Studio von dort starten.</span>
            <button type="button" onClick={dismissInstallHint} aria-label="Hinweis schließen" className="px-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs font-bold cursor-pointer">✕</button>
          </div>
        )}
        {modeNotice && (
          <p role="status" aria-live="polite" className="rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">{modeNotice}</p>
        )}
        {RACK_ORDER.map((id, index) => {
          const plugin = getPluginRegistry().find(p => p.id === id);
          if (!plugin) return null;
          if (id === 'ai' && FEATURE_FLAGS.AI_MONK_DOCK_ENABLED) return null;
          const me = webRTCManager.userId;
          const lock = pluginLocks[id];
          const owner = pluginOwnerOf(lock);
          const mode = pluginModeOf(id, moduleStates[id], lock);
          const ownedByMe = owner === me;
          const lockedByOther = !!owner && owner !== me;
          const ownerLabel = owner ? personLabel(owner, people) : null;
          const panelOpen = pluginPanelOpen(id, mode, owner, me);
          const peers = sessionPeers.filter((m) => m.userId !== me);
          return (
            <RackRow
              key={id}
              id={id}
              name={plugin.name}
              short={plugin.short}
              number={String(index + 1).padStart(2, '0')}
              icon={plugin.icon}
              mode={mode}
              ownerLabel={ownerLabel}
              ownerColor={personColor(owner, people)}
              ownedByMe={ownedByMe}
              lockedByOther={lockedByOther}
              panelOpen={panelOpen}
              summary={pluginSummary(id, mode, owner, me, ownerLabel ?? '')}
              running={mode === 'ON' && isPlaying}
              onCycle={() => cycleMode(id)}
              keepMounted={id === 'mixer'}
              cycleLockedReason={
                id === 'mixer'
                  ? 'mixerMONK ist immer an und nicht schließbar. Der Halter kann ihn nur übergeben.'
                  : lockedByOther
                    ? `Belegt von ${ownerLabel}. Anfragen oder Übernehmen gibt es nicht.`
                    : undefined
              }
              sync={isSyncPlugin(id) ? {
                on: isPluginSynced(id),
                disabled: !ownedByMe,
                onToggle: () => { if (ownedByMe) setPluginSync(id, !isPluginSynced(id)); },
              } : undefined}
              headerExtra={id === 'mixer' && ownedByMe ? (
                <>
                  {peers.length > 0 && (
                    <select
                      aria-label="mixerMONK übergeben"
                      className="am-sel"
                      style={{ fontSize: 11, padding: '2px 6px' }}
                      value=""
                      onChange={(e) => { if (e.target.value) { flushPluginSettings('mixer'); transferLock('mixer', e.target.value); } }}
                    >
                      <option value="">Übergeben an …</option>
                      {peers.map((m) => <option key={m.socketId} value={m.userId}>{personLabel(m.userId, people)}</option>)}
                    </select>
                  )}
                </>
              ) : undefined}
              onCopy={() => {
                try {
                  // P1-4: Plugin-State inkl. aktuellem Session-Snapshot in die
                  // Zwischenablage kopieren (gültiges JSON für Clipboard-Roundtrip).
                  const snapshot = buildSessionSnapshot(moduleStates, bpm, isPlaying);
                  void navigator.clipboard?.writeText(JSON.stringify({
                    pluginId: id,
                    name: plugin.name,
                    state: moduleStates[id] || 'OFF',
                    mode,
                    snapshot,
                    ts: Date.now(),
                  }, null, 2));
                } catch { /* Clipboard nicht verfügbar */ }
              }}
              onLoadScratch={(entry) => {
                // Scratchpad-Eintrag auf ein eigenes Modul gezogen: passt der
                // Eintrag zum Modul, wird es aktiviert (ON). Nur der Halter darf das.
                if (!ownedByMe || id === 'mixer') return;
                if (entry.id === id && (entry.state === 'ON' || entry.state === 'PRO' || entry.state === 'AUTO_AI')) {
                  setModuleState(id, 'PRO' as ModuleState);
                }
              }}
            >
              {(panelOpen || id === 'mixer') && <SafeModuleBoundary>{renderRackContent(plugin)}</SafeModuleBoundary>}
            </RackRow>
          );
        })}
      </div>

      <MoaHistoryPanel />

      {/* Einheitliche Audio-Kontextaktion (Click/Touch) – globaler Host. */}
      <AudioActionMenuHost />

      {/* Touch-Fallback: armiertes Sample global anzeigen */}
      {pendingSample && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-full bg-fuchsia-600/90 border border-fuchsia-300/60 text-white text-[10px] font-mono tracking-widest shadow-[0_8px_30px_rgba(217,70,239,0.5)] backdrop-blur">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          <span className="max-w-[220px] truncate">{pendingSample.name}</span>
          <span className="text-fuchsia-100">→ Ziel antippen</span>
          <button type="button"
            onClick={() => setPendingSample(null)}
            aria-label="Sample-Auswahl aufheben"
            className="px-2 py-0.5 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* FIX BOTTOM: aiMONK (nach recordMONK) + perforMONK (ganz unten) – fest
          für alle User. Die Monitor-Wahl liegt hier bei perforMONK. */}
      <section
        id="rack-perfor"
        className="rounded-xl border border-emerald-400/60 bg-[#0a0f15]/95 shadow-[0_0_24px_-8px_rgba(52,211,153,0.35)] mb-4"
      >
        <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
          <div className="w-10 h-10 shrink-0 rounded-lg border border-emerald-400/70 bg-emerald-900/40 text-emerald-300 flex items-center justify-center shadow-[0_0_12px_rgba(52,211,153,0.35)]">
            <Gauge size={18} />
          </div>
          <h3 className="text-sm font-black tracking-[0.25em] uppercase text-neutral-100">perforMONK</h3>
          <span className="hidden sm:inline text-[9px] font-mono text-emerald-400 tracking-widest">FIXED · MONITOR</span>

          {/* Monitor-Ausgabe pro User: MAIN → MIX (MAIN+PLUGIN) → NUR PLUGIN */}
          <div className="ml-auto flex items-center gap-1.5 flex-wrap">
            <span className="hidden lg:inline text-[9px] font-mono text-neutral-500 tracking-widest">MONITOR</span>
            <select
              value={monitorUser}
              onChange={(e) => {
                const user = e.target.value as MonUser;
                setMonitorUser(user);
                applyMonitorMix(user, monitorMixes[user]);
              }}
              className="appearance-none pl-2 pr-5 py-1 rounded-full bg-neutral-900/80 border border-neutral-800 text-neutral-300 text-[10px] font-mono hover:border-emerald-500/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 transition-colors cursor-pointer"
              title="Monitor-User wählen (User 1-4)"
              aria-label="Monitor-User wählen"
            >
              {MON_USERS.map(u => (
                <option key={u} value={u}>{u.replace('MON', 'USER ')}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                const cur = monitorMixes[monitorUser];
                const next: MonMix = cur === 'MAIN' ? 'MIX' : cur === 'MIX' ? 'PLUGIN_ONLY' : 'MAIN';
                setMonitorMixForUser(monitorUser, next);
              }}
              aria-pressed={monitorMixes[monitorUser] !== 'MAIN'}
              title={`Monitor-Mix für ${monitorUser.replace('MON', 'USER ')}: MAIN → MIX → NUR PLUGIN`}
              className={`px-2.5 py-1 rounded-full border text-[9px] font-bold tracking-widest transition-all cursor-pointer ${
                monitorMixes[monitorUser] === 'PLUGIN_ONLY'
                  ? 'bg-fuchsia-600/20 border-fuchsia-400/60 text-fuchsia-200'
                  : monitorMixes[monitorUser] === 'MIX'
                    ? 'bg-amber-500/15 border-amber-400/60 text-amber-200'
                    : 'bg-emerald-500/10 border-emerald-400/50 text-emerald-200 hover:bg-emerald-500/20'
              }`}
            >
              {monitorMixes[monitorUser] === 'MAIN' ? '🎧 MAIN' : monitorMixes[monitorUser] === 'MIX' ? '🎧 MAIN + PLUGIN' : '🎧 NUR PLUGIN'}
            </button>
          </div>
        </div>
        <div className="px-3 pb-3 border-t border-white/5">
          <Suspense fallback={<div className="h-16 flex items-center justify-center text-neutral-500 text-xs">Lade perforMONK…</div>}>
            <PerformanceMonitorTerminal />
          </Suspense>
        </div>
      </section>

      {/* D7: aiMONK-Bottom-Dock (immer offen, ausblendbar) – ersetzt das
          „letzte Modul unten" für alle User. */}
      {FEATURE_FLAGS.AI_MONK_DOCK_ENABLED && <AiMonkDock />}

      {/* Settings / Audio-I/O */}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* VisualMONK Liveshow (Ghostuser 6 / Beamer) – guarded, default aus */}
      {visualOpen && (
        <Suspense fallback={null}>
          <VisualMonkOverlay onClose={() => setVisualOpen(false)} />
        </Suspense>
      )}

      {/* P1-4 (D9): Session-Zwischenspeicher – Overlay-Sidebar */}
      <SessionScratchpadPanel
        open={scratchOpen}
        onClose={() => setScratchOpen(false)}
        onSaveSnapshot={handleSaveScratchSnapshot}
        onLoadSnapshot={handleLoadScratchSnapshot}
      />

      {/* PROD-P0-005: Rechtstexte in JEDER Studio-Ansicht erreichbar. Die
          Abnahmebedingung verlangt die Verlinkung „im Footer jeder Ansicht" –
          dieser Block liegt im gemeinsamen Layout-Abschluss, den alle Ansichten
          teilen (die Startseite oben hat zusätzlich einen eigenen Hinweis). Es
          sind oeffentliche Server-Seiten ohne Zugangstoken, daher neuer Tab. */}
      <footer className="mt-10 flex items-center justify-center gap-3 text-[9px] font-mono tracking-[0.25em] uppercase text-neutral-600">
        <a href="/impressum" target="_blank" rel="noopener noreferrer" className="hover:text-cyan-300 transition-colors">
          Impressum
        </a>
        <span aria-hidden="true">·</span>
        <a href="/datenschutz" target="_blank" rel="noopener noreferrer" className="hover:text-cyan-300 transition-colors">
          Datenschutz
        </a>
      </footer>
    </div>
    </div>
  );
}
