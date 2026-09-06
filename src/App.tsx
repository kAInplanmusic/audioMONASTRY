import {  Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState  } from 'react';
import { getPluginRegistry, discoverPlugins } from './plugins/registry';
import { audioEngine } from './utils/audioEngine';
import { usePluginManager } from './context/PluginManagerContext';
import { useModuleState, ModuleState } from './context/ModuleStateContext';
import { RackRow } from './components/RackRow';
import { BeatVisualizer } from './components/BeatVisualizer';
import { TECHNO_PRESETS } from './presets';
import { SafeModuleBoundary } from './components/SafeModuleBoundary';
import { FEATURE_FLAGS } from './config/featureFlags';
const VoiceGenTerminal = lazy(() => import('./components/VoiceGenTerminal').then(m => ({ default: m.VoiceGenTerminal })));
const VoiceMonkPanel = lazy(() => import('./components/VoiceMonkPanel').then(m => ({ default: m.VoiceMonkPanel })));
import { MoaHistoryPanel } from './components/MoaHistoryPanel';
import { AudioActionMenuHost } from './components/AudioActionMenuHost';
import { MasteringOverlay } from './components/MasteringOverlay';
import { useAudio } from './context/AudioContext';
import { useSamples } from './context/SampleContext';
import { SettingsDialog } from './components/SettingsDialog';
import { MasterStreamToggle } from './components/MasterStreamToggle';
import { ROLE_PRESETS, moduleStateForRole, StudioRole } from './config/rolePresets';
import { Settings, Activity, ClipboardCopy, UserRound, Gauge } from 'lucide-react';
import { Logo } from './components/Logo';
import { AiMonkDock } from './components/AiMonkDock';
import { Scratchpad } from './components/Scratchpad';
import { SessionScratchpadPanel } from './components/SessionScratchpadPanel';
import { getPluginRoute } from './core/pluginAudioRouter';
import { buildSessionSnapshot, createScratchpadSnapshot, type SessionScratchpadItem } from './core/session/sessionScratchpad';
const PerformanceMonitorTerminal = lazy(() => import('./components/PerformanceMonitorTerminal').then(m => ({ default: m.PerformanceMonitorTerminal })));
const DrumMachineTerminal = lazy(() => import('./components/DrumMachineTerminal').then(m => ({ default: m.DrumMachineTerminal })));
import { webRTCManager } from './utils/WebRTCManager';
import { storageGetJson } from './utils/storage';

// Rack-Reihenfolge laut uiubersicht.png/uirollen.png (18 nummerierte Plugins):
//   DJ:  mixer(1), drop(2), song(3), effect(4)
//   PD:  instrument(5), sampler(6), drum(7), mcp(8), synthesizer(9)
//   AI:  stem(10), voice(11), sound(12), spatial(13), library(14)
//   MS:  eq(15), dsp(16), mastering(17), recording(18)
// controllerMONK ist Zusatzmodul (kein Header-Icon). FIX sind nur:
//   oben  = masterplayer (View-only)
//   unten = performance (perfMONK) + ai (aiMONK-Dock), untereinander fest.
const RACK_ORDER = [
  'mixer', 'drop', 'song', 'effect',
  'instrument', 'sampler', 'drum', 'mcp', 'synthesizer',
  'stem', 'voice', 'sound', 'spatial', 'library',
  'eq', 'dsp', 'mastering', 'recording',
  'controller',
];

// Header-Navigation: 18 Plugin-Icons in ZWEI Reihen à 9 – ein Icon pro
// nummeriertem Plugin (laut uiubersicht). Fixe Racks (performance/ai) und
// controllerMONK (Zusatzmodul ohne Header-Icon) haben kein Icon;
// masterplayerMONK ist die feste Kopfzeile oberhalb der Toolbar.
const NAV_EXCLUDED = new Set(['ai', 'performance']);

const MON_USERS = ['MON1', 'MON2', 'MON3', 'MON4'] as const;
type MonUser = (typeof MON_USERS)[number];
type MonMix = 'MAIN' | 'MIX' | 'PLUGIN_ONLY';

