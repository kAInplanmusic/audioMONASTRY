import {  Suspense, lazy, useCallback, useEffect, useRef, useState  } from 'react';
import { getPluginRegistry, discoverPlugins } from './plugins/registry';
import { audioEngine } from './utils/audioEngine';
import { usePluginManager } from './context/PluginManagerContext';
import { useModuleState, ModuleState } from './context/ModuleStateContext';
import { RackRow } from './components/RackRow';
import { BeatVisualizer } from './components/BeatVisualizer';
import { TECHNO_PRESETS } from './presets';
import { SafeModuleBoundary } from './components/SafeModuleBoundary';
import { PluginButton } from './components/PluginButton';
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
import { Settings, Sliders, Activity } from 'lucide-react';
import { Logo } from './components/Logo';
import { AiMonkDock } from './components/AiMonkDock';
import { Scratchpad } from './components/Scratchpad';
import { getPluginRoute } from './core/pluginAudioRouter';
const DJMixer = lazy(() => import('./components/DJ4ChMixer').then(m => ({ default: m.DJMixer })));
const MasterPlayerTerminal = lazy(() => import('./components/MasterPlayerTerminal').then(m => ({ default: m.MasterPlayerTerminal })));
const DrumMachineTerminal = lazy(() => import('./components/DrumMachineTerminal').then(m => ({ default: m.DrumMachineTerminal })));
import { webRTCManager } from './utils/WebRTCManager';
import { storageGetJson } from './utils/storage';

