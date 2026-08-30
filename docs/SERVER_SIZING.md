# audioMONASTRY – Server-Sizing & Volllast-Simulation

Stand: 2026-08-30 · Version V. 1|001|420 „AnunnakiDNA"

Ziel: Welche Instanzen brauchen wir, um **alle 17 Module** unter Volllast
(4 User, KI aktiv, Stems, Mastering, Streaming, Cloud-Sync) stabil zu fahren –
und welche Rechenpower wird dafür benötigt?

---

## 1. Grundannahmen der Simulation

| Parameter | Wert |
|---|---|
| Gleichzeitige User | 4 (max. der Kollaborations-Architektur) |
| Aktive Module je User | 17 (alle Slots) |
| Echtzeit-Audio-DSP | läuft **im Browser** des Users (AudioWorklets) – belastet den Server nicht |
| KI-Nutzung (Spitzen) | 1 MOA-Planung/User/Min · 6 TTS/Song-Calls/User/h · 2 Stem-Jobs/User/h |
| Mastering | 2 Jobs/User/h (je ~60 s Audio) |
| Kollaboration | 4 WebRTC-DataChannels + 1 SFU-Audiostream je User |
| Cloud | Supabase (Metadaten) + Cloudflare R2 (Blobs) – extern, nicht selbst gehostet |

**Wichtig:** Der Server rendert **kein** Echtzeit-Audio. Die teuren DSP-Pfade
(10 AudioWorklets, Synthese, Spatial) laufen client-seitig in den Browsern.
Der Server liefert nur: API, KI-Inferenz, Stems, Mastering, Signaling, Storage.

---

## 2. Lastprofil je Modul (Volllast)

| Modul | Prozess | CPU-Spitze | RAM | GPU | Netz | Anmerkung |
|---|---|---|---|---|---|---|
| **App-Server** (Express + Vite/Statik + REST) | `server.ts` | 1 vCPU | 1,5 GB | – | 100 Mbit/s | API, Uploads, Proxys; leicht |
| **Socket.io-Signaling** | `server.ts` | 0,25 vCPU | 256 MB | – | 50 Mbit/s | 4 Peers, State-Sync |
| **SFU (Mediasoup)** | `server.ts` (ENABLE_SFU=1) | 0,5 vCPU | 512 MB | – | **80 Mbit/s** | 4×Opus-Uplink + Mix-Down |
| **MOA/LLM-Planung** | `/api/ai/complete` → DeepSeek/Groq/SambaNova (extern) | 0,1 vCPU | 128 MB | – | 2 Mbit/s | Server macht nur Proxy; Last liegt extern |
| **TTS/Song** | `/api/voice/*` → HF/Groq (extern) | 0,2 vCPU | 256 MB | – | 5 Mbit/s | Proxy + Audio-Durchreichung |
| **Stem-AI (Demucs)** | `services/stem-ai` | **4–8 vCPU** | **8–16 GB** | **empfohlen (CUDA)** | 20 Mbit/s | 1 Job = 4–8 s GPU / 30–90 s CPU bei 5 min Track |
| **Master-Player** | `services/master-player` (FFmpeg/Python) | 2 vCPU | 2 GB | – | 10 Mbit/s | Mix/Master/FFmpeg-Encoding |
| **Library-AI-Tagger** | `services/library-ai/tagger.py` | 0,5 vCPU | 512 MB | – | – | Batch-Tagging, selten |
| **Backend-Core** | `services/backend-core` (Node+Python+Celery) | 1 vCPU | 1 GB | – | – | MOA-Pipeline, Task-Queue |
| **Task-Worker** | `services/taskWorker.ts` | 0,5 vCPU | 512 MB | – | – | Hintergrund-Jobs |
| **Audio-Runtime (Rust)** | `services/audio-runtime` | 0,5 vCPU | 256 MB | – | – | Native DSP-Kette, optional |
| **Ollama (lokal, optional)** | `server.ts` → `ollamaGenerate` | **4 vCPU** oder **8 GB VRAM** | 8 GB | **empfohlen** | – | qwen2.5:7b; entfällt bei DeepSeek/Groq |
| **Postgres/Supabase** | Cloud (extern) | – | – | – | – | nicht selbst gehostet |
| **R2-Storage** | Cloud (extern) | – | – | – | – | nicht selbst gehostet |

---

