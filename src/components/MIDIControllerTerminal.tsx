import React, { useState, useEffect, useMemo } from 'react';
import { random } from '../utils/random';
import { Keyboard, Activity, Link2, RefreshCw, Cpu, Usb, Volume2 } from 'lucide-react';
import { AudioSample } from '../data/samples';
import { usePluginState } from '../hooks/usePluginState';
import { useMIDI } from '../hooks/useMIDI';
import { useHID } from '../hooks/useHID';
import { audioEngine } from '../utils/audioEngine';
import { MoaAssistant } from './MoaAssistant';
import { audioDeviceManager, ManagedOutputDevice } from '../utils/audioDeviceManager';
import { SkinEngine } from './midi/SkinEngine';
import { MappingLearnPanel } from './midi/MappingLearnPanel';
import { MidiDeviceType } from '../config/midiDevices';
import { useControlHub } from '../hooks/useControlHub';
import { applyMappedParameter } from '../hooks/useMappingApply';
import { mappingStore } from '../core/mapping/MappingStore';

/**
 * audioMONASTRY Hardware-Dashboard (controllerMONK)
 * =================================================
 * Ein Terminal für die angebundenen Controller & Interfaces:
 * - MIDI-Geräte        (Web MIDI, hotplug-fähig)
 * - USB-Interfaces     (WebHID, hotplug-fähig, koppelbar)
 * - Soundkarten        (Audio-I/O via enumerateDevices + setSinkId)
 */

/** iOS/iPadOS-Safari erkennt Web MIDI/WebHID nicht – Feature-Detect ausgelagert. */
function detectTouchLimited(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
  const midiCapable = 'requestMIDIAccess' in navigator;
  const hidCapable = 'hid' in navigator;
  return !midiCapable && !hidCapable;
}

