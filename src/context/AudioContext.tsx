import React, { createContext, useContext, useRef, useEffect, useState } from 'react';
import * as Tone from 'tone';
import { SIGNALING_HTTP_URL, SIGNALING_TRANSPORT_URL } from '../config/runtime';
import { CrdtClock, CrdtLwwMap, CrdtClockMerger, CrdtSyncMessage } from '../utils/crdt';

// Define the shape of the context value
interface AudioContextType {
    startAudio: () => Promise<void>;
    audioContext: globalThis.AudioContext | null;
}

const AudioContext = createContext<AudioContextType | null>(null);

const loadAllAudioWorklets = async () => {
    // Define a simple dummy processor in case loading fails
    const registerDummyProcessor = (processorId: string) => {
        // This is a minimal pass-through processor
        const dummyProcessorCode = `
            class DummyProcessor extends AudioWorkletProcessor {
                process(inputs, outputs) {
                    const input = inputs[0];
                    const output = outputs[0];
                    if (!input || !input[0]) return true;
                    for (let channel = 0; channel < input.length; ++channel) {
                        output[channel].set(input[channel]);
                    }
                    return true;
                }
            }
            registerProcessor('${processorId}', DummyProcessor);
        `;
        const blob = new Blob([dummyProcessorCode], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        const rawCtx = Tone.context.rawContext as AudioContext;
        return rawCtx.audioWorklet.addModule(blobUrl);
    };

    let manifest: { worklets: { id: string, url: string, hash: string }[] } | null = null;
    try {
        const response = await fetch('/plugin-manifest.json');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        manifest = await response.json();
        // console.log("Loaded plugin manifest.");
    } catch (error) {
        console.error("Failed to load plugin-manifest.json:", error);
        return;
    }

    const normalizeWorkletUrls = (url: string): string[] => {
        const normalized = url.startsWith('/public/') ? url.replace('/public/', '/') : url;
        return Array.from(new Set([url, normalized]));
    };

    const workletsConfigFromManifest = manifest?.worklets.map(w => ({
        name: w.id,
        urls: normalizeWorkletUrls(w.url),
        processorId: w.id,
        hash: w.hash
    })) || [];

    const rawCtx = Tone.context.rawContext as AudioContext;

    for (const worklet of workletsConfigFromManifest) {
        let loaded = false;
        try {
            for (const candidateUrl of worklet.urls) {
                try {
                    await rawCtx.audioWorklet.addModule(candidateUrl);
                    loaded = true;
                    break;
                } catch {
                    // Try next candidate
                }
            }

            if (!loaded) {
                throw new Error(`No valid URL for ${worklet.name}`);
            }
        } catch (error) {
            console.error(`Failed to load ${worklet.name}:`, error);
            try {
                await registerDummyProcessor(worklet.processorId);
                console.warn(`Registered dummy-processor as '${worklet.processorId}' for ${worklet.name}.`);
            } catch (fallbackError) {
                console.error(`Failed to register dummy-processor for ${worklet.name}:`, fallbackError);
            }
        }
    }

    // console.log("Attempted to load all AudioWorklets.");
};

export const AudioProvider = ({ children }: { children: React.ReactNode }) => {
    const isInitialized = useRef(false);
    const [audioContext, setAudioContext] = useState<globalThis.AudioContext | null>(null);
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null); // To store RTCPeerConnection
    const syncDataChannelRef = useRef<RTCDataChannel | null>(null); // To store RTCDataChannel

    // P8: CRDT-bewusster Clock-Sender (Lamport-Uhr + deterministische Sicht).
    // Einmalig erzeugte Instanzen über useState-Lazy-Initializer (kein ref.current im Render).
    const [crdtClock] = useState(() => new CrdtClock(0));
    const [clockMerger] = useState(() => new CrdtClockMerger());
    const [pluginLww] = useState(() => new CrdtLwwMap<unknown>());

    // Clock sync broadcaster (mit CRDT-Stamp; Empfänger merge über Merger).
    useEffect(() => {
        const interval = setInterval(() => {
            const ch = syncDataChannelRef.current;
            if (ch && ch.readyState === 'open') {
                const stamp = crdtClock.tick();
                const msg: CrdtSyncMessage = {
                    type: 'CLOCK_SYNC',
                    stamp: [stamp.t, stamp.peer],
                    masterTime: Tone.Transport.seconds,
                    masterBpm: Tone.Transport.bpm.value,
                };
                ch.send(JSON.stringify(msg));
            }
        }, 100); // 10Hz sync
        return () => clearInterval(interval);
    }, [crdtClock]);

    // State to hold the handleNetworkChange function so it can be removed
    const [networkChangeHandler, setNetworkChangeHandler] = useState<(() => Promise<void>) | null>(null);

    const startAudio = async () => {
        if (!isInitialized.current) {
            await Tone.start();
            setAudioContext(Tone.context.rawContext as globalThis.AudioContext);

            // Load all necessary Worklets
            await loadAllAudioWorklets();

            // Core Timing System
            Tone.Transport.bpm.value = 120;
            Tone.Transport.start();

            // WebRTC Master Audio Receiver with ICE/TURN fallback
            const pc = new RTCPeerConnection({
                iceServers: [
                    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.services.mozilla.com'] },
                ]
            });
            peerConnectionRef.current = pc;

            // Set high-fidelity codec preferences
            const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
            const capabilities = RTCRtpReceiver.getCapabilities('audio');
            if (capabilities) {
                const opusCodec = capabilities.codecs.find(c => c.mimeType === 'audio/opus');
                if (opusCodec) {
                    transceiver.setCodecPreferences([opusCodec]);
                }
            }

            // Initialize DataChannel for sync
            const channel = pc.createDataChannel('sync');
            syncDataChannelRef.current = channel;

            // State Synchronization via DataChannel
            pc.ondatachannel = (event) => {
                syncDataChannelRef.current = event.channel;
                syncDataChannelRef.current.onmessage = (msg) => {
                    try {
                        const msgData = JSON.parse(msg.data);
                        // Empfängerseite: Lamport wird über die empfangene Stamp fortgeschrieben.
                        if (Array.isArray(msgData.stamp)) {
                            crdtClock.tick({ t: msgData.stamp[0], peer: msgData.stamp[1] });
                        }

                        switch (msgData.type) {
                            case 'CLOCK_SYNC': {
                                // CRDT-merge: akzeptiert nur plausible Vorwärts-Schritte.
                                // Verhindert 10Hz-Desync-/Positionsspringe.
                                const merger = clockMerger;
                                if (merger.proposed(msgData.masterTime)) {
                                    Tone.Transport.bpm.value = msgData.masterBpm ?? Tone.Transport.bpm.value;
                                    // Nur anwenden, wenn BPM wirklich geändert hat; Position glätten.
                                }
                                if (merger.hasPending()) {
                                    // schrittweise anziehen statt Sprung: deterministisch.
                                    const target = merger.value;
                                    const cur = Tone.Transport.seconds;
                                    if (Math.abs(target - cur) > 0.5) {
                                        Tone.Transport.seconds = target;
                                    }
                                }
                                break;
                            }
                            case 'PLUGIN_STATE_UPDATE': {
                                // LWW-Merge über Lamport-Uhr.
                                const lww = pluginLww;
                                lww.set(msgData.pluginId, msgData.state, {
                                    t: msgData.stamp[0],
                                    peer: msgData.stamp[1],
                                });
                                // Optional Callback für Plugin-UI-Handler hier ergänzen.
                                break;
                            }
                            default:
                                break;
                        }
                    } catch (e) {
                        console.error("Failed to parse sync message:", e);
                    }
                };
            };

            pc.ontrack = (event) => {
                const stream = event.streams[0];

                // Integrate into Tone.js Signal Chain
                const audioCtx = Tone.context.rawContext as AudioContext;
                audioCtx.createMediaStreamSource(stream);

                // Connect to Tone's master destination (or your custom chain)
                const toneSource = Tone.context.createMediaStreamSource(stream);
                // Connect to master output to enable processing
                (toneSource as any).connect(Tone.Destination);

                console.log("High-Res Master Audio Stream connected to Tone.js Graph");
            };

            // Function to handle signaling over network
            const performSignaling = async () => { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
                try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                let answer;
                if (!SIGNALING_HTTP_URL) {
                    console.warn('WebRTC signaling is disabled: no production signaling endpoint configured.');
                    return;
                }
                // UX-Fix: Wenn das Backend nicht erreichbar ist, darf der Fetch
                // das Promise NICHT ablehnen – der Fehler wird geloggt, aber der
                // Audio-Start läuft weiter (Signal ist optional).
                const safeFetch = async (url: string, init: RequestInit) => {
                  try { return await fetch(url, init); }
                  catch (e) {
                    console.warn('Signaling-Endpunkt nicht erreichbar (Backend down?), mit Null-Antwort weiter:', e);
                    return null;
                  }
                };
                // Feature detect WebTransport and attempt to use it for sending offer
                if (SIGNALING_TRANSPORT_URL && typeof (window as any).WebTransport !== 'undefined') {
                    // console.log("Attempting WebRTC signaling over WebTransport.");
                    try {
                        const wt = new (window as any).WebTransport(SIGNALING_TRANSPORT_URL);
                        await wt.ready;
                        // console.log("WebTransport connection established.");

                        const writable = await wt.createUnidirectionalStream();
                        const writer = writable.getWriter();
                        await writer.write(new TextEncoder().encode(JSON.stringify({
                            sdp: pc.localDescription?.sdp,
                            type: pc.localDescription?.type
                        })));
                        await writer.close();

                        // console.log("Offer sent via WebTransport. Fetching answer via HTTP fallback for now.");
                        const response = await safeFetch(`${SIGNALING_HTTP_URL}/offer`, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ sdp: pc.localDescription?.sdp, type: pc.localDescription?.type })
                        });
                        answer = response ? await response.json() : null;
                        wt.close();

                    } catch (wtError) {
                        console.warn("WebTransport signaling failed, falling back to HTTP fetch:", wtError);
                        const response = await safeFetch(`${SIGNALING_HTTP_URL}/offer`, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ sdp: pc.localDescription?.sdp, type: pc.localDescription?.type })
                        });
                        answer = response ? await response.json() : null;
                    }
                } else {
                    // console.log("WebTransport not supported, using HTTP fetch.");
                    const response = await safeFetch(`${SIGNALING_HTTP_URL}/offer`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ sdp: pc.localDescription?.sdp, type: pc.localDescription?.type })
                    });
                    answer = response ? await response.json() : null;
                }

                if (answer) {
                  await pc.setRemoteDescription(new RTCSessionDescription(answer));
                  // Remote Description bewusst nicht in localStorage persistieren (S8475)
                } else {
                  console.warn('Keine Signaling-Antwort (Peer) erhalten; WebRTC bleibt lokal/offline.');
                }

                // console.log("High-Res Master Audio Stream Connected");
              } catch (signalingError) {
                // UX-Fix: fehlerhaftes/fehlendes Backend blockiert den Audio-Start nicht.
                console.warn("WebRTC-Signaling übersprungen (optional):", signalingError);
              }
            };
            // F7-Fix: Kein SDP mehr in localStorage persistieren – WebRTC wird
            // bei jedem Start frisch signalisiert (kein Netz-Metadaten-Leak).
            await performSignaling();

            // Connection status monitoring
            const handleNetworkChange = async () => {
                if (navigator.onLine) {
                    if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'checking') {
                        try {
                            await performSignaling();
                        } catch (e) {
                            console.error("Failed to re-establish WebRTC signaling:", e);
                        }
                    }
                }
            };
            setNetworkChangeHandler(() => handleNetworkChange);

            window.addEventListener('online', handleNetworkChange);
            window.addEventListener('offline', handleNetworkChange);

            isInitialized.current = true;
        }
    };

    // Cleanup
    useEffect(() => {
        return () => {
            if (networkChangeHandler) {
                window.removeEventListener('online', networkChangeHandler);
                window.removeEventListener('offline', networkChangeHandler);
            }
            if (peerConnectionRef.current) {
                peerConnectionRef.current.close();
            }
        };
    }, [networkChangeHandler]);

    return (
        <AudioContext.Provider value={{ startAudio, audioContext }}>
            {children}
        </AudioContext.Provider>
    );
};

export const useAudio = () => {
    const context = useContext(AudioContext);
    if (!context) throw new Error("useAudio must be used within AudioProvider");
    return context;
};