// Rack-Reihenfolge laut Designvorlage (masterplayer + mixer-Hardware sind feste Sektionen).
const RACK_ORDER = [
  'mixer', 'drop', 'instrument', 'synthesizer', 'voice', 'sound', 'mcp', 'drum', 'sampler',
  'controller', 'effect', 'library', 'stem', 'spatial', 'eq', 'dsp', 'mastering',
  'recording', 'performance', 'ai',
];


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
  const [monitorMode, setMonitorMode] = useState<'MAIN' | 'MON' | 'PLUGIN'>('MAIN');
  const [monitorUser, setMonitorUser] = useState<'MON1' | 'MON2' | 'MON3' | 'MON4'>('MON1');
  const [sessionMembers, setSessionMembers] = useState(0);
  const [sessionFull, setSessionFull] = useState(false);

  // Eine feste Session pro App-Sitzung: Full-Mesh-Peers live im Header anzeigen.
  // P4-1/P4-2: Host sendet Master-Stream an Peers/SFU; Gäste spielen Main ab.
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
    if (webRTCManager.isHost) startHostMain();
    webRTCManager.onSessionUpdate = (info) => {
      setSessionMembers(info.members.length);
      setSessionFull(info.full);
      if (webRTCManager.isHost) startHostMain();
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
      {/* 1. Header: STICKY, Logo schwarz, Titel-4-Farben, Steuerung rechts */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-8 short-landscape:mb-3 sticky top-0 z-30 -mx-6 short-landscape:-mx-2 px-6 short-landscape:px-3 py-4 short-landscape:py-2 bg-black/70 backdrop-blur-xl [box-shadow:0_1px_0_rgba(34,211,238,0.06),0_20px_40px_-24px_rgba(0,0,0,0.9)]">
        <div className="flex items-center gap-3 shrink-0">
          <div className="relative shrink-0">
            <div className="absolute -inset-1 rounded-xl bg-cyan-400/15 blur-lg" />
            <div className="relative overflow-hidden rounded-lg ring-1 ring-cyan-400/15">
              <Logo size={38} rounded={false} />
            </div>
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tight text-transparent bg-clip-text bg-linear-to-r from-cyan-300 via-teal-200 to-fuchsia-400 leading-none">
                AUDIO MONASTRY
            </h1>
            <p className="text-[9px] text-neutral-500 font-mono tracking-[0.3em] uppercase mt-1">4-Person Studio</p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <div
            className={`hidden md:flex items-center gap-2 px-3 py-2 rounded-full border text-[9px] font-mono tracking-widest ${
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
          <div className="relative">
            <select
              value={monitorMode}
              onChange={(e) => {
                const mode = e.target.value as 'MAIN' | 'MON' | 'PLUGIN';
                setMonitorMode(mode);
                const activeId = Object.entries(moduleStates).find(([, s]) => s === 'PRO')?.[0]
                  ?? getPluginRegistry().find(p => (moduleStates[p.id] && moduleStates[p.id] !== 'OFF'))?.id
                  ?? 'mixer';
                audioEngine.setMonitorSource(mode, monitorUser, getPluginRoute(activeId)?.channels[0] ?? 'channel1');
              }}
              className="appearance-none pl-3 pr-8 py-2 rounded-full bg-neutral-900/80 border border-neutral-800 text-neutral-300 text-xs hover:border-cyan-500/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 transition-colors cursor-pointer"
              title="Monitor-Quelle: MAIN / eigener User-Mix / aktuelles Plugin"
              aria-label="Monitor-Quelle wählen"
            >
              <option value="MAIN">🎧 MAIN</option>
              <option value="MON">🎧 USER-MIX</option>
              <option value="PLUGIN">🎧 PLUGIN</option>
            </select>
          </div>
          {monitorMode === 'MON' && (
            <div className="relative">
              <select
                value={monitorUser}
                onChange={(e) => {
                  const mon = e.target.value as 'MON1' | 'MON2' | 'MON3' | 'MON4';
                  setMonitorUser(mon);
                  audioEngine.setMonitorSource('MON', mon);
                }}
                className="appearance-none pl-3 pr-6 py-2 rounded-full bg-neutral-900/80 border border-neutral-800 text-neutral-300 text-[10px] font-mono hover:border-cyan-500/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 transition-colors cursor-pointer"
                title="Eigener Monitor-Bus (User 1-4)"
                aria-label="Monitor-Bus wählen"
              >
                <option value="MON1">USER 1</option>
                <option value="MON2">USER 2</option>
                <option value="MON3">USER 3</option>
                <option value="MON4">USER 4</option>
              </select>
            </div>
          )}
          <div className="relative">
            <select
              defaultValue=""
              onChange={e => e.target.value && applyRole(e.target.value as StudioRole)}
              className="appearance-none pl-3 pr-8 py-2 rounded-full bg-neutral-900/80 border border-neutral-800 text-neutral-300 text-xs hover:border-fuchsia-500/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 transition-colors cursor-pointer"
              title="Rollen-Startprofil wählen"
              aria-label="Rollen-Startprofil wählen"
            >
              <option value="" disabled>Rolle</option>
              {ROLE_PRESETS.map(r => (
                <option key={r.role} value={r.role}>{r.role.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
          <Scratchpad />
          <MasterStreamToggle />
          <button type="button"
            onClick={() => setSettingsOpen(true)}
            className="p-2.5 rounded-full bg-neutral-900/80 border border-neutral-800 text-neutral-400 hover:text-cyan-300 hover:border-cyan-400/50 hover:bg-cyan-400/5 transition-all duration-200 active:scale-95 cursor-pointer"
            title="Audio / I-O Einstellungen"
            aria-label="Audio / I-O Einstellungen öffnen"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Rack: masterplayerMONK (fester Transport, immer sichtbar) */}
      <section className="rounded-xl border border-cyan-400/60 bg-cyan-950/10 shadow-[0_0_24px_-8px_rgba(34,211,238,0.45)] mb-4">
        <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
          <div className="w-10 h-10 shrink-0 rounded-lg border border-cyan-400/70 bg-cyan-900/40 text-cyan-300 flex items-center justify-center shadow-[0_0_12px_rgba(34,211,238,0.35)]">
            <Activity size={18} />
          </div>
          <h3 className="text-sm font-black tracking-[0.25em] uppercase text-neutral-100">masterplayerMONK</h3>
          <span className={`font-mono text-lg font-bold tracking-tight ${isPlaying ? 'text-cyan-300' : 'text-neutral-600'}`}>
            {isPlaying ? <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 animate-pulse mr-1" /> : null}
            {bpm} BPM
          </span>
          <span className="text-[9px] font-mono tracking-widest text-neutral-400 border border-white/10 rounded px-2 py-0.5">
            KEY {TECHNO_PRESETS[0]?.key ?? '—'}
          </span>
          <span className="text-[9px] font-mono tracking-widest text-neutral-400 border border-white/10 rounded px-2 py-0.5">
            4/4 · SOUND MAIN
          </span>
        </div>
        <div className="px-3 pb-3 border-t border-white/5">
          <BeatVisualizer isPlaying={isPlaying} />
          <div className="mt-4 pt-4 border-t border-neutral-800/80">
            <Suspense fallback={<div className="h-12 text-neutral-500 text-xs">Lade Master-Player…</div>}><MasterPlayerTerminal /></Suspense>
          </div>
        </div>
      </section>

      {/* Rack: mixerMONK (festes DJ-Mischpult, immer sichtbar) */}
      <section className="rounded-xl border border-cyan-400/60 bg-cyan-950/10 shadow-[0_0_24px_-8px_rgba(34,211,238,0.45)] mb-4">
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="w-10 h-10 shrink-0 rounded-lg border border-cyan-400/70 bg-cyan-900/40 text-cyan-300 flex items-center justify-center shadow-[0_0_12px_rgba(34,211,238,0.35)]">
            <Sliders size={18} />
          </div>
          <h3 className="text-sm font-black tracking-[0.25em] uppercase text-neutral-100">mixerMONK</h3>
          <span className="text-[9px] font-mono text-cyan-400 tracking-widest">HARDWARE · DJM-A9</span>
        </div>
        <div className="px-3 pb-3 border-t border-white/5">
          <Suspense fallback={<div className="h-24 flex items-center justify-center text-neutral-500 text-xs">Lade DJ-Mixer…</div>}><DJMixer /></Suspense>
        </div>
      </section>

      {/* Icon-Toolbar (Designvorlage: Modul-Kacheln) */}
      <nav className="md:sticky md:top-[76px] z-20 -mx-6 short-landscape:-mx-2 px-6 py-2 bg-black/70 backdrop-blur border-y border-white/5 mb-4" aria-label="Plugin-Toolbar">
        <div className="flex flex-wrap gap-2 justify-center max-w-screen-2xl mx-auto">
        {getPluginRegistry().filter(plugin => plugin.id !== 'masterplayer' && (FEATURE_FLAGS.AI_MONK_DOCK_ENABLED ? plugin.id !== 'ai' : true)).map(plugin => {
          const state = moduleStates[plugin.id] || 'OFF';
          const isActive = state !== 'OFF';

          return (
            <PluginButton
              key={plugin.id}
              id={plugin.id}
              icon={plugin.icon}
              short={plugin.short}
              isActive={isActive}
              state={state}
              onClick={() => togglePlugin(plugin.id)}
              onDoubleClick={() => promotePlugin(plugin.id)}
            />
          );
        })}
      </div>
      </nav>

      {/* Rack-Liste: alle Module als Streifen */}
      <div className="flex flex-col gap-3 max-w-screen-xl mx-auto">
        {RACK_ORDER.map(id => {
          const plugin = getPluginRegistry().find(p => p.id === id);
          if (!plugin) return null;
          if (id === 'ai' && FEATURE_FLAGS.AI_MONK_DOCK_ENABLED) return null;
          const state = moduleStates[id] || 'OFF';
          const lockStatus = pluginLocks[id];
          const lockedByOther = !!lockStatus?.active && lockStatus.lockedBy !== 'localUser';
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
                  void navigator.clipboard?.writeText(JSON.stringify({
                    pluginId: id,
                    name: plugin.name,
                    state: moduleStates[id] || 'OFF',
                    ts: Date.now(),
                  }, null, 2));
                } catch { /* Clipboard nicht verfügbar */ }
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

      {/* D7: aiMONK-Bottom-Dock (immer offen, ausblendbar) – ersetzt das
          „letzte Modul unten" für alle User. */}
      {FEATURE_FLAGS.AI_MONK_DOCK_ENABLED && <AiMonkDock />}

      {/* Settings / Audio-I/O */}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