## 3. Volllast-Simulation (4 User, alle Module aktiv)

### Szenario A – Spitzenstunde (KI + Audio-Jobs parallel)

| Last | Menge/h | CPU-Kerne | RAM | GPU | Netz |
|---|---|---|---|---|---|
| API/Statik/Signaling/SFU | dauerhaft | 1,5 | 2,5 GB | – | 130 Mbit/s |
| MOA-Planung (Proxy) | 240 | 0,2 | 0,3 GB | – | 5 Mbit/s |
| TTS/Song (Proxy) | 24 | 0,3 | 0,3 GB | – | 6 Mbit/s |
| Stem-Jobs (Demucs) | 8 | 6 (parallel 2) | 12 GB | 1×GPU (RTX 4000) | 40 Mbit/s |
| Mastering-Jobs | 8 | 2 | 2 GB | – | 10 Mbit/s |
| Tagger + Backend-Core + Worker | – | 2 | 2 GB | – | 5 Mbit/s |
| **Summe Spitze** | | **~12 vCPU** | **~19 GB** | **1 GPU (8–16 GB VRAM)** | **~200 Mbit/s** |

**Fazit Spitze:** Ein einzelner **8-vCPU/32-GB-Server ohne GPU** würde die
Stem-Jobs nur langsam (CPU-Demucs) schaffen und wäre am Limit. Sauberer ist
die Trennung: **1 GPU-KI-Knoten** + **1 App-Knoten** + **1 SFU-Knoten**.

### Szenario B – Normalbetrieb (2 User, ohne Stem-Batch)

| Last | CPU | RAM | GPU | Netz |
|---|---|---|---|---|
| App + Signaling + Proxys | 1,5 | 2,5 GB | – | 60 Mbit/s |
| TTS/MOA (extern) | 0,5 | 0,5 GB | – | 10 Mbit/s |
| 1 Stem-Job gelegentlich | 4 | 8 GB | optional | 10 Mbit/s |
| **Summe** | **~6 vCPU** | **~11 GB** | – | **~80 Mbit/s** |

---

## 4. Empfohlene Instanz-Flotte

| Rolle | Größe | vCPU | RAM | GPU | Zweck |
|---|---|---|---|---|---|
| **1× großer Server** | GPU-Knoten (z. B. Hetzner GEX44/RTX 4000 o. L40S) | 8–16 | 32–64 GB | **1× 16–24 GB VRAM** | Stem-AI (Demucs), Ollama, lokale TTS-Fallback, Batch-KI |
| **1× starker Server** | App/Master-Knoten (CCX33) | 8 | 32 GB | – | Express, Backend-Core, Master-Player, Task-Worker, Tagger |
| **1× guter Server** | Kollaborations-Knoten (CPX31) | 4 | 8 GB | – | Mediasoup-SFU + Socket.io-Signaling (netzwerksensibel) |
| **1× kleiner Server** | Edge/Failover-Knoten (CX22) | 2 | 4 GB | – | Edge-DSP, Health-Checks, Smoke-Tests, Failover-Pfad |
| **2–5× kleine Server** | Edge-DSP-Cluster (CX22 je) | 2 je | 4 GB je | – | Verteilte DSP-Auslagerung, Staging, Monitoring, Backup-Target |

**Gesamtbedarf Flotte:** ~**28–38 vCPU · 84–128 GB RAM · 1 GPU** ·
~**300–500 Mbit/s** Uplink (SFU dominiert den Traffic).

### Alternative „kleinster Einstieg" (Budget)
1× CPX31 (4 vCPU/8 GB) für App+SFU+Mastering + 1× GPU-Server nur bei Bedarf
(Stems dann CPU-langsam oder per `STEM_AI_URL` extern). Alles andere (LLM/TTS/
Song/DB/Storage) läuft extern über die vorhandenen Proxys.

---

## 5. Skalierungsregeln

- **Echtzeit-DSP bleibt im Browser** → Server-CPU skaliert NICHT mit der User-Anzahl der Synthese.
- **SFU zuerst skalieren** (Netzwerk!), dann **Stem-AI** (GPU), dann **App-Knoten**.
- KI-Kosten/Last bleibt extern (DeepSeek/Groq/SambaNova/HF) – der Server ist nur Proxy.
- Lokaler Fallback (Ollama/Demucs/RVC) nur auf dem GPU-Knoten aktivieren.