const pluginNavLabel = (name: string) => name.replace(/MONK$/i, '').toUpperCase();


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
  const { requestLock, releaseLock, pluginLocks } = usePluginManager();
  const { pendingSample, setPendingSample } = useSamples();

  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(128);
  const [isStarted, setIsStarted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [masteringOpen, setMasteringOpen] = useState(false);
  const [scratchOpen, setScratchOpen] = useState(false);
  const [monitorUser, setMonitorUser] = useState<MonUser>('MON1');
  const [monitorMixes, setMonitorMixes] = useState<Record<MonUser, MonMix>>({
    MON1: 'MAIN', MON2: 'MAIN', MON3: 'MAIN', MON4: 'MAIN',
  });
  const [sessionMembers, setSessionMembers] = useState(0);
  const [sessionFull, setSessionFull] = useState(false);
  const [activeNav, setActiveNav] = useState<string>('instrument');
  const [rotateHintDismissed, setRotateHintDismissed] = useState(false);
  const [viewport, setViewport] = useState({ w: typeof window !== 'undefined' ? window.innerWidth : 0, h: typeof window !== 'undefined' ? window.innerHeight : 0 });

  // Auflösung live erkennen (mixerMONK + Racks passen sich dynamisch an).
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  // 18 Plugin-Icons für den Header (zwei Reihen à 9) – ohne ai/mixer/masterplayer.
  const navPlugins = useMemo(
    () => getPluginRegistry().filter(p => !NAV_EXCLUDED.has(p.id)),
    [],
  );

  // Header-Auswahl: aktiviert das Modul (Touch/Click) und scrollt zum Rack.
  const handleNavSelect = useCallback((navId: string) => {
    setActiveNav(navId);
    const current = moduleStates[navId] || 'OFF';
    if (current === 'OFF') {
      releaseLock(navId, webRTCManager.userId);
      setModuleState(navId, 'AUTO_AI');
    }
    document.getElementById(`rack-${navId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [moduleStates, releaseLock, setModuleState]);

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

  // MAIN-Berechtigung: NUR der mixerMONK-Halter (PRO + Lock) darf MAIN verändern
  // (Play/Stop, Kanal-Load, Trigger). Die 6 Mixer-Kanäle sind der einzige MAIN-Weg.
  const mainHolder = (moduleStates['mixer'] || 'OFF') === 'PRO'
    && (!pluginLocks['mixer']?.active || pluginLocks['mixer']?.lockedBy === webRTCManager.userId);
  useEffect(() => {
    audioEngine.setMainHolderActive(mainHolder);
  }, [mainHolder]);

  // Eine feste Session pro App-Sitzung: Full-Mesh-Peers live im Header anzeigen.
  // P4-1/P4-2: Host sendet Master-Stream an Peers/SFU; Gäste spielen Main ab.
  // P0-1 Login-Regel: ALLE Plugins starten geschlossen – auch mixerMONK
  // (Mixer-Sonderfall entfernt). Nur masterplayer (oben) und aiMONK (unten)
  // sind als feste Sektionen für alle 4 User immer sichtbar.
  const mainDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  useEffect(() => {
    webRTCManager.onMainStream = (stream) => {
      try {
        const audio = new Audio();
        audio.srcObject = stream;
        void audio.play().catch(() => { /* Autoplay-Fehler ignorieren */ });
      } catch { /* kein Audio-Element verfügbar */ }
    };
    const startHostMain = () => {
      if (!webRTCManager.isHost || mainDestRef.current) return;
      const dest = audioEngine.createMasterStreamDestination();
      if (dest) {
        mainDestRef.current = dest;
        webRTCManager.startMainStream(dest.stream);
      }
    };
    if (webRTCManager.isHost) {
      startHostMain();
    }
    webRTCManager.onSessionUpdate = (info) => {
      setSessionMembers(info.members.length);
      setSessionFull(info.full);
      if (webRTCManager.isHost) {
        startHostMain();
      }
    };
    return () => {
      webRTCManager.onSessionUpdate = () => {};
      webRTCManager.onMainStream = () => {};
      if (mainDestRef.current) {
        try { audioEngine.disconnectMasterStreamDestination(mainDestRef.current); } catch { /* noop */ }
        mainDestRef.current = null;
      }
    };
  }, []);

  // Task 22: Rollen-Start-Presets – wendet das Modul-Profil einer Rolle an.
  const applyRole = (role: StudioRole) => {
    const ids = getPluginRegistry().map(p => p.id);
    const states = moduleStateForRole(role, ids);
    Object.entries(states).forEach(([id, s]) => setModuleState(id, s));
  };

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
            const current = moduleStates[target.id] || 'OFF';
            releaseLock(target.id, webRTCManager.userId);
            setModuleState(target.id, current === 'OFF' ? 'AUTO_AI' : 'OFF');
          }
        }
        return;
      }
      if (e.code !== 'Space' || e.repeat) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
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
  }, [isPlaying, moduleStates, releaseLock, setModuleState]);

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

  // UX: EIN Klick schaltet an/aus (OFF <-> AUTO_AI), Doppelklick aktiviert PRO.
  // P0-1: mixer ist kein Sonderfall mehr – jedes Plugin (auch mixerMONK) ist
  // OFF-fähig und wird erst bei Aktivierung in die Signalkette eingespeist.
  const togglePlugin = useCallback((id: string) => {
    const currentState = moduleStates[id] || 'OFF';
    const nextState: ModuleState = currentState === 'OFF' ? 'AUTO_AI' : 'OFF';
    releaseLock(id, webRTCManager.userId);
    setModuleState(id, nextState);
  }, [moduleStates, releaseLock, setModuleState]);

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- bewusst beibehalten (Runde 3)
  const promotePlugin = useCallback((id: string) => {
    const currentState = moduleStates[id] || 'OFF';
    if (currentState === 'OFF') return;
    const lockGranted = requestLock(id, webRTCManager.userId);
    if (!lockGranted) return;
    setModuleState(id, 'PRO');
  }, [moduleStates, requestLock, setModuleState]);

  // Rack-Promote (⋮): OFF → AUTO_AI → PRO, PRO → OFF (freigeben).
  const rackPromote = useCallback((id: string) => {
    const currentState = moduleStates[id] || 'OFF';
    if (currentState === 'PRO') {
      releaseLock(id, webRTCManager.userId);
      setModuleState(id, 'OFF');
      return;
    }
    if (currentState === 'OFF') setModuleState(id, 'AUTO_AI');
    requestLock(id, webRTCManager.userId);
    setModuleState(id, 'PRO');
  }, [moduleStates, requestLock, releaseLock, setModuleState]);

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

  const startApp = async () => {
      // UX-Debug: markiert den Start-Ablauf sichtbar in der Konsole.
      console.log('[startApp] Aktion ausgelöst – Audio-Init beginnt');
      // UX-Fix: Jeder Initialisierungsschritt wird einzeln abgefangen. Wenn das
      // Backend (WebRTC-Signaling) oder einzelne Worklets nicht verfügbar sind,
      // darf die App NICHT auf dem Start-Screen hängen bleiben – sie startet
      // trotzdem und protokolliert den Fehler konsolen-seitig.
      try {
        await startAudio();
      } catch (e) {
        console.error('[startApp] startAudio fehlgeschlagen (App startet trotzdem):', e);
      }
      console.log('[startApp] startAudio done');
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
      // iPad/Phone: Querformat anstreben (nur möglich im Fullscreen/PWA-Kontext;
      // im normalen Browser-Tab wird der Versuch still ignoriert).
      try {
        const so = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
        if (so && typeof so.lock === 'function') {
          so.lock('landscape').catch(() => { /* Browser erlaubt Lock nicht */ });
        }
      } catch { /* Orientierungs-Lock nicht verfügbar */ }
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
    if (plugin.id === 'drum') {
      return (
        <Suspense fallback={<div className="h-16 text-neutral-500 text-xs">Lade Drum-Machine…</div>}>
          <DrumMachineTerminal isPlaying={isPlaying} bpm={bpm} />
        </Suspense>
      );
    }
    if (plugin.id === 'mastering') {
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
          <div className="min-h-screen relative flex flex-col items-center justify-center bg-black text-white overflow-hidden">
              {/* Ambient-Aura passend zur Logofarbe (Teal/Cyan) */}
              <div className="absolute inset-0 pointer-events-none opacity-40"
                   style={{ background: 'radial-gradient(520px 380px at 50% 42%, rgba(16,120,130,0.35) 0%, rgba(8,20,24,0.2) 45%, transparent 75%)' }} />
              <div className="absolute w-135 h-135 rounded-full blur-3xl opacity-25"
                   style={{ background: 'radial-gradient(circle, rgba(34,211,238,0.5), transparent 70%)' }} />

              <button type="button"
                onClick={startApp}
                aria-label="audioMONASTRY starten"
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
                  <span className="text-[9px] font-mono tracking-[0.35em] text-cyan-300/70 uppercase">V. 1.210.001 · HYPERDAW</span>
                  <span className="px-5 py-2.5 rounded-full border border-cyan-400/40 text-cyan-200 text-xs font-bold tracking-[0.3em] uppercase
                                 bg-cyan-500/8 hover:bg-cyan-500/18 hover:border-cyan-300/70 hover:shadow-[0_0_30px_-6px_var(--monk-glow-teal)]
                                 transition-all duration-300 active:scale-95">
                    ▶ Studio betreten
                  </span>
              </button>
          </div>
      );
  }

  return (
    <div id="studio-main" tabIndex={-1} className="min-h-screen bg-transparent text-white p-6 pb-28 short-landscape:p-2">
      <a href="#studio-main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-cyan-500 focus:text-black focus:rounded focus:font-bold">Zum Studio-Inhalt springen</a>
      {/* 1. Header (Designvorlage uioben.jpg): Logo-Block + 18 Plugin-Icons in zwei Reihen + Avatar */}
      <header className="sticky top-0 z-40 -mx-6 short-landscape:-mx-2 -mt-6 short-landscape:-mt-2 h-20 short-landscape:h-16 bg-[#0a0e13]/95 backdrop-blur-xl border-b border-[#16242e] shadow-[0_10px_30px_-18px_rgba(0,0,0,0.9)]">
        <div className="mx-auto flex h-full items-stretch max-w-[1800px]">
          {/* Logo-Block */}
          <a
            href="#studio-main"
            onClick={(e) => { e.preventDefault(); setActiveNav(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
            className="flex items-center gap-2.5 shrink-0 pl-3 pr-3 border-r border-[#16242e]"
            aria-label="audioMONASTRY Dashboard"
          >
            <div className="relative shrink-0">
              <div className="absolute -inset-1 rounded-lg bg-cyan-400/15 blur-lg" />
              <Logo size={30} rounded={false} className="relative" />
            </div>
            <div className="hidden sm:block leading-none min-w-0">
              <p className="text-[14px] font-black tracking-tight text-white whitespace-nowrap">
                <span className="font-light text-neutral-300">audio</span>MONASTRY
              </p>
              <p className="text-[7px] font-mono tracking-[0.4em] text-neutral-500 uppercase mt-1">4-Person Studio</p>
              <p className="text-[7px] font-mono tracking-[0.25em] text-cyan-300/80 uppercase mt-0.5 whitespace-nowrap">V. 1.210.001 · HYPERDAW</p>
            </div>
          </a>

          {/* Mitte: 18 Auswahl-Icons (zwei Reihen à 9) – ein Icon pro Plugin außer ai/mixer/masterplayer */}
          <nav className="flex-1 min-w-0 overflow-x-auto no-scrollbar" aria-label="Studio-Navigation">
            <div className="grid grid-rows-2 grid-cols-10 min-w-[600px] h-full">
              {navPlugins.map((plugin) => {
                const Icon = plugin.icon;
                const state = moduleStates[plugin.id] || 'OFF';
                const pluginOn = state !== 'OFF';
                const active = activeNav === plugin.id;
                return (
                  <button
                    key={plugin.id}
                    type="button"
                    onClick={() => handleNavSelect(plugin.id)}
                    aria-current={active ? 'page' : undefined}
                    title={plugin.name}
                    className={`relative flex flex-col items-center justify-center gap-0.5 px-1 min-h-0 overflow-hidden text-center transition-colors cursor-pointer ${
                      active ? 'bg-[#0f1a22]' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <Icon
                      size={16}
                      strokeWidth={active || pluginOn ? 2 : 1.6}
                      className={`transition-colors ${
                        active
                          ? 'text-cyan-300 drop-shadow-[0_0_6px_rgba(34,211,238,0.45)]'
                          : pluginOn
                            ? 'text-cyan-300/90'
                            : 'text-[#5fc9dc]'
                      }`}
                    />
                    <span className={`text-[7px] font-bold tracking-[0.08em] uppercase leading-none truncate max-w-full ${
                      active ? 'text-cyan-100' : pluginOn ? 'text-cyan-200' : 'text-[#8b9aa5]'
                    }`}>
                      {pluginNavLabel(plugin.name)}
                    </span>
                    <span className={`absolute bottom-0 left-1/2 -translate-x-1/2 h-[2px] bg-cyan-400 rounded-full transition-all duration-300 ${active ? 'w-6 sm:w-8' : 'w-0'}`} />
                    {pluginOn && (
                      <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)]" />
                    )}
                  </button>
                );
              })}
            </div>
          </nav>

          {/* Rechts: Session + kompakte Steuerung + Avatar */}
          <div className="flex items-center gap-1.5 shrink-0 pl-2 pr-3 border-l border-[#16242e]">
            <div
              className={`hidden xl:flex items-center gap-2 px-2.5 py-1.5 rounded-full border text-[9px] font-mono tracking-widest ${
                sessionFull
                  ? 'border-red-500/40 bg-red-500/10 text-red-300'
                  : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
              }`}
              title="Aktive Studio-Session (eine feste Session, max. 4 User)"
              role="status"
              aria-live="polite"
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${sessionFull ? 'bg-red-400' : 'bg-emerald-400 animate-pulse'}`} />
              {sessionFull ? 'SESSION VOLL' : `SESSION ${sessionMembers + 1}/4`}
            </div>
            <div
              className="hidden md:flex items-center gap-1 px-2.5 py-1.5 rounded-full border border-cyan-400/30 bg-cyan-400/5 text-cyan-300 text-[9px] font-mono tracking-widest"
              title="Aktuelle Viewport-Auflösung"
              role="status"
            >
              {viewport.w}×{viewport.h}
            </div>
            <div className="relative hidden xl:block">
              <select
                defaultValue=""
                onChange={e => e.target.value && applyRole(e.target.value as StudioRole)}
                className="appearance-none pl-2.5 pr-6 py-1.5 rounded-full bg-neutral-900/80 border border-neutral-800 text-neutral-300 text-[10px] hover:border-fuchsia-500/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 transition-colors cursor-pointer"
                title="Rollen-Startprofil wählen"
                aria-label="Rollen-Startprofil wählen"
              >
                <option value="" disabled>Rolle</option>
                {ROLE_PRESETS.map(r => (
                  <option key={r.role} value={r.role}>{r.role.replace('_', ' ')}</option>
                ))}
              </select>
            </div>
            <button type="button"
              onClick={() => setScratchOpen(v => !v)}
              className="hidden xl:flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-amber-400/10 border border-amber-400/40 text-amber-300 hover:bg-amber-400/20 hover:border-amber-300/70 transition-all duration-200 cursor-pointer"
              aria-label="Zwischenspeicher"
              aria-pressed={scratchOpen}
            >
              <ClipboardCopy className="w-4 h-4" />
              <span className="text-[9px] font-bold tracking-widest">ZWISCHENSPEICHER</span>
            </button>
            <div className="hidden xl:block"><Scratchpad /></div>
            <div className="hidden lg:block"><MasterStreamToggle /></div>
            <button type="button"
              onClick={() => setSettingsOpen(true)}
              className="p-2 rounded-full bg-neutral-900/80 border border-neutral-800 text-neutral-400 hover:text-cyan-300 hover:border-cyan-400/50 hover:bg-cyan-400/5 transition-all duration-200 active:scale-95 cursor-pointer"
              title="Audio / I-O Einstellungen"
              aria-label="Audio / I-O Einstellungen öffnen"
            >
              <Settings className="w-4 h-4" />
            </button>
            <div className="hidden sm:flex w-8 h-8 shrink-0 rounded-full bg-gradient-to-br from-cyan-400/20 to-fuchsia-400/20 border border-cyan-400/30 items-center justify-center" title="Studio-User">
              <UserRound className="w-4 h-4 text-cyan-300" />
            </div>
          </div>
        </div>
      </header>

      {/* 2. masterplayerMONK: feste View-only-Leiste (oben, sticky in der Rack-Scroll-Logik). */}
      <section
        id="rack-masterplayer"
        className="rounded-xl border border-cyan-400/60 bg-[#0a0f15]/95 backdrop-blur-xl shadow-[0_0_24px_-8px_rgba(34,211,238,0.45),0_20px_40px_-24px_rgba(0,0,0,0.9)] mb-4 sticky top-20 short-landscape:top-16 z-30"
      >
        <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
          <div className="w-10 h-10 shrink-0 rounded-lg border border-cyan-400/70 bg-cyan-900/40 text-cyan-300 flex items-center justify-center shadow-[0_0_12px_rgba(34,211,238,0.35)]">
            <Activity size={18} />
          </div>
          <h3 className="text-sm font-black tracking-[0.25em] uppercase text-neutral-100">masterplayerMONK</h3>
          <span className="hidden sm:inline text-[9px] font-mono text-cyan-400 tracking-widest">FIXED · VIEW ONLY</span>

          <div className="ml-auto flex items-center gap-4 text-center">
            <div><div className="font-mono text-sm font-bold text-white">{bpm}.00</div><div className="text-[7px] font-mono text-neutral-500 tracking-widest">BPM</div></div>
            <div><div className="font-mono text-sm font-bold text-white">{isPlaying ? 'PLAY' : 'STOP'}</div><div className="text-[7px] font-mono text-neutral-500 tracking-widest">TRANSPORT</div></div>
            <div><div className="font-mono text-sm font-bold text-white">4 / 4</div><div className="text-[7px] font-mono text-neutral-500 tracking-widest">TIME</div></div>
            <div className="hidden sm:block"><div className="font-mono text-sm font-bold text-white">{TECHNO_PRESETS[0]?.key ?? 'C maj'}</div><div className="text-[7px] font-mono text-neutral-500 tracking-widest">KEY</div></div>
          </div>
        </div>
        <div className="px-3 pb-3 border-t border-white/5">
          <BeatVisualizer isPlaying={isPlaying} />
        </div>
      </section>

      {/* Icon-Toolbar entfernt (doppelte Navigation, kein Mehrwert). */}

      {/* Rack-Liste: alle Module als Streifen */}
      <div className="flex flex-col gap-3 max-w-screen-xl mx-auto">
        {RACK_ORDER.map(id => {
          const plugin = getPluginRegistry().find(p => p.id === id);
          if (!plugin) return null;
          if (id === 'ai' && FEATURE_FLAGS.AI_MONK_DOCK_ENABLED) return null;
          const state = moduleStates[id] || 'OFF';
          const lockStatus = pluginLocks[id];
          const lockedByOther = !!lockStatus?.active && lockStatus.lockedBy !== webRTCManager.userId;
          return (
            <RackRow
              key={id}
              id={id}
              name={plugin.name}
              short={plugin.short}
              icon={plugin.icon}
              state={state}
              lockedByOther={lockedByOther}
              onToggle={() => togglePlugin(id)}
              onPromote={() => rackPromote(id)}
              onCopy={() => {
                try {
                  // P1-4: Plugin-State inkl. aktuellem Session-Snapshot in die
                  // Zwischenablage kopieren (gültiges JSON für Clipboard-Roundtrip).
                  const snapshot = buildSessionSnapshot(moduleStates, bpm, isPlaying);
                  void navigator.clipboard?.writeText(JSON.stringify({
                    pluginId: id,
                    name: plugin.name,
                    state: moduleStates[id] || 'OFF',
                    snapshot,
                    ts: Date.now(),
                  }, null, 2));
                } catch { /* Clipboard nicht verfügbar */ }
              }}
              onLoadScratch={(entry) => {
                // Scratchpad-Eintrag auf dieses Modul gezogen: Modul aktivieren;
                // passt der Eintrag zum Modul, wird dessen State übernommen.
                const apply = (entry.id === id && (entry.state === 'AUTO_AI' || entry.state === 'PRO'))
                  ? entry.state
                  : 'AUTO_AI';
                if (apply === 'PRO') requestLock(id, webRTCManager.userId);
                setModuleState(id, apply as ModuleState);
              }}
            >
              {state !== 'OFF' && <SafeModuleBoundary>{renderRackContent(plugin)}</SafeModuleBoundary>}
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

      {/* FIX BOTTOM: perfMONK (oben) + aiMONK (unten) – fest für alle User.
          Die Monitor-Wahl (User + MAIN/PLUGIN-Mix) liegt hier bei perfMONK. */}
      <section
        id="rack-performance"
        className="rounded-xl border border-emerald-400/60 bg-[#0a0f15]/95 shadow-[0_0_24px_-8px_rgba(52,211,153,0.35)] mb-4"
      >
        <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
          <div className="w-10 h-10 shrink-0 rounded-lg border border-emerald-400/70 bg-emerald-900/40 text-emerald-300 flex items-center justify-center shadow-[0_0_12px_rgba(52,211,153,0.35)]">
            <Gauge size={18} />
          </div>
          <h3 className="text-sm font-black tracking-[0.25em] uppercase text-neutral-100">perfMONK</h3>
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
          <Suspense fallback={<div className="h-16 flex items-center justify-center text-neutral-500 text-xs">Lade perfMONK…</div>}>
            <PerformanceMonitorTerminal />
          </Suspense>
        </div>
      </section>

      {/* D7: aiMONK-Bottom-Dock (immer offen, ausblendbar) – ersetzt das
          „letzte Modul unten" für alle User. */}
      {FEATURE_FLAGS.AI_MONK_DOCK_ENABLED && <AiMonkDock />}

      {/* iPhone/iPad: Querformat-Hinweis (16:9-Studio) – nur Hochformat + Touch,
          bewusst dezent und schließbar, blockiert nichts. */}
      {!rotateHintDismissed && (
        <div className="portrait:flex hidden fixed bottom-3 left-1/2 -translate-x-1/2 z-40 items-center gap-2 px-3 py-2 rounded-full bg-cyan-950/90 border border-cyan-400/40 text-cyan-100 text-[10px] font-mono tracking-widest shadow-[0_8px_30px_rgba(0,0,0,0.5)] backdrop-blur">
          <span aria-hidden="true">↻</span>
          <span>Querformat für 16:9-Studio empfohlen</span>
          <button
            type="button"
            onClick={() => setRotateHintDismissed(true)}
            aria-label="Hinweis schließen"
            className="px-1.5 py-0.5 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Settings / Audio-I/O */}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* P1-4 (D9): Session-Zwischenspeicher – Overlay-Sidebar */}
      <SessionScratchpadPanel
        open={scratchOpen}
        onClose={() => setScratchOpen(false)}
        onSaveSnapshot={handleSaveScratchSnapshot}
        onLoadSnapshot={handleLoadScratchSnapshot}
      />
    </div>
  );
}