export const MIDIControllerTerminal = React.memo(function MIDIControllerTerminal() {
  const { state, lockStatus, updateState } = usePluginState('midi', 'PRO');
  const {
    midiAccess, inputs, detected, error: midiError, rescan, lastMessage,
    lastControlEvent: midiLastControlEvent,
  } = useMIDI();
  const { devices: hidDevices, error: hidError, supported: hidSupported, requestDevice: pairHid } = useHID();
  const { status: hubStatus, lastEvent: hubLastEvent, busy: hubBusy, connect: hubConnect, disconnect: hubDisconnect } = useControlHub();

  const [activeProfile, setActiveProfile] = useState('APC40');
  const [soundOutputs, setSoundOutputs] = useState<ManagedOutputDevice[]>([]);
  const [activeOutput, setActiveOutput] = useState('');
  const [padMappings] = useState<Record<number, AudioSample>>({});

  const isConnected = !!midiAccess && inputs.length > 0;

  // Unified Learn-Event: MIDI-Hook (primär) oder ControlHub (HID/OSC-Adjapter).
  const learnEvent = midiLastControlEvent ?? hubLastEvent;

  // Mapping-Engine anwenden: transportagnostische Regeln → Audio-Parameter.
  useEffect(() => {
    if (!learnEvent) return;
    const mapped = mappingStore.engineRef.map(learnEvent);
    for (const m of mapped) applyMappedParameter(m.target, m.value01);
  }, [learnEvent]);


  // Soundkarten einmalig (und nach jedem Rescan) einlesen; devicechange-
  // Monitoring hält die Liste bei Hot-Plug aktuell.
  const refreshSoundCards = () => {
    audioDeviceManager.refresh().then((devs) => setSoundOutputs(devs)).catch(() => { /* keine Hardware */ });
  };
  useEffect(() => {
    refreshSoundCards();
    audioDeviceManager.startMonitoring();
    const off = audioDeviceManager.onDeviceChange(() => refreshSoundCards());
    return () => {
      off();
      audioDeviceManager.stopMonitoring();
    };
  }, []);

  const applyOutput = async (deviceId: string) => {
    setActiveOutput(deviceId);
    await audioDeviceManager.applyOutput(deviceId);
  };

  // AUTO-ERKENNUNG: Sobald ein MIDI-Gerät mit bekanntem Profil erkannt wird,
  // aktiviere automatisch das passende Profil (Plug-and-Play).
  useEffect(() => {
    if (detected.length === 0) return;
    const known = detected.find(d => d.profile !== 'UNKNOWN');
    if (known) setActiveProfile(known.profile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected]);

  // MIDI-Nachrichten → AudioEngine.
  useEffect(() => {
    if (!lastMessage?.data || lastMessage.data.length < 3) return;

    const [status, note, velocity] = lastMessage.data;
    if (typeof status !== 'number' || typeof note !== 'number' || typeof velocity !== 'number') return;

    const messageType = status & 0xF0;

    // Note On (0x90 = 144)
    if (messageType === 0x90 && velocity > 0) {
      const padIndex = note % 40;
      const sample = padMappings[padIndex];
      if (sample?.url) {
        audioEngine.previewSample('channel5', undefined, sample.url);
      }
    }
    // Control Change (0xB0 = 176) – Fader/Knobs
    else if (messageType === 0xB0) {
      audioEngine.setWorkletParam(`cc_${note}`, velocity / 127);
    }
  }, [lastMessage, padMappings]);

  // Mappe Profil-ID → Gerätetyp für die generische Skin-Engine.
  const profileType = (id: string): MidiDeviceType =>
    id.includes('DDJ') || id.includes('REV') || id.includes('TRAKTOR') || id.includes('INPULSE') || id.includes('DENON') ? 'DJ'
    : id === 'MPC' || id === 'Maschine' ? 'MPC'
    : id === 'MPD' ? 'PAD'
    : id === 'KEYBOARD' ? 'KEYBOARD'
    : 'GRID';

  const profiles = [
    { id: 'APC40', name: 'AKAI APC40 MKII', type: 'Grid- & Clip-Launcher' },
    { id: 'PUSH2', name: 'ABLETON PUSH 2', type: 'Grid- & Clip-Launcher' },
    { id: 'LAUNCHPAD', name: 'NOVATION LAUNCHPAD', type: 'Grid- & Clip-Launcher' },
    { id: 'DDJ', name: 'PIONEER DDJ-Serie', type: 'DJ-Controller' },
    { id: 'REV', name: 'PIONEER DDJ-REV', type: 'DJ-Controller' },
    { id: 'TRAKTOR', name: 'NI TRAKTOR KONTROL', type: 'DJ-Controller' },
    { id: 'INPULSE', name: 'HERCULES INPULSE', type: 'DJ-Controller' },
    { id: 'DENON', name: 'DENON DJ PRIME', type: 'DJ-Controller' },
    { id: 'MPC', name: 'AKAI MPC-Serie', type: 'Finger-Drumming & Pads' },
    { id: 'MASCHINE', name: 'NI MASCHINE', type: 'Finger-Drumming & Pads' },
    { id: 'MPD', name: 'AKAI MPD-Serie', type: 'Finger-Drumming & Pads' },
    { id: 'KEYBOARD', name: 'Keyboard-Controller', type: 'Melodie & Synthese' },
    { id: 'DAW', name: 'DAW/Mixer-Controller', type: 'Automation & Mixing' },
  ];

  const groupedProfiles = useMemo(() => profiles.reduce((acc: any, p) => {
    if (!acc[p.type]) acc[p.type] = [];
    acc[p.type].push(p);
    return acc;
  }, {}), []);

  const hardwareTotal = inputs.length + hidDevices.length + soundOutputs.length;

  // iOS/iPadOS-Safari unterstützt weder Web MIDI noch WebHID – freundlich
  // darauf hinweisen, damit Touch-Nutzer nicht ratlos vor leeren Listen sitzen.
  const isTouchLimited = detectTouchLimited();

  return (
    <div className={`w-full h-full flex flex-col bg-[#111] rounded-xl border ${lockStatus.active ? 'border-red-500' : 'border-neutral-800'} overflow-hidden text-neutral-300 font-sans shadow-2xl relative ${lockStatus.active && lockStatus.lockedBy !== 'localUser' ? 'opacity-50 grayscale' : ''}`}>
      <div className="px-6 py-2 border-b border-neutral-800 bg-black/20">
        <MoaAssistant pluginId="controller" placeholder="MOA: z. B. 'Controller neu scannen'" onActivity={(active) => updateState(active ? 'AUTO_AI' : state)} autoMode={state === 'AUTO_AI'} />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-linear-to-r from-pink-900/20 to-[#111] border-b border-pink-900/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-pink-500/20 flex items-center justify-center border border-pink-500/50 shadow-[0_0_15px_rgba(236,72,153,0.3)]">
            <Keyboard className="w-5 h-5 text-pink-400" />
          </div>
          <div>
            <h2 className="text-xl font-black tracking-widest text-neutral-100 uppercase flex items-center gap-2">
              HARDWARE <span className="text-[10px] font-mono text-pink-400 border border-pink-500/30 px-2 py-0.5 rounded-sm">MIDI · USB · AUDIO</span>
            </h2>
          </div>
        </div>

        <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
        </select>

        <div className={`px-4 py-2 rounded border flex items-center gap-2 text-xs font-bold tracking-widest ${hardwareTotal > 0 ? 'bg-emerald-900/20 border-emerald-500/50 text-emerald-400' : 'bg-red-900/20 border-red-500/50 text-red-400'}`}>
          {hardwareTotal > 0 ? <Link2 className="w-4 h-4" /> : <Activity className="w-4 h-4" />}
          {hardwareTotal > 0 ? `${hardwareTotal} GERÄTE · ${inputs.length} MIDI / ${hidDevices.length} USB / ${soundOutputs.length} OUT` : 'DISCONNECTED'}
        </div>
      </div>

      {isTouchLimited && (
        <div className="mx-4 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[10px] font-mono text-amber-300 leading-relaxed">
          Auf diesem Gerät (iOS/Tablet) sind <b>Web MIDI & WebHID nicht verfügbar</b> – die
          Controller- und USB-Kopplung nutzt du am Linux-Laptop (Chromium/Firefox).
          Die Soundkarten-Auswahl funktioniert hier eingeschränkt.
        </div>
      )}

      <div className="flex-1 flex overflow-hidden p-6 short-landscape:p-3 gap-6 short-landscape:gap-3">

        {/* Left: Live-Hardware + Profile */}
        <div className="w-2/5 flex flex-col gap-4 overflow-y-auto pr-1">
           <h3 className="font-bold text-sm tracking-widest uppercase text-neutral-400 flex items-center gap-2">
             <Cpu className="w-4 h-4 text-pink-500" /> LIVE HARDWARE
           </h3>

           {/* MIDI */}
           <details open className="rounded-lg border border-neutral-800 bg-black/40 p-3">
             <summary className="cursor-pointer text-[10px] font-mono text-neutral-400 uppercase tracking-widest flex items-center justify-between">
               <span>🎹 MIDI-Geräte ({inputs.length})</span>
               <span className="text-pink-400">Web MIDI</span>
             </summary>
             <div className="mt-2 space-y-1.5">
               {detected.length === 0 ? (
                 <div className="text-[10px] text-neutral-600 font-mono">Keine MIDI-Geräte verbunden …</div>
               ) : detected.map((d) => (
                 <div key={d.id} className="flex items-center gap-2 text-[10px]">
                   <span className={`w-1.5 h-1.5 rounded-full ${d.profile !== 'UNKNOWN' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                   <span className="text-neutral-300 truncate">{d.name}</span>
                   <span className={`ml-auto font-mono text-[8px] px-1.5 py-0.5 rounded border ${d.profile !== 'UNKNOWN' ? 'text-emerald-400 border-emerald-500/40' : 'text-amber-400 border-amber-500/40'}`}>{d.profile}</span>
                 </div>
               ))}
               {midiError && <div className="mt-2 text-[9px] font-mono text-red-400 leading-snug">{midiError}</div>}
             </div>
           </details>

           {/* USB / HID */}
           <details className="rounded-lg border border-neutral-800 bg-black/40 p-3">
             <summary className="cursor-pointer text-[10px] font-mono text-neutral-400 uppercase tracking-widest flex items-center justify-between">
               <span className="flex items-center gap-1"><Usb className="w-3 h-3" /> USB-Interfaces ({hidDevices.length})</span>
               <span className="text-cyan-400">WebHID</span>
             </summary>
             <div className="mt-2 space-y-1.5">
               {!hidSupported ? (
                 <div className="text-[10px] text-neutral-600 font-mono">WebHID nicht verfügbar (Chromium-Browser nötig).</div>
               ) : hidDevices.length === 0 ? (
                 <div className="text-[10px] text-neutral-600 font-mono">Keine USB/HID-Geräte gekoppelt.</div>
               ) : hidDevices.map((d, i) => (
                 <div key={i} className="flex items-center gap-2 text-[10px]">
                   <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                   <span className="text-neutral-300 truncate">{d.productName || 'USB-Gerät'}</span>
                   {d.vendorId !== undefined && (
                     <span className="ml-auto font-mono text-[8px] text-neutral-500">VID {d.vendorId.toString(16).toUpperCase()} · PID {d.productId?.toString(16).toUpperCase()}</span>
                   )}
                 </div>
               ))}
               {hidError && <div className="mt-2 text-[9px] font-mono text-red-400 leading-snug">{hidError}</div>}
               {hidSupported && (
                 <button type="button"
                   onClick={() => pairHid()}
                   className="mt-2 w-full py-1.5 rounded border border-cyan-500/40 bg-cyan-500/5 text-[9px] font-bold tracking-widest text-cyan-300 hover:bg-cyan-500/15 cursor-pointer"
                 >+ USB-GERÄT KOPPELN</button>
               )}
             </div>
           </details>

           {/* Soundkarten */}
           <details className="rounded-lg border border-neutral-800 bg-black/40 p-3">
             <summary className="cursor-pointer text-[10px] font-mono text-neutral-400 uppercase tracking-widest flex items-center justify-between">
               <span className="flex items-center gap-1"><Volume2 className="w-3 h-3" /> Soundkarten ({soundOutputs.length})</span>
               <span className="text-amber-400">Audio I/O</span>
             </summary>
             <div className="mt-2 space-y-1.5">
               {soundOutputs.length === 0 ? (
                 <div className="text-[10px] text-neutral-600 font-mono">Keine Ausgabegeräte gefunden …</div>
               ) : (
                 <>
                   <select
                     value={activeOutput}
                     onChange={(e) => applyOutput(e.target.value)}
                     className="w-full bg-neutral-800 text-[10px] text-white p-1.5 rounded border border-neutral-700"
                   >
                     <option value="">Browser-Standard</option>
                     {soundOutputs.map((d) => (
                       <option key={d.deviceId} value={d.deviceId}>
                         {d.label}{d.isXonar ? ' · XONAR U7 (8CH)' : ''}
                       </option>
                     ))}
                   </select>
                   {soundOutputs.filter((d) => d.isXonar).length > 0 && (
                     <div className="text-[9px] font-mono text-lime-400 leading-snug">
                       ✓ {soundOutputs.filter((d) => d.isXonar).length}× ASUS Xonar U7 (8 Kanäle je Gerät)
                     </div>
                   )}
                   <div className="text-[9px] font-mono text-neutral-500 leading-snug">
                     {(() => {
                       const h = audioEngine.getAudioHealth();
                       return `Engine ${h.state} · ${h.sampleRate || '—'} Hz · Lat ${h.baseLatencyMs.toFixed(1)} ms + ${h.outputLatencyMs.toFixed(1)} ms`;
                     })()}
                   </div>
                 </>
               )}
             </div>
           </details>

           <h3 className="font-bold text-sm tracking-widest uppercase text-neutral-400 flex items-center gap-2 mt-2">
             <Cpu className="w-4 h-4 text-pink-500" /> MAPPED HARDWARE
           </h3>

           <div className="space-y-4">
            {Object.entries(groupedProfiles).map(([type, items]) => (
                <div key={type}>
                    <h4 className="text-[10px] font-bold text-neutral-600 uppercase mb-2">{type}</h4>
                    <div className="space-y-2">
                        {(items as any[]).map(p => (
                            <button type="button"
                                key={p.id}
                                onClick={() => setActiveProfile(p.id)}
                                className={`w-full p-3 rounded-lg border text-left transition-all ${activeProfile === p.id ? 'bg-pink-900/20 border-pink-500/50 shadow-[0_0_10px_rgba(236,72,153,0.1)]' : 'bg-[#1a1a1a] border-neutral-800 hover:bg-[#222]'}`}
                            >
                                <span className={`text-sm font-black ${activeProfile === p.id ? 'text-pink-400' : 'text-neutral-300'}`}>{p.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
            ))}
           </div>

           <div className="space-y-3">
             <MappingLearnPanel lastEvent={learnEvent} />
             <details className="rounded-lg border border-neutral-800 bg-black/40 p-3">
               <summary className="cursor-pointer text-[10px] font-mono text-neutral-400 uppercase tracking-widest flex items-center justify-between">
                 <span>CONTROL BUS</span>
                 <span className="text-emerald-400">{hubStatus.filter((h) => h.connected).length}/{hubStatus.length} verbunden</span>
               </summary>
               <div className="mt-2 space-y-1.5">
                 {hubStatus.map((h) => (
                   <div key={h.adapterId} className="flex items-center gap-2 text-[10px]">
                     <span className={`w-1.5 h-1.5 rounded-full ${h.connected ? 'bg-emerald-400' : 'bg-neutral-600'}`} />
                     <span className="text-neutral-300 uppercase">{h.adapterId}</span>
                     <button type="button"
                       onClick={() => (h.connected ? hubDisconnect(h.adapterId) : void hubConnect(h.adapterId))}
                       disabled={hubBusy === h.adapterId}
                       className={`ml-auto px-2 py-0.5 rounded border text-[8px] font-bold tracking-widest ${
                         h.connected ? 'border-red-500/40 text-red-300 hover:bg-red-500/10' : 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                       } disabled:opacity-40`}
                     >
                       {hubBusy === h.adapterId ? '…' : h.connected ? 'TRENNEN' : 'VERBINDEN'}
                     </button>
                   </div>
                 ))}
                 <div className="text-[8px] text-neutral-600 leading-snug">
                   Verbindet die Referenz-Adapter (WebMIDI/HID/OSC) mit dem ControlHub. Events fließen in Mapping-Learn und -Engine.
                 </div>
               </div>
             </details>
             <button type="button"
               onClick={() => { rescan(); refreshSoundCards(); }}
               className="w-full py-3 bg-[#222] hover:bg-[#333] border border-neutral-700 rounded text-xs font-bold tracking-widest text-neutral-400 flex items-center justify-center gap-2 transition-colors cursor-pointer"
             >
               <RefreshCw className="w-4 h-4" /> ALLE PORTS RESCANNEN
             </button>
           </div>
        </div>

        {/* Right: Hardware Mirror */}
        <div className="flex-1 bg-[#1a1a1a] rounded-xl border border-neutral-800 p-6 shadow-inner flex flex-col relative overflow-hidden">

           <div className="absolute top-4 right-4 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-pink-500 animate-pulse"></div>
              <span className="text-[10px] font-mono text-pink-500">MIDI IN/OUT · RX/TX</span>
           </div>

           {/* Parametrischer Canvas-Skin des erkannten Profils (Plug-and-Play) */}
           <div className="flex-1 flex flex-col justify-center gap-4">
             {(() => {
               const padMap: Record<number, boolean> = {};
               const padCol: Record<number, string> = {};
               Object.entries(padMappings).forEach(([k, sample]) => {
                 const n = Number(k);
                 padMap[n] = true;
                 padCol[n] = sample ? '#f472b6' : '#9f7aea';
               });
               return (
                 <SkinEngine
                   type={profileType(activeProfile)}
                   cols={8}
                   rows={5}
                   state={{
                     pads: padMap,
                     padColors: padCol,
                     encoders: Array.from({ length: 8 }, (_, _i) => random()),
                     faders: Array.from({ length: 8 }, (_, _i) => random()),
                     label: activeProfile,
                   }}
                 />
               );
             })()}

             <div className="text-center text-[10px] font-mono text-neutral-500 space-y-1">
               <div>
                 Profil: <span className="text-pink-400">{activeProfile}</span> · Drag & Drop Samples auf die Pads
               </div>
             </div>
           </div>
        </div>

      </div>
    </div>
  );
});
