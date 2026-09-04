# Deep Audit 300 – audioMONASTRY

- **Datum:** 2026-09-04T15:51:44.731Z
- **Commit:** `88400ad`
- **Branch:** `main`
- **Modus:** `full`
- **Status:** FAIL
- **Zusammenfassung:** 901 Findings, 3 Gate-relevant (critical), Dauer 6899 s

## Methoden-Matrix (300-%-Prinzip)

| Methode | Status | Findings | Dauer |
|---|---|---|---|
| PASS tsc | pass | 0 | 31 s |
| WARN eslint | warn | 838 | 19 s |
| PASS knip | pass | 0 | 6 s |
| WARN jscpd | warn | 26 | 1 s |
| PASS npm-audit | pass | 0 | 1 s |
| PASS semgrep | pass | 0 | 1 s |
| PASS interface-boundaries | pass | 0 | 0 s |
| PASS react-memo | pass | 0 | 0 s |
| PASS bundle-budget | pass | 0 | 0 s |
| WARN deepseek-flash | warn | 9 | 3593 s |
| WARN hf-qwen | warn | 30 | 148 s |
| WARN deepseek-pro | warn | 10 | 3100 s |

**Geprüfte Dateien:** 799

**KI-Provider:** deepseek:deepseek-v4-flash, hf:Qwen/Qwen3-Coder-30B-A3B-Instruct:featherless-ai, deepseek:deepseek-v4-pro

## Findings nach Schweregrad

### KRITISCH (3)

| Quelle | Datei | Zeile | Kategorie | Titel |
|---|---|---|---|---|
| hf-qwen | `server/cloudAutomation.ts` | 122 | security | Mögliche Fehlermeldung mit internen Details an Client |
| hf-qwen | `services/samplemonk-ai-runtime/app.py` | 150 | security | Lack of Authentication for MCP Tools |
| hf-qwen | `services/samplemonk-ai-runtime/model_manager.py` | 170 | realtime-audio | Potenzielle Latenz durch CUDA Memory Cleanup |

<details>
<summary>Details öffnen</summary>

**Mögliche Fehlermeldung mit internen Details an Client** – `server/cloudAutomation.ts:122` (hf-qwen)

Die Funktion `ingestAudioObject` gibt direkt Fehlermeldungen von Supabase zurück, was potenziell sensible Informationen preisgeben kann.

*Evidenz:* if (error) return { key, ok: false, error: error.message };

*Empfehlung:* Verwende eine Logging-Strategie, die interne Fehlerdetails nicht an den Client weitergibt. Stattdessen logge sie serverseitig und sende eine generische Fehlermeldung an den Client.

---

**Lack of Authentication for MCP Tools** – `services/samplemonk-ai-runtime/app.py:150` (hf-qwen)

The /mcp/tools/{tool_name} endpoint allows direct invocation of MCP tools without any authentication or authorization checks, potentially enabling privilege escalation or unauthorized tool usage.

*Evidenz:* @app.post("/mcp/tools/{tool_name}")
async def mcp_tool(tool_name: str, request: Request) -> JSONResponse:
    from mcp_runtime import McpRuntime

    body = await request.json()
    result = McpRuntime(STATE.manager).invoke(tool_name, body)
    return JSONResponse(result)

*Empfehlung:* Implement proper authentication and role-based access control (RBAC) checks before allowing invocation of MCP tools. Ensure that only authorized users can execute specific tools based on permissions defined in the system.

---

**Potenzielle Latenz durch CUDA Memory Cleanup** – `services/samplemonk-ai-runtime/model_manager.py:170` (hf-qwen)

Der Aufruf von `torch.cuda.empty_cache()` in `unload()` kann zu unvorhersehbaren Latenzspitzen führen, da er die GPU-Heap-Struktur neu anordnet. In einer Echtzeitanwendung kann dies zu PDCs (Preemption Delay Conflicts) führen.

*Evidenz:* torch.cuda.empty_cache()  # CUDA Memory sauber freigeben

*Empfehlung:* Entferne `torch.cuda.empty_cache()` oder ersetze es durch eine asynchrone Version, falls verfügbar. Alternativ: Nutze eine separate Cleanup-Thread-Queue, die nicht im kritischen Pfad ausgeführt wird.

---

</details>

### HOCH (11)

| Quelle | Datei | Zeile | Kategorie | Titel |
|---|---|---|---|---|
| hf-qwen | `server/cloudAutomation.ts` | 76 | security | Ungeprüfte Benutzereingaben in R2-Keys können zu Path Traversal führen |
| hf-qwen | `services/backend-core/python/celery_app.py` | 33 | security | Unvalidated File Path in `_validate_audio_file` |
| hf-qwen | `services/backend-core/python/hypersonic_moa.py` | 57 | security | Ungeprüfte Benutzereingabe in JSON-Validierung |
| hf-qwen | `services/samplemonk-ai-runtime/app.py` | 107 | security | Unvalidated Input in /infer Endpoint |
| hf-qwen | `services/samplemonk-ai-runtime/app.py` | 140 | security | Sensitive Data Exposure in Error Logging |
| hf-qwen | `services/samplemonk-ai-runtime/handlers.py` | 105 | security | Unvalidated User Input in Model ID and Task |
| hf-qwen | `services/samplemonk-ai-runtime/hf_manage_endpoint.py` | 104 | security | Potenzielle Exposition von Secrets in Logs |
| hf-qwen | `services/samplemonk-ai-runtime/model_manager.py` | 107 | security | Unvalidated Input in ModelDefinition.from_dict |
| deepseek-flash | `services/samplemonk-ai-runtime/startup.sh` | 13 | security | AI_RUNTIME_DEVICE defaults to cuda with no validation |
| deepseek-pro | `src/hooks/usePluginState.ts` | 29 | security | Autorisierung nur clientseitig – Lock-Prüfung nicht im Backend erzwungen |
| hf-qwen | `src/utils/WebRTCManager.ts` | 109 | security | Ungeprüfte Socket-ID in DataChannel-Nachrichten |

<details>
<summary>Details öffnen</summary>

**Ungeprüfte Benutzereingaben in R2-Keys können zu Path Traversal führen** – `server/cloudAutomation.ts:76` (hf-qwen)

Die Funktion `r2PublicUrl` verwendet den Roh-Input von `key` ohne ausreichende Validierung oder Sanitization, was zu potenziellen Path Traversal-Angriffen führen kann, wenn externe Eingaben nicht korrekt geprüft werden.

*Evidenz:* function r2PublicUrl(key: string): string {
  const safeKey = isSafeR2Key(key) ? key : 'invalid';
  const encodedKey = safeKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  ...

*Empfehlung:* Stelle sicher, dass `isSafeR2Key` auch alle möglichen Angriffsszenarien abdeckt, insbesondere solche mit doppelpunkt, Backslash, Nullbytes und relativen Pfaden. Alternativ: Verwende eine Whitelist für erlaubte Zeichen und Segmentlängen.

---

**Unvalidated File Path in `_validate_audio_file`** – `services/backend-core/python/celery_app.py:33` (hf-qwen)

Die Funktion `_validate_audio_file` akzeptiert einen Dateipfad ohne ausreichende Validierung gegen Path Traversal Angriffe. Obwohl `os.path.abspath` verwendet wird, fehlt eine strenge Prüfung, ob der Pfad innerhalb eines erlaubten Root-Verzeichnisses liegt.

*Evidenz:* if upload_root:
        real_root = os.path.realpath(upload_root)
        real_path = os.path.realpath(path)
        if real_path != real_root and not real_path.startswith(real_root + os.sep):
            raise ValueError("audio file is outside the allowed upload root")

*Empfehlung:* Füge zusätzliche Sicherheitsprüfungen hinzu, um sicherzustellen, dass der Dateipfad nicht durch symbolische Links oder andere Mechanismen manipuliert werden kann. Überprüfe auch, ob `upload_root` selbst gültig ist und keine relativen Pfade enthält.

---

**Ungeprüfte Benutzereingabe in JSON-Validierung** – `services/backend-core/python/hypersonic_moa.py:57` (hf-qwen)

Die Ausgabe von `raw.strip()` wird direkt an `json.loads()` übergeben, ohne vorherige Prüfung auf gefährliche Inhalte oder unerwartete Strukturen. Dies könnte zu einer Deserialisierungsangriffsszene führen, wenn externe Daten manipuliert werden können.

*Evidenz:* ```python
try:
    # Validieren, dass es valides JSON und ein Objekt ist
    parsed = json.loads(cleaned)
    if not isinstance(parsed, dict):
        print("[HyperSonicMOA] Ollama-Antwort war kein JSON-Objekt; nutze Fallback.")
    else:
        return json.dumps(parsed, ensure_ascii=False)
except json.JSONDecodeError:
    print("[HyperSonicMOA] Ollama-Antwort war kein valides JSON; nutze Fallback.")
```

*Empfehlung:* Fügen Sie zusätzliche Validierungen hinzu, z.B. Prüfung auf erlaubte Schlüsselnamen, Typen und Größenbeschränkungen vor dem Parsen des JSON-Strings.

---

**Unvalidated Input in /infer Endpoint** – `services/samplemonk-ai-runtime/app.py:107` (hf-qwen)

The /infer endpoint accepts arbitrary 'task' and 'model' strings from the request body without sufficient validation, potentially allowing injection or misuse of the model manager.

*Evidenz:* task = str(body.get("task", "")).strip()
model = str(body.get("model", "")).strip()
if not _SAFE_TASK_RE.fullmatch(task):
    raise HTTPException(status_code=422, detail="invalid task")
if not _SAFE_MODEL_RE.fullmatch(model):
    raise HTTPException(status_code=422, detail="invalid model")

*Empfehlung:* Ensure that the validated task and model names are also checked against a known whitelist or registry before being passed to the ModelManager.infer() method to prevent unauthorized access to non-public models or tasks.

---

**Sensitive Data Exposure in Error Logging** – `services/samplemonk-ai-runtime/app.py:140` (hf-qwen)

The error logging function logs exception details directly into the 'error' field which could expose internal implementation details or paths to clients through structured logs.

*Evidenz:* log_event("ERROR", "inference failed", task=task, model=model, error=str(exc), durationMs=duration_ms)

*Empfehlung:* Avoid logging raw exceptions or stack traces in production environments. Instead, log only sanitized error messages and use structured logging to capture metadata without exposing sensitive information.

---

**Unvalidated User Input in Model ID and Task** – `services/samplemonk-ai-runtime/handlers.py:105` (hf-qwen)

Die Funktion `run_inference` akzeptiert `model_id` und `task` direkt aus dem Payload ohne ausreichende Validierung. Dies könnte zu einer unerwarteten Ausführung von Handler-Funktionen führen, wenn `task` manipuliert wird.

*Evidenz:* if not isinstance(task, str) or len(task) > 64 or not task.strip():
        raise ModelUnavailableError("invalid task")

*Empfehlung:* Validiere `task` gegen eine whitelist von erlaubten Tasks, um sicherzustellen, dass nur bekannte Handler aufgerufen werden können.

---

**Potenzielle Exposition von Secrets in Logs** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:104` (hf-qwen)

Die Funktion `_validate_config()` validiert Umgebungsvariablen, aber keine Secrets wie `HF_TOKEN` werden explizit aus dem Log entfernt. Obwohl das Skript selbst keine Secrets direkt loggt, könnte bei Fehlern oder Debugging-Output durch andere Teile des Systems (z. B. Exceptions) ein Token in Logs landen.

*Evidenz:* Die Umgebungsvariable `HF_TOKEN` wird in `_common_kwargs()` verwendet, um einen Secret-Parameter zu setzen, ohne explizit zu prüfen, ob es sich um ein sensibles Feld handelt.

*Empfehlung:* Stelle sicher, dass alle Secrets (insbesondere `HF_TOKEN`) bei Logging oder Fehlerausgaben nicht ausgegeben werden. Verwende z. B. Logging-Filter oder Wrapper, die sensible Daten maskieren.

---

**Unvalidated Input in ModelDefinition.from_dict** – `services/samplemonk-ai-runtime/model_manager.py:107` (hf-qwen)

Die Funktion `from_dict` akzeptiert unvalidierte Benutzereingaben direkt aus dem Manifest, ohne zusätzliche Prüfung auf gefährliche Inhalte wie z.B. Pfade, URLs oder Shell-Kommandos. Dies könnte zu Sicherheitsrisiken führen, wenn externe Quellen das Manifest steuern.

*Evidenz:* model_id = str(data.get("id", "")).strip()
repository = str(data.get("repository", "")).strip()
revision = str(data.get("revision", "")).strip()

*Empfehlung:* Validiere alle Felder aus `data` zusätzlich auf potenzielle Schadcodes oder gefährliche Muster, insbesondere `repository`, `revision` und `dependencies`. Verwende z.B. `urllib.parse` zur Überprüfung von URLs.

---

**AI_RUNTIME_DEVICE defaults to cuda with no validation** – `services/samplemonk-ai-runtime/startup.sh:13` (deepseek-flash)

The script defaults AI_RUNTIME_DEVICE to 'cuda'. In a CPU-only environment or one without the CUDA runtime properly configured, this will either crash at startup or fall back unpredictably. There is also no allowlist validation, so a malformed or attacker-influenced AI_RUNTIME_DEVICE (if variables come from a config-injection surface) could cause unexpected device initialization.

*Evidenz:* export AI_RUNTIME_DEVICE="${AI_RUNTIME_DEVICE:-cuda}"

*Empfehlung:* Default to 'cpu' or auto-detect available device; validate against an allowlist (cpu, cuda, mps) before exporting.

---

**Autorisierung nur clientseitig – Lock-Prüfung nicht im Backend erzwungen** – `src/hooks/usePluginState.ts:29` (deepseek-pro)

Die Berechtigungsprüfung (nur Owner darf State ändern) findet ausschließlich im Frontend-Hook statt. Dieser Hook ruft setModuleState auf, nachdem er lokal geprüft hat. In einer Multi-User-Architektur mit WebRTC-Replikation kann ein manipulierter Client den Check umgehen und unautorisiert Plugin-State setzen. Es muss serverseitig validiert werden.

*Evidenz:* const isOwner = lockStatus.active && lockStatus.lockedBy === webRTCManager.userId; if (!lockStatus.active || isOwner) { setModuleState(pluginId, newState); ... }

*Empfehlung:* Serverseitige Validierung der Lock-Eigentümerschaft im Orchestrator oder im zentralen State-Service erzwingen; der Client-Check dient nur als UX-Sperre.

---

**Ungeprüfte Socket-ID in DataChannel-Nachrichten** – `src/utils/WebRTCManager.ts:109` (hf-qwen)

Die Funktion `dispatchDataMessage` akzeptiert eine `sourceSocketId` und validiert, dass der Sender in `sessionMembers` existiert. Jedoch wird die `senderId` aus der eingehenden Nachricht nicht ausreichend validiert, da sie von einem potenziell manipulierten Client stammen kann. Es besteht ein Risiko, dass ein Angreifer durch Spoofing die Identität eines anderen Benutzers übernehmen kann.

*Evidenz:* if (data.senderId !== undefined && String(data.senderId) !== peer.userId) {
        console.warn('[webrtc] DataChannel-Nachricht mit gespoofter senderId verworfen.', {
          sourceSocketId,
          claimedSender: data.senderId,
          actualUser: peer.userId,
          type: data.type,
        });
        return;
      }
      data = { ...data, senderId: peer.userId };

*Empfehlung:* Validiere die `senderId` nicht nur gegen den bekannten Peer, sondern auch gegen eine signierte oder verschlüsselte Quelle (z.B. mittels JWT oder MAC). Alternativ sollte die `senderId` aus der Nachricht entfernt werden, da sie durch `peer.userId` bereits korrekt gesetzt wurde.

---

</details>

### MITTEL (72)

| Quelle | Datei | Zeile | Kategorie | Titel |
|---|---|---|---|---|
| eslint | `build-worklets.mjs` | 4 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `scripts/check-react-memo.mjs` | 6 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `scripts/download-orchestral.mjs` | 17 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `scripts/hetzner/sfu-rtp-multi-run.mjs` | 66 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `scripts/hetzner/sfu-rtp-multi-run.mjs` | 66 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `scripts/hetzner/sfu-rtp-multi-run.mjs` | 84 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `scripts/hetzner/sfu-rtp-multi-run.mjs` | 101 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `scripts/hetzner/stress-test.mjs` | 76 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `scripts/wake-on-login/worker.js` | 147 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `scripts/wake-on-login/worker.js` | 167 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `server.ts` | 1454 | @typescript-eslint/no-require-imports | @typescript-eslint/no-require-imports |
| hf-qwen | `server/cloudAutomation.ts` | 100 | bug | Fehlerhafte Regex-Logik bei Kategorisierung |
| hf-qwen | `server/cloudAutomation.ts` | 132 | architecture | Zugriff auf Umgebungsvariablen ohne Sicherheitsprüfungen |
| deepseek-pro | `services/backend-core/package.json` | 8 | security | Uvicorn bindet ohne sichtbare Authentifizierung an 0.0.0.0 |
| hf-qwen | `services/backend-core/python/celery_app.py` | 104 | bug | Race Condition in `_load_demucs` |
| hf-qwen | `services/backend-core/python/celery_app.py` | 120 | bug | Race Condition in `_load_musicgen` |
| hf-qwen | `services/backend-core/python/hypersonic_moa.py` | 67 | bug | Möglicher Fehler bei leerem Prompt |
| eslint | `services/mixer/index.js` | 23 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `services/portal-worker/src/index.js` | 33 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| hf-qwen | `services/samplemonk-ai-runtime/app.py` | 124 | bug | Potential Race Condition in Model Loading |
| hf-qwen | `services/samplemonk-ai-runtime/handlers.py` | 105 | bug | Potenzielle Race Condition bei Modell-Caching |
| hf-qwen | `services/samplemonk-ai-runtime/handlers.py` | 130 | bug | Fehlende Fehlerbehandlung bei Audio-Resampling |
| hf-qwen | `services/samplemonk-ai-runtime/hf_manage_endpoint.py` | 122 | bug | Unsichere Fehlerbehandlung bei `get_inference_endpoint` |
| hf-qwen | `services/samplemonk-ai-runtime/hf_manage_endpoint.py` | 130 | architecture | Mangelnde Trennung von Konfiguration und Logik |
| hf-qwen | `services/samplemonk-ai-runtime/model_manager.py` | 130 | bug | Race Condition bei parallelen Load-Requests |
| hf-qwen | `services/samplemonk-ai-runtime/model_manager.py` | 190 | architecture | Nicht expliziter Fehlerfall bei fehlender VRAM |
| deepseek-pro | `services/samplemonk-ai-runtime/pyproject.toml` | 7 | dependency | Fehlende Hash-Pins und kein Lockfile für Supply-Chain-Sicherheit |
| deepseek-pro | `services/samplemonk-ai-runtime/pyproject.toml` | 11 | dependency | Veraltete und exakt gepinnte PyTorch-Version (torch==2.4.1) |
| deepseek-flash | `services/samplemonk-ai-runtime/registry.py` | 26 | bug | Revision-Pinning kann durch explizites `null` umgangen werden |
| deepseek-flash | `services/samplemonk-ai-runtime/startup.sh` | 9 | bug | Working-directory change via dirname $0 breaks when invoked through symlink |
| deepseek-flash | `services/samplemonk-ai-runtime/startup.sh` | 10 | bug | No write/space verification for HF_HOME persistent cache |
| deepseek-pro | `services/samplemonk-ai-runtime/startup.sh` | 18 | security | AI-Runtime lauscht ungeschützt auf allen Interfaces |
| deepseek-flash | `services/samplemonk-ai-runtime/startup.sh` | 21 | security | Server binds 0.0.0.0 with no authentication or proxy boundary check |
| eslint | `src/components/DJ4ChMixer.tsx` | 182 | react-hooks/use-memo | react-hooks/use-memo |
| eslint | `src/components/drop/DropGeneratorPanel.tsx` | 27 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/components/DrumMachineTerminal.tsx` | 86 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/components/DrumMachineTerminal.tsx` | 126 | react-hooks/preserve-manual-memoization | react-hooks/preserve-manual-memoization |
| eslint | `src/components/DrumMachineTerminal.tsx` | 140 | react-hooks/preserve-manual-memoization | react-hooks/preserve-manual-memoization |
| eslint | `src/components/DrumMachineTerminal.tsx` | 201 | react-hooks/preserve-manual-memoization | react-hooks/preserve-manual-memoization |
| eslint | `src/components/DrumMachineTerminal.tsx` | 210 | react-hooks/preserve-manual-memoization | react-hooks/preserve-manual-memoization |
| eslint | `src/components/DrumMachineTerminal.tsx` | 219 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/components/EQPluginTerminal.tsx` | 254 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/components/MasteringOverlay.tsx` | 60 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/components/MasterPlayerTerminal.tsx` | 120 | react-hooks/refs | react-hooks/refs |
| eslint | `src/components/MasterPlayerTerminal.tsx` | 130 | react-hooks/refs | react-hooks/refs |
| eslint | `src/components/MasterPlayerTerminal.tsx` | 194 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/components/MasterPlayerTerminal.tsx` | 272 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/components/midi/MappingLearnPanel.tsx` | 28 | react-hooks/refs | react-hooks/refs |
| eslint | `src/components/SemanticSampleSearch.tsx` | 71 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/components/SettingsDialog.tsx` | 90 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/context/AudioContext.tsx` | 103 | react-hooks/refs | react-hooks/refs |
| eslint | `src/context/AudioContext.tsx` | 104 | react-hooks/refs | react-hooks/refs |
| eslint | `src/context/AudioContext.tsx` | 105 | react-hooks/refs | react-hooks/refs |
| eslint | `src/context/AudioContext.tsx` | 343 | react-hooks/refs | react-hooks/refs |
| eslint | `src/context/DropContext.tsx` | 150 | react-hooks/immutability | react-hooks/immutability |
| eslint | `src/context/DropContext.tsx` | 249 | react-hooks/preserve-manual-memoization | react-hooks/preserve-manual-memoization |
| eslint | `src/hooks/useControlHub.ts` | 23 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/hooks/useHID.ts` | 72 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/hooks/useMIDI.ts` | 175 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/hooks/useMidiClockOut.ts` | 43 | react-hooks/refs | react-hooks/refs |
| eslint | `src/hooks/useMidiClockOut.ts` | 46 | react-hooks/refs | react-hooks/refs |
| eslint | `src/hooks/useMidiClockOut.ts` | 62 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| eslint | `src/hooks/useMidiClockOut.ts` | 86 | react-hooks/refs | react-hooks/refs |
| deepseek-pro | `src/hooks/usePluginState.ts` | 28 | react | updateState ist nicht stabil und kann stale lockStatus verwenden |
| eslint | `src/hooks/useRoom.ts` | 28 | react-hooks/set-state-in-effect | react-hooks/set-state-in-effect |
| deepseek-pro | `src/hooks/useSessionSync.ts` | 35 | security | syncAdd sends arbitrary unvalidated sample to remote peers |
| eslint | `src/hooks/useWebRTC.ts` | 25 | react-hooks/immutability | react-hooks/immutability |
| eslint | `src/hooks/useWebRTC.ts` | 27 | react-hooks/immutability | react-hooks/immutability |
| eslint | `src/hooks/useWebRTC.ts` | 29 | react-hooks/immutability | react-hooks/immutability |
| eslint | `src/utils/LocalEmbeddingProvider.ts` | 41 | import/no-dynamic-require | import/no-dynamic-require |
| hf-qwen | `src/utils/WebRTCManager.ts` | 150 | bug | Race Condition bei SFU-Modus-Umschaltung |
| hf-qwen | `src/utils/WebRTCManager.ts` | 220 | bug | Mögliche Fehlerbehandlung bei SFU-Produzenten |

<details>
<summary>Details öffnen</summary>

**@typescript-eslint/no-unused-vars** – `build-worklets.mjs:4` (eslint)

'copyFile' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `scripts/check-react-memo.mjs:6` (eslint)

'existsSync' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `scripts/download-orchestral.mjs:17` (eslint)

'createReadStream' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:66` (eslint)

'context' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:66` (eslint)

'page' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:84` (eslint)

'page' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:101` (eslint)

'page' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `scripts/hetzner/stress-test.mjs:76` (eslint)

'id' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `scripts/wake-on-login/worker.js:147` (eslint)

'e' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `scripts/wake-on-login/worker.js:167` (eslint)

'e' is defined but never used.

---

**@typescript-eslint/no-require-imports** – `server.ts:1454` (eslint)

A `require()` style import is forbidden.

---

**Fehlerhafte Regex-Logik bei Kategorisierung** – `server/cloudAutomation.ts:100` (hf-qwen)

In `detectCategoryType` wird der Typ basierend auf dem Dateinamen bestimmt, aber es gibt keine explizite Prüfung, ob der Typ korrekt zugeordnet wird. Dies könnte zu inkonsistenten Kategorisierungen führen.

*Evidenz:* if (/(kick|bass|sub|low)/.test(lower)) return { category: 'bass', type: 'Bass' };

*Empfehlung:* Implementiere eine Priorisierung der Regex-Muster, um sicherzustellen, dass spezifische Begriffe wie 'kick' vor allgemeinen Mustern wie 'loop' geprüft werden. Alternativ: Füge Tests hinzu, um die Zuordnung zu validieren.

---

**Zugriff auf Umgebungsvariablen ohne Sicherheitsprüfungen** – `server/cloudAutomation.ts:132` (hf-qwen)

Die Funktion `r2Client()` und `supabaseAdmin()` greifen direkt auf Umgebungsvariablen zu, ohne diese auf Gültigkeit zu prüfen. Dies kann zu Laufzeitfehlern führen, wenn Variablen fehlen oder leer sind.

*Evidenz:* const accountId = env.CFR2_ACCOUNT_ID?.trim();
const accessKeyId = env.CFR2_ACCESS_KEY_ID?.trim();
const secretAccessKey = env.CFR2_SECRET_ACCESS_KEY?.trim();

*Empfehlung:* Füge explizite Prüfungen hinzu, ob alle erforderlichen Umgebungsvariablen gesetzt sind, bevor ein Client erstellt wird. Gibt eine klare Fehlermeldung zurück, falls nicht.

---

**Uvicorn bindet ohne sichtbare Authentifizierung an 0.0.0.0** – `services/backend-core/package.json:8` (deepseek-pro)

Das Startskript für den Python-Teil des Backend-Cores bindet den Uvicorn-Server an alle Netzwerk-Interfaces (0.0.0.0) und exponiert damit die API, die für Audio-Routing, Signaling und AI-Processing zuständig ist, potenziell ungeschützt im gesamten Netzwerk. Ohne eine im Code belegbare Authentifizierungs-/TLS-Schicht oder Netzwerksegmentierung können unbefugte Clients auf Steuerungs- und Verarbeitungsfunktionen zugreifen.

*Evidenz:* "start:python": "cd python && uvicorn main:app --host 0.0.0.0 --port 8000"

*Empfehlung:* Uvicorn nur an das interne/private Interface binden (z. B. --host 127.0.0.1 oder eine interne Container-Netzwerkadresse), sofern der Dienst nicht explizit öffentlich erreichbar sein muss. Falls externe Erreichbarkeit erforderlich ist, Authentifizierung, Autorisierung und TLS auf Anwendungsebene bzw. durch einen vorgelagerten Reverse-Proxy erzwingen. Das Startskript entsprechend anpassen oder zumindest eine dokumentierte, abgesicherte Produktionskonfiguration verwenden.

---

**Race Condition in `_load_demucs`** – `services/backend-core/python/celery_app.py:104` (hf-qwen)

In `_load_demucs` gibt es eine Race Condition zwischen dem Check auf `_demucs_cache is not None` und dem eigentlichen Laden des Modells. Zwei Threads könnten gleichzeitig in den kritischen Abschnitt eintreten und denselben Cache laden.

*Evidenz:* if _demucs_cache is not None:
        return _demucs_cache
    if os.environ.get("AI_USE_DEMUCS", "1") == "0":
        raise RuntimeError("Demucs ist über AI_USE_DEMUCS=0 deaktiviert.")
    with _demucs_lock:
        if _demucs_cache is not None:
            return _demucs_cache

*Empfehlung:* Verwende eine einzige atomare Prüfung mit Lock, z.B. `with _demucs_lock: if _demucs_cache is None: ...` um sicherzustellen, dass nur ein Thread das Modell lädt.

---

**Race Condition in `_load_musicgen`** – `services/backend-core/python/celery_app.py:120` (hf-qwen)

Ähnlich wie bei `_load_demucs`, gibt es eine Race Condition in `_load_musicgen`. Der Cache-Check vor dem Lock kann zu parallelen Ladevorgängen führen.

*Evidenz:* if _musicgen_cache is not None:
        return _musicgen_cache
    if os.environ.get("AI_USE_MUSICGEN", "1") == "0":
        raise RuntimeError("MusicGen ist über AI_USE_MUSICGEN=0 deaktiviert.")
    with _musicgen_lock:
        if _musicgen_cache is not None:
            return _musicgen_cache

*Empfehlung:* Wende dieselbe Strategie wie bei `_load_demucs` an: Prüfe den Cache innerhalb des Locks, um Race Conditions zu vermeiden.

---

**Möglicher Fehler bei leerem Prompt** – `services/backend-core/python/hypersonic_moa.py:67` (hf-qwen)

Wenn `report_text` leer ist, wird ein Standardtext verwendet, aber es gibt keinen expliziten Check darauf, ob der Prompt nach der Verarbeitung gültig ist. Dies kann zu unerwartetem Verhalten führen, insbesondere wenn der Prompt leer bleibt.

*Evidenz:* ```python
report_text = (report_text or "").strip()
if not report_text:
    report_text = "Ein analoger Polysynth mit vier Stimmen und charakteristischem Filter."
```

*Empfehlung:* Stellen Sie sicher, dass der Prompt immer einen sinnvollen Inhalt hat, bevor er an das LLM gesendet wird, und fügen Sie Logging hinzu, um solche Fälle zu erkennen.

---

**@typescript-eslint/no-unused-vars** – `services/mixer/index.js:23` (eslint)

'e' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `services/portal-worker/src/index.js:33` (eslint)

'REPO_URL' is assigned a value but never used.

---

**Potential Race Condition in Model Loading** – `services/samplemonk-ai-runtime/app.py:124` (hf-qwen)

The background thread `_preload_models_background()` may attempt to access the ModelManager instance while it's still being configured in the main thread during startup, leading to race conditions.

*Evidenz:* threading.Thread(target=_preload_models_background, daemon=True).start()

# In _preload_models_background:
STATE.manager.preload()

*Empfehlung:* Add synchronization mechanisms such as locks or ensure that the ModelManager is fully initialized and configured before starting the background loading thread.

---

**Potenzielle Race Condition bei Modell-Caching** – `services/samplemonk-ai-runtime/handlers.py:105` (hf-qwen)

Der LRU-Cache `_MODEL_CACHE` wird nicht thread-sicher gehandhabt. Bei gleichzeitigen Anfragen kann es zu inkonsistenten Zuständen kommen, insbesondere beim Entfernen und Hinzufügen von Einträgen.

*Evidenz:* _MODEL_CACHE: "OrderedDict[str, Any]" = OrderedDict()

*Empfehlung:* Verwende einen thread-safe Cache wie `concurrent.futures.ThreadPoolExecutor` oder eine Lock-Mechanismus zur Synchronisation des Zugriffs auf `_MODEL_CACHE`.

---

**Fehlende Fehlerbehandlung bei Audio-Resampling** – `services/samplemonk-ai-runtime/handlers.py:130` (hf-qwen)

In `_read_audio` wird bei fehlendem `torchaudio` als Fallback auf lineare Interpolation zurückgegriffen, aber es wird keine explizite Fehlermeldung ausgegeben, falls diese auch fehlschlägt.

*Evidenz:* except ModelUnavailableError:
            # Torchaudio fehlt: lineare Interpolation als letzter Fallback.

*Empfehlung:* Füge eine zusätzliche Fehlerbehandlung hinzu, um sicherzustellen, dass auch der Fallback fehlerhaft abgefangen wird.

---

**Unsichere Fehlerbehandlung bei `get_inference_endpoint`** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:122` (hf-qwen)

Die Fehlerbehandlung in `main()` prüft nur auf spezifische Textmuster ('404', 'not found') zur Unterscheidung zwischen Nichtvorhandensein und anderen Fehlern. Dies ist anfällig für Änderungen in der API-Antwort und kann zu unerwartetem Verhalten führen.

*Evidenz:* Die Zeile `not_found = "404" in text or "not found" in text.lower() or "does not exist" in text.lower()` ist anfällig für falsch-positive Treffer.

*Empfehlung:* Nutze stattdessen spezifische Exceptions (z. B. `HfHubHTTPError` mit Statuscode 404) statt String-Prüfung, um sicherzustellen, dass nur wirklich nicht vorhandene Endpunkte als solche behandelt werden.

---

**Mangelnde Trennung von Konfiguration und Logik** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:130` (hf-qwen)

Die Konfiguration des Endpoints (`_common_kwargs`, `_create_kwargs`) wird direkt in der Hauptlogik definiert. Dies erschwert Wartung, Testbarkeit und mögliche Wiederverwendung.

*Evidenz:* Die Funktionen `_common_kwargs()` und `_create_kwargs()` enthalten sowohl Logik als auch Konfiguration, was die Modularität beeinträchtigt.

*Empfehlung:* Trenne Konfiguration und Logik durch eine Klasse oder Modul, das die Endpoint-Konfiguration kapselt. Dies verbessert die Testbarkeit und Wartbarkeit.

---

**Race Condition bei parallelen Load-Requests** – `services/samplemonk-ai-runtime/model_manager.py:130` (hf-qwen)

Obwohl es einen `loading`-Set gibt, um parallele Requests zu deduplizieren, besteht ein potenzieller Race Condition, wenn zwei Threads gleichzeitig `load()` aufrufen und beide den gleichen `model_id` haben. Der erste Thread setzt `_loading.add(model_id)` und der zweite prüft darauf, aber beide können den gleichen Status haben.

*Evidenz:* if model_id in self._loading:
    raise ModelUnavailableError(f"model already loading: {model_id}")

*Empfehlung:* Verwende eine Lock-basierte Warteschlange oder eine Semaphore, um sicherzustellen, dass nur ein Thread pro Modell gleichzeitig lädt. Alternativ: Füge eine Warteschlange hinzu, die auf den Abschluss des Ladevorgangs wartet.

---

**Nicht expliziter Fehlerfall bei fehlender VRAM** – `services/samplemonk-ai-runtime/model_manager.py:190` (hf-qwen)

Wenn `required > self._available_vram_gb()` und keine Eviction möglich ist, wird ein `ModelUnavailableError` geworfen. Es fehlt eine explizite Strategie zur Behandlung dieses Falls, was zu unerwarteten Ausfällen führen kann.

*Evidenz:* raise ModelUnavailableError(
    f"VRAM exhausted for {definition.id} (required {required} GB, "
    f"available {self._available_vram_gb():.1f} GB)"
)

*Empfehlung:* Implementiere eine Logging-Strategie oder eine Callback-Funktion, die auf VRAM-Überlastung reagiert, um z.B. eine Notfallstrategie wie 'Fallback auf CPU' oder 'Benachrichtigung an Admin' zu aktivieren.

---

**Fehlende Hash-Pins und kein Lockfile für Supply-Chain-Sicherheit** – `services/samplemonk-ai-runtime/pyproject.toml:7` (deepseek-pro)

Die Dependencies sind ohne Hash-Verifikation deklariert und es existiert kein sichtbares Lockfile (z. B. poetry.lock oder pip-tools requirements.txt). Dadurch können bei Installation kompromittierte oder bösartige Paketversionen innerhalb der erlaubten Bereiche (z. B. >=4.44,<5) eingespielt werden, ohne dass der Integritätscheck dies verhindert.

*Evidenz:* dependencies = [
  "fastapi>=0.115,<1",
  "uvicorn[standard]>=0.30,<1",
  "pydantic>=2,<3",
  "torch==2.4.1",
  "transformers>=4.44,<5",
  "soundfile>=0.12",
  "scipy>=1.13",
  "pyannote.audio>=3.3",
]

*Empfehlung:* Ergänze ein Lockfile mit Hash-Pins (z. B. poetry.lock oder pip-tools mit --generate-hashes) und binde es in den Build/Deployment-Prozess ein. Prüfe außerdem regelmäßig auf bekannte Schwachstellen (z. B. via Dependabot oder pip-audit).

---

**Veraltete und exakt gepinnte PyTorch-Version (torch==2.4.1)** – `services/samplemonk-ai-runtime/pyproject.toml:11` (deepseek-pro)

Die exakte Pin auf torch==2.4.1 (veröffentlicht Juli 2024) führt dazu, dass bekannte Sicherheitslücken und Stabilitätsprobleme, die in neueren PyTorch-Versionen behoben wurden, dauerhaft im Projekt verbleiben. Da keine automatische Update-Strategie erkennbar ist, bleibt das Risiko bestehen, bis die Version manuell aktualisiert wird.

*Evidenz:* "torch==2.4.1"

*Empfehlung:* Aktualisiere auf die neueste stabile PyTorch-Version (z. B. 2.7.x) und prüfe anschließend die Kompatibilität mit den anderen Abhängigkeiten. Erwäge, einen Bereich mit Obergrenze (z. B. >=2.5,<3) zu verwenden, oder behalte die exakte Pin, aber plane regelmäßige Updates und Security-Audits.

---

**Revision-Pinning kann durch explizites `null` umgangen werden** – `services/samplemonk-ai-runtime/registry.py:26` (deepseek-flash)

Die Validierung fordert eine feste Revision, konvertiert aber `null`/None mit `str()` zu "None". Dadurch wird ein Manifest-Eintrag mit `"revision": null` als gültig akzeptiert, obwohl keine Revision gepinnt wurde. Damit kann die Produktionsregel "feste Revisionen (kein `latest`)" umgangen werden und es können ungewollte oder nicht reproduzierbare Modellversionen geladen werden.

*Evidenz:* revision = str(model.get("revision", "")).strip()
if not revision or revision.lower() == "latest": ...

*Empfehlung:* Prüfe den Rohwert vor der String-Konvertierung, z.B.: `revision = model.get("revision")`; lehne ab, wenn `revision is None`, kein String, leer, oder `revision.strip().lower() == "latest"` ist.

---

**Working-directory change via dirname $0 breaks when invoked through symlink** – `services/samplemonk-ai-runtime/startup.sh:9` (deepseek-flash)

The script cd's to "$(dirname "$0")". If startup.sh is invoked via a symlink (e.g., from /usr/local/bin or a container entrypoint), the working directory becomes the symlink's location, making the subsequent relative default for AI_MODEL_MANIFEST incorrect.

*Evidenz:* cd "$(dirname "$0")"

*Empfehlung:* Resolve the script location robustly: SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$SCRIPT_DIR"

---

**No write/space verification for HF_HOME persistent cache** – `services/samplemonk-ai-runtime/startup.sh:10` (deepseek-flash)

HF_HOME defaults to /data/hf-cache but the script never creates or checks writability/free space. If the volume is read-only or not mounted, the app starts successfully and model loading fails later at request time, obscuring the configuration error.

*Evidenz:* export HF_HOME="${HF_HOME:-/data/hf-cache}"

*Empfehlung:* After export, add a guard: mkdir -p "$HF_HOME" && [ -w "$HF_HOME" ] || { log structured startup error; exit 1; }

---

**AI-Runtime lauscht ungeschützt auf allen Interfaces** – `services/samplemonk-ai-runtime/startup.sh:18` (deepseek-pro)

Uvicorn wird mit --host 0.0.0.0 gestartet und akzeptiert Verbindungen auf allen Netzwerkinterfaces. Das Skript selbst konfiguriert weder TLS noch Authentifizierung. Jeder mit Netzwerkzugriff kann die AI-Runtime unautorisiert nutzen (Inferenz, Ressourcenverbrauch, möglicherweise Datenabfluss). Wenn der Dienst nur vom Orchestrator-Backend konsumiert wird, ist dies eine unnötige Exposition.

*Evidenz:* exec uvicorn app:app \n  --host 0.0.0.0 \

*Empfehlung:* Begrenze den Host auf das interne Netzwerk, z.B. --host 127.0.0.1 bei gleicher Pod-/Container-Netzwerknutzung, oder erzwinge Applikations-Auth/mTLS und sichere Firewall-Regeln.

---

**Server binds 0.0.0.0 with no authentication or proxy boundary check** – `services/samplemonk-ai-runtime/startup.sh:21` (deepseek-flash)

Uvicorn is started with --host 0.0.0.0. If the service is reachable outside an internal Docker network without an auth gateway, the AI runtime can be called directly. The script does not verify it is behind an authenticated orchestrator/proxy.

*Evidenz:* exec uvicorn app:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}"

*Empfehlung:* Bind to 127.0.0.1 when the service is only meant to be reached through the orchestrator, or document/require a secure internal network with an auth boundary.

---

**react-hooks/use-memo** – `src/components/DJ4ChMixer.tsx:182` (eslint)

Error: Expected the first argument to be an inline function expression

Expected the first argument to be an inline function expression.

/home/patrick/audioMONASTRY/src/components/DJ4ChMixer.tsx:182:26
  180 |
  181 | export const DJMixer = React.memo(function DJMixer() {
> 182 |   const strips = useMemo(buildStrips, []);
      |                          ^^^^^^^^^^^ Expected the first argument to be an inline function expression
  183 |   const [ch, setCh] = useState<ChannelState[]>(() => buildStrips().map(freshChannel));
  184 |   const [xfd, setXfd] = useState(0.5);
  185 |   const [xfMode, setXfMode] = useState<XfMode>('THRU');

---

**react-hooks/set-state-in-effect** – `src/components/drop/DropGeneratorPanel.tsx:27` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/components/drop/DropGeneratorPanel.tsx:27:5
  25 |   // Load initial suggestions
  26 |   useEffect(() => {
> 27 |     setSuggestions(DROP_PROFILES.slice(0, 4));
     |     ^^^^^^^^^^^^^^ Avoid calling setState() directly within an effect
  28 |   }, []);
  29 |
  30 |   return (

---

**react-hooks/set-state-in-effect** – `src/components/DrumMachineTerminal.tsx:86` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/components/DrumMachineTerminal.tsx:86:11
  84 |       if (parsed) {
  85 |         if (parsed.kit && DRUM_KITS.some((k) => k.id === parsed.kit)) {
> 86 |           setActiveKit(parsed.kit);
     |           ^^^^^^^^^^^^ Avoid calling setState() directly within an effect
  87 |           audioEngine.setDrumKit(parsed.kit);
  88 |           const kit = DRUM_KITS.find((k) => k.id === parsed.kit)!;
  89 |           setSelectedSoundId(kit.sounds[0]?.id ?? '');

---

**react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:126` (eslint)

Compilation Skipped: Existing memoization could not be preserved

React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. This value was memoized in source but not in compilation output.

/home/patrick/audioMONASTRY/src/components/DrumMachineTerminal.tsx:126:38
  124 |   }, []);
  125 |
> 126 |   const playStepSample = useCallback((sample: AudioSample) => {
      |                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^
> 127 |     if (sample.url) {
      | ^^^^^^^^^^^^^^^^^^^^^
> 128 |       // F4-Fix: Peer-gesteuerte URLs nur nach Allowlist laden.
      …
      | ^^^^^^^^^^^^^^^^^^^^^
> 139 |     if (match) void audioEngine.triggerDrumSound(activeDrumKit.id, match.id, 1);
      | ^^^^^^^^^^^^^^^^^^^^^
> 140 |   }, [activeDrumKit]);
      | ^^^^ Could not preserve existing memoization
  141 |
  142 |   // Transport: aktive Steps am Step-Edge triggern (16/32 Steps, A/B-Chain, Flam/Roll).
  143 |   useEffect(() => {

---

**react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:140` (eslint)

Compilation Skipped: Existing memoization could not be preserved

React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. This dependency may be mutated later, which could cause the value to change unexpectedly.

/home/patrick/audioMONASTRY/src/components/DrumMachineTerminal.tsx:140:7
  138 |     const match = activeDrumKit.sounds.find((s) => t.includes(s.type) || s.type.includes(t));
  139 |     if (match) void audioEngine.triggerDrumSound(activeDrumKit.id, match.id, 1);
> 140 |   }, [activeDrumKit]);
      |       ^^^^^^^^^^^^^ This dependency may be modified later
  141 |
  142 |   // Transport: aktive Steps am Step-Edge triggern (16/32 Steps, A/B-Chain, Flam/Roll).
  143 |   useEffect(() => {

---

**react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:201` (eslint)

Compilation Skipped: Existing memoization could not be preserved

React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. This value was memoized in source but not in compilation output.

/home/patrick/audioMONASTRY/src/components/DrumMachineTerminal.tsx:201:40
  199 |   };
  200 |
> 201 |   const handleSampleDrop = useCallback((sample: AudioSample, step: number) => {
      |                                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 202 |     if (lockedByOther) return;
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 203 |     const key = patternKey(selectedSound?.id ?? '');
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 204 |     setStepSamples((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), [step]: sample } }));
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 205 |     setPatterns((prev) => {
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 206 |       const arr = prev[key] ? [...prev[key]] : emptyPattern();
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 207 |       arr[step] = true;
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 208 |       return { ...prev, [key]: arr };
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 209 |     });
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 210 |   }, [lockedByOther, patternKey, selectedSound, emptyPattern]);
      | ^^^^ Could not preserve existing memoization
  211 |
  212 |   // Einheitliche Action-Menu-Übernahme: Sample auf den nächsten freien Step
  213 |   // des gewählten Sounds legen (bestehender One-Shot-Drop-Pfad).

---

**react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:210` (eslint)

Compilation Skipped: Existing memoization could not be preserved

React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. This dependency may be mutated later, which could cause the value to change unexpectedly.

/home/patrick/audioMONASTRY/src/components/DrumMachineTerminal.tsx:210:34
  208 |       return { ...prev, [key]: arr };
  209 |     });
> 210 |   }, [lockedByOther, patternKey, selectedSound, emptyPattern]);
      |                                  ^^^^^^^^^^^^^ This dependency may be modified later
  211 |
  212 |   // Einheitliche Action-Menu-Übernahme: Sample auf den nächsten freien Step
  213 |   // des gewählten Sounds legen (bestehender One-Shot-Drop-Pfad).

---

**react-hooks/set-state-in-effect** – `src/components/DrumMachineTerminal.tsx:219` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/components/DrumMachineTerminal.tsx:219:20
  217 |     const arr = patterns[key] ?? emptyPattern();
  218 |     const step = arr.findIndex((on) => !on);
> 219 |     if (step >= 0) handleSampleDrop(takeoverRequest.sample, step);
      |                    ^^^^^^^^^^^^^^^^ Avoid calling setState() directly within an effect
  220 |     clearTakeoverRequest();
  221 |     // eslint-disable-next-line react-hooks/exhaustive-deps
  222 |   }, [takeoverRequest]);

---

**react-hooks/set-state-in-effect** – `src/components/EQPluginTerminal.tsx:254` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/components/EQPluginTerminal.tsx:254:9
  252 |         const gains = Array.isArray(parsed.gains) && parsed.gains.length === BAND_COUNT ? parsed.gains.map(Number) : BANDS.map(() => 0);
  253 |         const qs = Array.isArray(parsed.qs) && parsed.qs.length === BAND_COUNT ? parsed.qs.map(Number) : BANDS.map(() => 1);
> 254 |         setGainValues(gains);
      |         ^^^^^^^^^^^^^ Avoid calling setState() directly within an effect
  255 |         setQValues(qs);
  256 |         lastGainsRef.current = gains;
  257 |         if (typeof parsed.power === 'boolean') setPower(parsed.power);

---

**react-hooks/set-state-in-effect** – `src/components/MasteringOverlay.tsx:60` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/components/MasteringOverlay.tsx:60:17
  58 |
  59 |   useEffect(() => {
> 60 |     if (isOpen) setActiveTab(plugin);
     |                 ^^^^^^^^^^^^ Avoid calling setState() directly within an effect
  61 |   }, [isOpen, plugin]);
  62 |
  63 |   // Load initial preset

---

**react-hooks/refs** – `src/components/MasterPlayerTerminal.tsx:120` (eslint)

Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/patrick/audioMONASTRY/src/components/MasterPlayerTerminal.tsx:120:20
  118 |       ) : (
  119 |         <label
> 120 |           htmlFor={id.current}
      |                    ^^^^^^^^^^ Cannot access ref value during render
  121 |           className="flex flex-col items-center justify-center gap-1.5 px-3 py-4 cursor-pointer hover:border-cyan-400/50 hover:bg-cyan-400/5 transition-colors text-center"
  122 |         >
  123 |           <Upload className={`w-4 h-4 ${drag ? 'text-cyan-300' : 'text-neutral-500'}`} />

---

**react-hooks/refs** – `src/components/MasterPlayerTerminal.tsx:130` (eslint)

Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/patrick/audioMONASTRY/src/components/MasterPlayerTerminal.tsx:130:13
  128 |       )}
  129 |       <input
> 130 |         id={id.current}
      |             ^^^^^^^^^^ Cannot access ref value during render
  131 |         type="file"
  132 |         accept="audio/*"
  133 |         className="hidden"

---

**react-hooks/set-state-in-effect** – `src/components/MasterPlayerTerminal.tsx:194` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/components/MasterPlayerTerminal.tsx:194:5
  192 |   useEffect(() => {
  193 |     if (!busy) return;
> 194 |     setIdx(0);
      |     ^^^^^^ Avoid calling setState() directly within an effect
  195 |     const t = setInterval(() => setIdx((i) => (i + 1) % steps.length), 900);
  196 |     return () => clearInterval(t);
  197 |   }, [busy]);

---

**react-hooks/set-state-in-effect** – `src/components/MasterPlayerTerminal.tsx:272` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/components/MasterPlayerTerminal.tsx:272:5
  270 |
  271 |   useEffect(() => {
> 272 |     checkHealth();
      |     ^^^^^^^^^^^ Avoid calling setState() directly within an effect
  273 |     return () => {
  274 |       setTrackA((prev) => { revokeFileUrl(prev); return null; });
  275 |       setTrackB((prev) => { revokeFileUrl(prev); return null; });

---

**react-hooks/refs** – `src/components/midi/MappingLearnPanel.tsx:28` (eslint)

Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/patrick/audioMONASTRY/src/components/midi/MappingLearnPanel.tsx:28:3
  26 |
  27 |   const lastEventRef = useRef(lastEvent);
> 28 |   lastEventRef.current = lastEvent;
     |   ^^^^^^^^^^^^^^^^^^^^ Cannot update ref during render
  29 |
  30 |   useEffect(() => {
  31 |     if (!learning) return;

---

**react-hooks/set-state-in-effect** – `src/components/SemanticSampleSearch.tsx:71` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/components/SemanticSampleSearch.tsx:71:7
  69 |   // Reset page when query changes
  70 |   React.useEffect(() => {
> 71 |       setPage(1);
     |       ^^^^^^^ Avoid calling setState() directly within an effect
  72 |   }, [query]);
  73 |
  74 |   return (

---

**react-hooks/set-state-in-effect** – `src/components/SettingsDialog.tsx:90` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/components/SettingsDialog.tsx:90:5
  88 |     if (!open) return;
  89 |     const ctx = Tone.context.rawContext as AudioContext & { setSinkId?: (id: string) => Promise<void> };
> 90 |     setSinkSupported(!!ctx?.setSinkId);
     |     ^^^^^^^^^^^^^^^^ Avoid calling setState() directly within an effect
  91 |
  92 |     const refresh = () => {
  93 |       enumerateMediaDevices()

---

**react-hooks/refs** – `src/context/AudioContext.tsx:103` (eslint)

Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/patrick/audioMONASTRY/src/context/AudioContext.tsx:103:10
  101 |     const clockMergerRef = useRef<CrdtClockMerger | null>(null);
  102 |     const pluginLwwRef = useRef<CrdtLwwMap<unknown> | null>(null);
> 103 |     if (!crdtClockRef.current) crdtClockRef.current = new CrdtClock(0);
      |          ^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  104 |     if (!clockMergerRef.current) clockMergerRef.current = new CrdtClockMerger();
  105 |     if (!pluginLwwRef.current) pluginLwwRef.current = new CrdtLwwMap<unknown>();
  106 |

To initialize a ref only once, check that the ref is null with the pattern `if (ref.current == null) { ref.current = ... }`

---

**react-hooks/refs** – `src/context/AudioContext.tsx:104` (eslint)

Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/patrick/audioMONASTRY/src/context/AudioContext.tsx:104:10
  102 |     const pluginLwwRef = useRef<CrdtLwwMap<unknown> | null>(null);
  103 |     if (!crdtClockRef.current) crdtClockRef.current = new CrdtClock(0);
> 104 |     if (!clockMergerRef.current) clockMergerRef.current = new CrdtClockMerger();
      |          ^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  105 |     if (!pluginLwwRef.current) pluginLwwRef.current = new CrdtLwwMap<unknown>();
  106 |
  107 |     // Clock sync broadcaster (mit CRDT-Stamp; Empfänger merge über Merger).

To initialize a ref only once, check that the ref is null with the pattern `if (ref.current == null) { ref.current = ... }`

---

**react-hooks/refs** – `src/context/AudioContext.tsx:105` (eslint)

Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/patrick/audioMONASTRY/src/context/AudioContext.tsx:105:10
  103 |     if (!crdtClockRef.current) crdtClockRef.current = new CrdtClock(0);
  104 |     if (!clockMergerRef.current) clockMergerRef.current = new CrdtClockMerger();
> 105 |     if (!pluginLwwRef.current) pluginLwwRef.current = new CrdtLwwMap<unknown>();
      |          ^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  106 |
  107 |     // Clock sync broadcaster (mit CRDT-Stamp; Empfänger merge über Merger).
  108 |     useEffect(() => {

To initialize a ref only once, check that the ref is null with the pattern `if (ref.current == null) { ref.current = ... }`

---

**react-hooks/refs** – `src/context/AudioContext.tsx:343` (eslint)

Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/patrick/audioMONASTRY/src/context/AudioContext.tsx:343:67
  341 |
  342 |     return (
> 343 |         <AudioContext.Provider value={{ startAudio, audioContext: audioContextRef.current }}>
      |                                                                   ^^^^^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  344 |             {children}
  345 |         </AudioContext.Provider>
  346 |     );

---

**react-hooks/immutability** – `src/context/DropContext.tsx:150` (eslint)

Error: Cannot access variable before it is declared

`addChatMessage` is accessed before it is declared, which prevents the earlier access from updating when this value changes over time.

/home/patrick/audioMONASTRY/src/context/DropContext.tsx:150:7
  148 |
  149 |       setAiSuggestions((prev) => [...prev.slice(-2), generated]);
> 150 |       addChatMessage(
      |       ^^^^^^^^^^^^^^ `addChatMessage` accessed before it is declared
  151 |         prompt,
  152 |         'user'
  153 |       );

/home/patrick/audioMONASTRY/src/context/DropContext.tsx:248:3
  246 |   }, []);
  247 |
> 248 |   const addChatMessage = useCallback(
      |   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 249 |     (text: string, sender: 'user' | 'ai', profile?: GeneratedDropProfile) => {
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 250 |       const message: ChatMessage = {
      …
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 261 |     []
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 262 |   );
      | ^^^^^ `addChatMessage` is declared here
  263 |
  264 |   const clearChat = useCallback(() => {
  265 |     setChatHistory([]);

---

**react-hooks/preserve-manual-memoization** – `src/context/DropContext.tsx:249` (eslint)

Compilation Skipped: Existing memoization could not be preserved

React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. This value was memoized in source but not in compilation output.

/home/patrick/audioMONASTRY/src/context/DropContext.tsx:249:5
  247 |
  248 |   const addChatMessage = useCallback(
> 249 |     (text: string, sender: 'user' | 'ai', profile?: GeneratedDropProfile) => {
      |     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 250 |       const message: ChatMessage = {
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 251 |         id: `msg_${Date.now()}`,
      …
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 259 |       setChatHistory((prev) => [...prev.slice(-20), message]); // Keep last 20 messages
      | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 260 |     },
      | ^^^^^^ Could not preserve existing memoization
  261 |     []
  262 |   );
  263 |

---

**react-hooks/set-state-in-effect** – `src/hooks/useControlHub.ts:23` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/hooks/useControlHub.ts:23:5
  21 |     controlHub.register(hidAdapter);
  22 |     controlHub.register(oscAdapter);
> 23 |     setStatus(controlHub.listStatus());
     |     ^^^^^^^^^ Avoid calling setState() directly within an effect
  24 |
  25 |     const offEvent = controlHub.onControlEvent((ev) => setLastEvent(ev));
  26 |     const refresh = () => setStatus(controlHub.listStatus());

---

**react-hooks/set-state-in-effect** – `src/hooks/useHID.ts:72` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/hooks/useHID.ts:72:5
  70 |   useEffect(() => {
  71 |     if (!supported || !navigator.hid) return;
> 72 |     refresh();
     |     ^^^^^^^ Avoid calling setState() directly within an effect
  73 |     navigator.hid.addEventListener('connect', refresh);
  74 |     navigator.hid.addEventListener('disconnect', refresh);
  75 |     return () => {

---

**react-hooks/set-state-in-effect** – `src/hooks/useMIDI.ts:175` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/hooks/useMIDI.ts:175:5
  173 |
  174 |   useEffect(() => {
> 175 |     requestAccess();
      |     ^^^^^^^^^^^^^ Avoid calling setState() directly within an effect
  176 |     return () => {
  177 |       if (stateChangeTimer.current !== null) window.clearTimeout(stateChangeTimer.current);
  178 |       const access = accessRef.current;

---

**react-hooks/refs** – `src/hooks/useMidiClockOut.ts:43` (eslint)

Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/patrick/audioMONASTRY/src/hooks/useMidiClockOut.ts:43:8
  41 |   const { drumChannel, noteLengthMs } = options;
  42 |   const clockOutRef = useRef<MidiClockOut | null>(null);
> 43 |   if (!clockOutRef.current) {
     |        ^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  44 |     clockOutRef.current = new MidiClockOut({ drumChannel, noteLengthMs });
  45 |   }
  46 |   const clockOut = clockOutRef.current;

To initialize a ref only once, check that the ref is null with the pattern `if (ref.current == null) { ref.current = ... }`

---

**react-hooks/refs** – `src/hooks/useMidiClockOut.ts:46` (eslint)

Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/patrick/audioMONASTRY/src/hooks/useMidiClockOut.ts:46:20
  44 |     clockOutRef.current = new MidiClockOut({ drumChannel, noteLengthMs });
  45 |   }
> 46 |   const clockOut = clockOutRef.current;
     |                    ^^^^^^^^^^^^^^^^^^^ Cannot access ref value during render
  47 |
  48 |   const [portId, setPortId] = useState('');
  49 |   const [enabled, setEnabledState] = useState(false);

---

**react-hooks/set-state-in-effect** – `src/hooks/useMidiClockOut.ts:62` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/hooks/useMidiClockOut.ts:62:7
  60 |     if (!target) {
  61 |       clockOut.setSink(null);
> 62 |       setConnected(false);
     |       ^^^^^^^^^^^^ Avoid calling setState() directly within an effect
  63 |       return;
  64 |     }
  65 |     const sink: MidiOutSink = {

---

**react-hooks/refs** – `src/hooks/useMidiClockOut.ts:86` (eslint)

Error: Cannot access refs during render

React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).

/home/patrick/audioMONASTRY/src/hooks/useMidiClockOut.ts:86:10
  84 |   }, [clockOut]);
  85 |
> 86 |   return {
     |          ^
> 87 |     clockOut, ports, portId,
     | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 88 |     selectPort: setPortId,
     | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 89 |     enabled, setEnabled, connected,
     | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 90 |   };
     | ^^^^ Cannot access ref value during render
  91 | }
  92 |

---

**updateState ist nicht stabil und kann stale lockStatus verwenden** – `src/hooks/usePluginState.ts:28` (deepseek-pro)

updateState wird bei jedem Render neu erstellt und schließt den aktuellen lockStatus ein. Wenn der Rückgabewert in memoized Children oder Effects mit leeren Dependencies verwendet wird, kann eine veraltete Lock-Entscheidung getroffen werden. Zudem ist webRTCManager.userId eine externe nicht-reaktive Quelle, deren Änderung keinen Re-Render auslöst.

*Evidenz:* const updateState = (newState: PluginState) => { const isOwner = lockStatus.active && lockStatus.lockedBy === webRTCManager.userId; ... }

*Empfehlung:* updateState mit useCallback stabilisieren (Dependencies: [lockStatus.active, lockStatus.lockedBy, pluginId, setModuleState, userId]); userId über React-Context bereitstellen.

---

**react-hooks/set-state-in-effect** – `src/hooks/useRoom.ts:28` (eslint)

Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following:
* Update external systems with the latest state from React.
* Subscribe for updates from some external system, calling setState in a callback function when external state changes.

Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. (https://react.dev/learn/you-might-not-need-an-effect).

/home/patrick/audioMONASTRY/src/hooks/useRoom.ts:28:5
  26 |   useEffect(() => {
  27 |     if (!roomId) return;
> 28 |     setRoom(localRooms[roomId] ?? null);
     |     ^^^^^^^ Avoid calling setState() directly within an effect
  29 |   }, [roomId]);
  30 |
  31 |   // RBAC-gestützter Kick: nur admin (Host) darf entfernen; Audit-Event.

---

**syncAdd sends arbitrary unvalidated sample to remote peers** – `src/hooks/useSessionSync.ts:35` (deepseek-pro)

syncAdd accepts `sample: any` and sends it directly via webRTCManager without applying the same id/name/url validation that is enforced for incoming messages. A compromised or buggy local caller can broadcast malformed or untrusted payloads (e.g., non-string URL, oversized object, injection attempts) to all other session users.

*Evidenz:* const syncAdd = (sample: any) => {
    addToScratchpad(sample);
    webRTCManager.sendData({ type: 'SCRATCHPAD_UPDATE', action: 'ADD', sample });
  };

*Empfehlung:* Define a strict Sample type and reuse the same validation guard (id string, name string, url undefined or isTrustedMediaUrl) before calling addToScratchpad and sendData. Avoid `any`.

---

**react-hooks/immutability** – `src/hooks/useWebRTC.ts:25` (eslint)

Error: Cannot access variable before it is declared

`handleOffer` is accessed before it is declared, which prevents the earlier access from updating when this value changes over time.

/home/patrick/audioMONASTRY/src/hooks/useWebRTC.ts:25:9
  23 |
  24 |       if (type === 'sdp_offer') {
> 25 |         handleOffer(sender, payload);
     |         ^^^^^^^^^^^ `handleOffer` accessed before it is declared
  26 |       } else if (type === 'sdp_answer') {
  27 |         handleAnswer(sender, payload);
  28 |       } else if (type === 'ice_candidate') {

/home/patrick/audioMONASTRY/src/hooks/useWebRTC.ts:73:3
  71 |   };
  72 |
> 73 |   const handleOffer = async (sender: string, sdp: RTCSessionDescriptionInit) => {
     |   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 74 |     const pc = createPeerConnection(sender);
     | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 75 |     await pc.setRemoteDescription(new RTCSessionDescription(sdp));
     …
     | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 83 |     }));
     | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 84 |   };
     | ^^^^^ `handleOffer` is declared here
  85 |
  86 |   const handleAnswer = async (sender: string, sdp: RTCSessionDescriptionInit) => {
  87 |     const pc = peers.get(sender);

---

**react-hooks/immutability** – `src/hooks/useWebRTC.ts:27` (eslint)

Error: Cannot access variable before it is declared

`handleAnswer` is accessed before it is declared, which prevents the earlier access from updating when this value changes over time.

/home/patrick/audioMONASTRY/src/hooks/useWebRTC.ts:27:9
  25 |         handleOffer(sender, payload);
  26 |       } else if (type === 'sdp_answer') {
> 27 |         handleAnswer(sender, payload);
     |         ^^^^^^^^^^^^ `handleAnswer` accessed before it is declared
  28 |       } else if (type === 'ice_candidate') {
  29 |         handleCandidate(sender, payload);
  30 |       } else if (type === 'lock_status') {

/home/patrick/audioMONASTRY/src/hooks/useWebRTC.ts:86:3
  84 |   };
  85 |
> 86 |   const handleAnswer = async (sender: string, sdp: RTCSessionDescriptionInit) => {
     |   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 87 |     const pc = peers.get(sender);
     | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 88 |     await pc?.setRemoteDescription(new RTCSessionDescription(sdp));
     | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 89 |   };
     | ^^^^^ `handleAnswer` is declared here
  90 |
  91 |   const handleCandidate = async (sender: string, candidate: RTCIceCandidateInit) => {
  92 |     const pc = peers.get(sender);

---

**react-hooks/immutability** – `src/hooks/useWebRTC.ts:29` (eslint)

Error: Cannot access variable before it is declared

`handleCandidate` is accessed before it is declared, which prevents the earlier access from updating when this value changes over time.

/home/patrick/audioMONASTRY/src/hooks/useWebRTC.ts:29:9
  27 |         handleAnswer(sender, payload);
  28 |       } else if (type === 'ice_candidate') {
> 29 |         handleCandidate(sender, payload);
     |         ^^^^^^^^^^^^^^^ `handleCandidate` accessed before it is declared
  30 |       } else if (type === 'lock_status') {
  31 |         const { moduleId, userId, status } = payload;
  32 |         setLocks(prev => new Map(prev).set(moduleId, status === 'locked' ? userId : null));

/home/patrick/audioMONASTRY/src/hooks/useWebRTC.ts:91:3
  89 |   };
  90 |
> 91 |   const handleCandidate = async (sender: string, candidate: RTCIceCandidateInit) => {
     |   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 92 |     const pc = peers.get(sender);
     | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 93 |     await pc?.addIceCandidate(new RTCIceCandidate(candidate));
     | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> 94 |   };
     | ^^^^^ `handleCandidate` is declared here
  95 |
  96 |   return { peers, locks, requestLock };
  97 | }

---

**import/no-dynamic-require** – `src/utils/LocalEmbeddingProvider.ts:41` (eslint)

Definition for rule 'import/no-dynamic-require' was not found.

---

**Race Condition bei SFU-Modus-Umschaltung** – `src/utils/WebRTCManager.ts:150` (hf-qwen)

In `setSfuMode`, wenn der SFU-Modus aktiviert wird, werden bestehende P2P-Verbindungen geschlossen, aber es gibt keine Garantie dafür, dass alle Verbindungen vor dem Umschaltvorgang ordnungsgemäß abgeschlossen wurden. Dies kann zu Zustandsinkonsistenzen führen, insbesondere wenn noch Daten über alte Verbindungen gesendet werden.

*Evidenz:* this.peerConnections.forEach((pc) => { try { pc.close(); } catch { /* noop */ } });
      this.peerConnections.clear();
      this.dataChannels.clear();

*Empfehlung:* Füge eine Wartezeit oder ein Promise-basiertes Schließen hinzu, bevor der SFU-Modus aktiviert wird, um sicherzustellen, dass alle Ressourcen freigegeben wurden.

---

**Mögliche Fehlerbehandlung bei SFU-Produzenten** – `src/utils/WebRTCManager.ts:220` (hf-qwen)

In `syncSfuSubscriptions` wird bei einem Fehler beim Erstellen eines Tracks nur eine Warnung ausgegeben. Es gibt keine Mechanismen zur Wiederholung oder Fehlerbehandlung, was zu fehlenden Streams führen kann.

*Evidenz:* this.sfu.subscribeToPeer(p.producerId)
        .then((track) => {
          if (track) this.onRemoteStream(new MediaStream([track]), p.producerId);
        })
        .catch((e) => console.warn('SFU consume fehlgeschlagen:', e));

*Empfehlung:* Implementiere eine Retry-Logik oder eine Wiederherstellungsmethode, um sicherzustellen, dass fehlgeschlagene Subscriptions später wieder versucht werden.

---

</details>

### NIEDRIG (813)

| Quelle | Datei | Zeile | Kategorie | Titel |
|---|---|---|---|---|
| jscpd | `ai/localDemucs.ts` | – | duplication | Code-Duplikat |
| jscpd | `audio-runtime/src/main.rs` | – | duplication | Code-Duplikat |
| jscpd | `audio/worklets/eqProcessor.ts` | – | duplication | Code-Duplikat |
| jscpd | `backend-core/python/celery_app.py` | – | duplication | Code-Duplikat |
| eslint | `build-worklets.mjs` | 4 | no-unused-vars | no-unused-vars |
| jscpd | `components/AiMonkDock.tsx` | – | duplication | Code-Duplikat |
| jscpd | `components/RecorderTerminal.tsx` | – | duplication | Code-Duplikat |
| jscpd | `core/computeLocal.ts` | – | duplication | Code-Duplikat |
| jscpd | `core/hardware/midiCodec.ts` | – | duplication | Code-Duplikat |
| jscpd | `core/instrument/drumSynth.ts` | – | duplication | Code-Duplikat |
| jscpd | `core/instrument/drumSynth.ts` | – | duplication | Code-Duplikat |
| jscpd | `core/instrument/drumSynth.ts` | – | duplication | Code-Duplikat |
| jscpd | `core/instrument/fmEngine.ts` | – | duplication | Code-Duplikat |
| jscpd | `core/voice/melody.ts` | – | duplication | Code-Duplikat |
| jscpd | `core/voice/VoiceMonkService.ts` | – | duplication | Code-Duplikat |
| jscpd | `hetzner/sfu-rtp-entry.js` | – | duplication | Code-Duplikat |
| jscpd | `hetzner/sfu-rtp-multi-run.mjs` | – | duplication | Code-Duplikat |
| jscpd | `plugins/dsp-engine/DspEnginePlugin.tsx` | – | duplication | Code-Duplikat |
| jscpd | `presets.ts` | – | duplication | Code-Duplikat |
| eslint | `scripts/check-react-memo.mjs` | 6 | no-unused-vars | no-unused-vars |
| eslint | `scripts/download-orchestral.mjs` | 17 | no-unused-vars | no-unused-vars |
| eslint | `scripts/dsp-benchmark.ts` | 67 | prefer-const | prefer-const |
| eslint | `scripts/dsp-benchmark.ts` | 67 | prefer-const | prefer-const |
| eslint | `scripts/dsp-benchmark.ts` | 67 | prefer-const | prefer-const |
| eslint | `scripts/dsp-benchmark.ts` | 67 | prefer-const | prefer-const |
| eslint | `scripts/dsp-benchmark.ts` | 67 | prefer-const | prefer-const |
| eslint | `scripts/hetzner/sfu-rtp-multi-run.mjs` | 66 | no-unused-vars | no-unused-vars |
| eslint | `scripts/hetzner/sfu-rtp-multi-run.mjs` | 66 | no-unused-vars | no-unused-vars |
| eslint | `scripts/hetzner/sfu-rtp-multi-run.mjs` | 84 | no-unused-vars | no-unused-vars |
| eslint | `scripts/hetzner/sfu-rtp-multi-run.mjs` | 101 | no-unused-vars | no-unused-vars |
| eslint | `scripts/hetzner/stress-test.mjs` | 76 | no-unused-vars | no-unused-vars |
| eslint | `scripts/hetzner/stress-test.mjs` | 177 | prefer-const | prefer-const |
| eslint | `scripts/hetzner/stress-test.mjs` | 178 | prefer-const | prefer-const |
| eslint | `scripts/memory-pressure-gate.mjs` | 31 | prefer-const | prefer-const |
| eslint | `scripts/wake-on-login/worker.js` | 147 | no-unused-vars | no-unused-vars |
| eslint | `scripts/wake-on-login/worker.js` | 167 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 28 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 28 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `server.ts` | 1272 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1276 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1276 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1276 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1276 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1277 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1277 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1277 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1277 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1277 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1278 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1278 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1278 | no-unused-vars | no-unused-vars |
| eslint | `server.ts` | 1776 | no-unused-vars | no-unused-vars |
| eslint | `server/cloudAutomation.ts` | 7 | no-unused-vars | no-unused-vars |
| eslint | `server/cloudAutomation.ts` | 7 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| hf-qwen | `services/backend-core/python/celery_app.py` | 144 | architecture | Hardcoded Model Name in `generate_sample_task` |
| hf-qwen | `services/backend-core/python/hypersonic_moa.py` | 77 | architecture | Hardcoded Default-Werte für Ollama |
| eslint | `services/mixer/index.js` | 2 | eslint | ESLint-Finding |
| eslint | `services/mixer/index.js` | 2 | eslint | ESLint-Finding |
| eslint | `services/mixer/index.js` | 2 | eslint | ESLint-Finding |
| eslint | `services/mixer/index.js` | 2 | eslint | ESLint-Finding |
| eslint | `services/mixer/index.js` | 2 | eslint | ESLint-Finding |
| eslint | `services/portal-worker/src/index.js` | 33 | no-unused-vars | no-unused-vars |
| hf-qwen | `services/samplemonk-ai-runtime/handlers.py` | 150 | architecture | Hardcoded Max Duration in Generate Handler |
| deepseek-flash | `services/samplemonk-ai-runtime/pyproject.toml` | 11 | dependency | Python-Versionsbereich erlaubt inkompatibles Python 3.13 mit exakt gepinntem torch 2.4.1 |
| deepseek-pro | `services/samplemonk-ai-runtime/startup.sh` | 13 | bug | Unsichere JSON-Logausgabe durch unescaped Variablen |
| deepseek-flash | `services/samplemonk-ai-runtime/startup.sh` | 15 | security | Startup log prints absolute path and device but no secret material |
| deepseek-flash | `services/samplemonk-ai-runtime/startup.sh` | 23 | bug | --timeout-keep-alive is confused with request/start timeout |
| eslint | `src/ai/costMonitor.ts` | 20 | no-unused-vars | no-unused-vars |
| eslint | `src/ai/costMonitor.ts` | 26 | no-unused-vars | no-unused-vars |
| eslint | `src/ai/localDemucs.ts` | 77 | no-unused-vars | no-unused-vars |
| eslint | `src/App.tsx` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/App.tsx` | 22 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/App.tsx` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/App.tsx` | 22 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/App.tsx` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/App.tsx` | 22 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/App.tsx` | 348 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/bounce/OfflineBounceEngine.ts` | 34 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/node.ts` | 24 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/node.ts` | 74 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/node.ts` | 200 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 13 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 13 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 13 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 13 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 32 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 32 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 32 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/spatial/wasmHrtf.ts` | 33 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/wasm/WasmPluginHost.ts` | 4 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/wasm/WasmPluginHost.ts` | 4 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/wasm/WasmPluginHost.ts` | 5 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/wasm/WasmPluginHost.ts` | 5 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/worklets/analyzerProcessor.ts` | 17 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/worklets/analyzerProcessor.ts` | 17 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/worklets/dspProcessor.ts` | 135 | prefer-const | prefer-const |
| eslint | `src/audio/worklets/itSynthProcessor.ts` | 154 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/worklets/lufsProcessor.ts` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/audio/worklets/lufsProcessor.ts` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/components/AudioActionMenuHost.tsx` | 48 | no-unused-vars | no-unused-vars |
| eslint | `src/components/AudioActionMenuHost.tsx` | 89 | no-unused-vars | no-unused-vars |
| eslint | `src/components/AudioActionMenuHost.tsx` | 89 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/B2BModal.tsx` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/components/B2BModal.tsx` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/components/BeatVisualizer.tsx` | 68 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/components/DJ4ChMixer.tsx` | 97 | no-unused-vars | no-unused-vars |
| eslint | `src/components/DJ4ChMixer.tsx` | 127 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/AiChatPanel.tsx` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/AiChatPanel.tsx` | 14 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/drop/DJTransitionPanel.tsx` | 24 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/DJTransitionPanel.tsx` | 24 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/drop/DropGeneratorPanel.tsx` | 8 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/DropGeneratorPanel.tsx` | 8 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/drop/DropGeneratorPanel.tsx` | 8 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/DropGeneratorPanel.tsx` | 8 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/drop/DropGeneratorPanel.tsx` | 17 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/DropGeneratorPanel.tsx` | 17 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/drop/DropGeneratorPanel.tsx` | 115 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/DropGeneratorPanel.tsx` | 115 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/drop/DropPresetBrowser.tsx` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/DropPresetBrowser.tsx` | 12 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/drop/DropPresetBrowser.tsx` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/DropPresetBrowser.tsx` | 12 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/drop/DropPresetBrowser.tsx` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/DropPresetBrowser.tsx` | 16 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/drop/DropPresetBrowser.tsx` | 25 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/DropPresetBrowser.tsx` | 25 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/drop/SamplerTopPanel.tsx` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/components/drop/SamplerTopPanel.tsx` | 10 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/DropTarget.tsx` | 6 | no-unused-vars | no-unused-vars |
| eslint | `src/components/DropTerminal.tsx` | 8 | no-unused-vars | no-unused-vars |
| eslint | `src/components/DropTerminal.tsx` | 8 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/DrumMachineTerminal.tsx` | 36 | no-unused-vars | no-unused-vars |
| eslint | `src/components/DrumMachineTerminal.tsx` | 36 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/DrumMachineTerminal.tsx` | 95 | eslint | ESLint-Finding |
| eslint | `src/components/DrumMachineTerminal.tsx` | 117 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/components/DSPTerminal.tsx` | 243 | no-unused-vars | no-unused-vars |
| eslint | `src/components/EQPluginTerminal.tsx` | 115 | no-unused-vars | no-unused-vars |
| eslint | `src/components/EQPluginTerminal.tsx` | 179 | no-unused-vars | no-unused-vars |
| eslint | `src/components/EQPluginTerminal.tsx` | 261 | eslint | ESLint-Finding |
| eslint | `src/components/ErrorBoundary.tsx` | 25 | no-unused-vars | no-unused-vars |
| eslint | `src/components/FXEngineTerminal.tsx` | 58 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/components/instrument/GarageBandInstrumentView.tsx` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/components/instrument/GarageBandInstrumentView.tsx` | 19 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/instrument/InstrumentCanvas.tsx` | 8 | no-unused-vars | no-unused-vars |
| eslint | `src/components/instrument/InstrumentCanvas.tsx` | 8 | no-unused-vars | no-unused-vars |
| eslint | `src/components/instrument/PadGrid.tsx` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/components/instrument/PadGrid.tsx` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/components/instrument/UniversalKeyboard.tsx` | 11 | no-unused-vars | no-unused-vars |
| eslint | `src/components/instrument/UniversalKeyboard.tsx` | 11 | no-unused-vars | no-unused-vars |
| eslint | `src/components/instrument/UniversalKeyboard.tsx` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/components/InstrumentsTerminal.tsx` | 8 | no-unused-vars | no-unused-vars |
| eslint | `src/components/InstrumentsTerminal.tsx` | 8 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/InstrumentsTerminal.tsx` | 11 | no-unused-vars | no-unused-vars |
| eslint | `src/components/InstrumentsTerminal.tsx` | 11 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/LibraryTerminal.tsx` | 2 | no-unused-vars | no-unused-vars |
| eslint | `src/components/LibraryTerminal.tsx` | 2 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/MasteringOverlay.tsx` | 66 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/components/MasterPlayerTerminal.tsx` | 73 | no-unused-vars | no-unused-vars |
| eslint | `src/components/MasterPlayerTerminal.tsx` | 151 | no-unused-vars | no-unused-vars |
| eslint | `src/components/MasterPlayerTerminal.tsx` | 197 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/components/MIDIControllerTerminal.tsx` | 51 | no-unused-vars | no-unused-vars |
| eslint | `src/components/MIDIControllerTerminal.tsx` | 51 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/MIDIControllerTerminal.tsx` | 90 | eslint | ESLint-Finding |
| eslint | `src/components/MIDIControllerTerminal.tsx` | 144 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/components/MIDIControllerTerminal.tsx` | 399 | no-unused-vars | no-unused-vars |
| eslint | `src/components/MIDIControllerTerminal.tsx` | 399 | no-unused-vars | no-unused-vars |
| eslint | `src/components/MIDIControllerTerminal.tsx` | 400 | no-unused-vars | no-unused-vars |
| eslint | `src/components/MIDIControllerTerminal.tsx` | 400 | no-unused-vars | no-unused-vars |
| eslint | `src/components/MischpultTerminal.tsx` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/components/MischpultTerminal.tsx` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/components/mixer/DeckSkins.tsx` | 29 | no-unused-vars | no-unused-vars |
| eslint | `src/components/mixer/DeckSkins.tsx` | 29 | no-unused-vars | no-unused-vars |
| eslint | `src/components/mixer/DeckSkins.tsx` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/components/mixer/DeckSkins.tsx` | 142 | no-unused-vars | no-unused-vars |
| eslint | `src/components/MoaAssistant.tsx` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/components/RackRow.tsx` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/components/RecorderTerminal.tsx` | 126 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/components/SafeModuleBoundary.tsx` | 35 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SampleModuleWrapper.tsx` | 7 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SemanticSampleSearch.tsx` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SessionScratchpadPanel.tsx` | 21 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SessionScratchpadPanel.tsx` | 23 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SettingsDialog.tsx` | 89 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SettingsDialog.tsx` | 122 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/components/SpatialScene.tsx` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SpatialScene.tsx` | 14 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/SpatialScene.tsx` | 207 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/components/SpatialScene.tsx` | 608 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SpatialScene.tsx` | 608 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/components/SpatialSourceIcon.tsx` | 7 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SpatialSourceIcon.tsx` | 8 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SpatialSourceIcon.tsx` | 8 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SpatialSourceIcon.tsx` | 8 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SpatialSourceIcon.tsx` | 9 | no-unused-vars | no-unused-vars |
| eslint | `src/components/SynthesizerTerminal.tsx` | 87 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/context/AccessContext.tsx` | 8 | no-unused-vars | no-unused-vars |
| eslint | `src/context/AccessContext.tsx` | 9 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 48 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 49 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 50 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 51 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 51 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 52 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 52 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 52 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 53 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 53 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 53 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 54 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 55 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 56 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 56 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 56 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 58 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 58 | no-unused-vars | no-unused-vars |
| eslint | `src/context/DropContext.tsx` | 168 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/context/DropContext.tsx` | 213 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/context/DropContext.tsx` | 224 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/context/ModuleStateContext.tsx` | 2 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ModuleStateContext.tsx` | 2 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/context/ModuleStateContext.tsx` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ModuleStateContext.tsx` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ModuleStateContext.tsx` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/context/PluginManagerContext.tsx` | 13 | no-unused-vars | no-unused-vars |
| eslint | `src/context/PluginManagerContext.tsx` | 13 | no-unused-vars | no-unused-vars |
| eslint | `src/context/PluginManagerContext.tsx` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/context/PluginManagerContext.tsx` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 60 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 61 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 65 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 66 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 66 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 67 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 70 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 72 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 72 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 73 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 79 | no-unused-vars | no-unused-vars |
| eslint | `src/context/ProjectContext.tsx` | 79 | no-unused-vars | no-unused-vars |
| eslint | `src/context/SampleContext.tsx` | 9 | no-unused-vars | no-unused-vars |
| eslint | `src/context/SampleContext.tsx` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/context/SampleContext.tsx` | 11 | no-unused-vars | no-unused-vars |
| eslint | `src/context/SampleContext.tsx` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/context/SampleContext.tsx` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/context/SampleContext.tsx` | 26 | no-unused-vars | no-unused-vars |
| eslint | `src/context/SampleContext.tsx` | 26 | no-unused-vars | no-unused-vars |
| eslint | `src/context/SampleContext.tsx` | 81 | eslint | ESLint-Finding |
| eslint | `src/context/SessionContext.tsx` | 11 | no-unused-vars | no-unused-vars |
| eslint | `src/context/SessionContext.tsx` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 22 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/adapters.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 22 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/adapters.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 22 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/adapters.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 22 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/adapters.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 22 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/adapters.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 23 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/adapters.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 23 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/adapters.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 23 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/adapters.ts` | 43 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 43 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 44 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 45 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 52 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 52 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 83 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 83 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 130 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 133 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 134 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 192 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 193 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 197 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 198 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 200 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 201 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 303 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 390 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 391 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 395 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 396 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 400 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 486 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 486 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 503 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 504 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 506 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 508 | no-unused-vars | no-unused-vars |
| eslint | `src/core/adapters.ts` | 509 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/LlmRouter.ts` | 50 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/LlmRouter.ts` | 107 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/LlmRouter.ts` | 108 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/LlmRouter.ts` | 109 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/LlmRouter.ts` | 110 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/MoaAgent.ts` | 35 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/MoaAgent.ts` | 39 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/MoaAgent.ts` | 39 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/MoaAgent.ts` | 41 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/MoaAgent.ts` | 42 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/MoaAgent.ts` | 43 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/MoaAgent.ts` | 82 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/MoaAgent.ts` | 83 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/aiLogger.ts` | 53 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/circuitBreaker.ts` | 25 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/costTracker.ts` | 63 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/costTracker.ts` | 63 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/ai/orchestrator/evaluation.ts` | 127 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/mcpRuntime.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/mcpRuntime.ts` | 41 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/mcpRuntime.ts` | 73 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/mcpRuntime.ts` | 73 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/mcpRuntime.ts` | 73 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/mcpRuntime.ts` | 75 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/mcpRuntime.ts` | 77 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/mcpRuntime.ts` | 78 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/mcpRuntime.ts` | 80 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/modelManager.ts` | 18 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/modelManager.ts` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/modelManager.ts` | 41 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/promptIteration.ts` | 28 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/promptIteration.ts` | 28 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/promptIteration.ts` | 28 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/sessionManager.ts` | 28 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/sessionManager.ts` | 85 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/sessionManager.ts` | 85 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/ai/orchestrator/types.ts` | 119 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/types.ts` | 119 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/types.ts` | 121 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/types.ts` | 121 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/types.ts` | 123 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/types.ts` | 123 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/types.ts` | 123 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/types.ts` | 123 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/types.ts` | 129 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/types.ts` | 130 | no-unused-vars | no-unused-vars |
| eslint | `src/core/ai/orchestrator/types.ts` | 132 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/AudioGraph.ts` | 21 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/AudioGraph.ts` | 86 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/AudioGraph.ts` | 87 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/AudioGraph.ts` | 88 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/backends/types.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/backends/types.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/backends/types.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/backends/types.ts` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/backends/types.ts` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/backends/types.ts` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/backends/WorkletAdapter.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/backends/WorkletAdapter.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/backends/WorkletAdapter.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/backends/WorkletAdapter.ts` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/backends/WorkletAdapter.ts` | 20 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/compat/GraphEngineAdapter.ts` | 13 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/compat/GraphEngineAdapter.ts` | 18 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/compat/GraphEngineAdapter.ts` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/compat/GraphPlaybackEngine.ts` | 9 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/compat/GraphPlaybackEngine.ts` | 9 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/compat/GraphPlaybackEngine.ts` | 18 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/compat/GraphPlaybackEngine.ts` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/compat/GraphPlaybackEngine.ts` | 20 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/compat/GraphPlaybackEngine.ts` | 46 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/compat/GraphPlaybackEngine.ts` | 46 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/nodes/basicNodes.ts` | 15 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/nodes/basicNodes.ts` | 21 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/nodes/basicNodes.ts` | 21 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/audio/nodes/basicNodes.ts` | 25 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/nodes/basicNodes.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/nodes/basicNodes.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/ipc.ts` | 38 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/ipc.ts` | 39 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/ipc.ts` | 39 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/ipc.ts` | 40 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/ipc.ts` | 40 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/NativeRuntimeAudioBackend.ts` | 35 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/NativeRuntimeAudioBackend.ts` | 38 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/NativeRuntimeAudioBackend.ts` | 120 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/NativeRuntimeClient.ts` | 26 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/NativeRuntimeClient.ts` | 26 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/NativeRuntimeClient.ts` | 27 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/NativeRuntimeClient.ts` | 55 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/NativeRuntimeSpawner.ts` | 21 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/StdioTransport.ts` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/StdioTransport.ts` | 36 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/StdioTransport.ts` | 37 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/StdioTransport.ts` | 44 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/runtime/StdioTransport.ts` | 48 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 30 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 46 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 47 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 47 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 49 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 71 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 83 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 84 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 85 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 85 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 86 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 86 | no-unused-vars | no-unused-vars |
| eslint | `src/core/audio/types.ts` | 88 | no-unused-vars | no-unused-vars |
| eslint | `src/core/clock/MasterClock.ts` | 48 | no-unused-vars | no-unused-vars |
| eslint | `src/core/clock/MasterClock.ts` | 48 | no-unused-vars | no-unused-vars |
| eslint | `src/core/clock/MonastryMasterClock.ts` | 30 | no-unused-vars | no-unused-vars |
| eslint | `src/core/clock/MonastryMasterClock.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/core/clock/MonastryMasterClock.ts` | 36 | no-unused-vars | no-unused-vars |
| eslint | `src/core/clock/MonastryMasterClock.ts` | 39 | no-unused-vars | no-unused-vars |
| eslint | `src/core/computeLocal.ts` | 7 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/AiDropGenerator.ts` | 169 | prefer-const | prefer-const |
| eslint | `src/core/drop/AiServerBridge.ts` | 7 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/AiServerBridge.ts` | 7 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/drop/ClockBridge.ts` | 50 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/ClockBridge.ts` | 185 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropAudioAdapter.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropAudioAdapter.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropAudioAdapter.ts` | 25 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropAudioAdapter.ts` | 25 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropAudioAdapter.ts` | 27 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropAudioAdapter.ts` | 27 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropAudioAdapter.ts` | 32 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropAudioAdapter.ts` | 32 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropAudioAdapter.ts` | 32 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropContextAnalyzer.ts` | 11 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropContextAnalyzer.ts` | 11 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/drop/DropContextAnalyzer.ts` | 224 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropContextAnalyzer.ts` | 224 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/drop/DropEngine.ts` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropEngine.ts` | 40 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropEngine.ts` | 41 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropEngine.ts` | 41 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropEngine.ts` | 42 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropEngine.ts` | 43 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropEngine.ts` | 43 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropEngine.ts` | 43 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/DropEngine.ts` | 44 | no-unused-vars | no-unused-vars |
| eslint | `src/core/drop/PluginParameterBridge.ts` | 136 | no-unused-vars | no-unused-vars |
| eslint | `src/core/edge/EdgeDspClient.ts` | 29 | no-unused-vars | no-unused-vars |
| eslint | `src/core/edge/EdgeDspClient.ts` | 37 | no-unused-vars | no-unused-vars |
| eslint | `src/core/edge/FailoverController.ts` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/core/edge/FailoverController.ts` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/core/edge/FailoverController.ts` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/core/edge/FailoverController.ts` | 20 | no-unused-vars | no-unused-vars |
| eslint | `src/core/edge/FailoverController.ts` | 20 | no-unused-vars | no-unused-vars |
| eslint | `src/core/edge/FailoverController.ts` | 20 | no-unused-vars | no-unused-vars |
| eslint | `src/core/events/ControlBus.ts` | 9 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/AudioDeviceManager.ts` | 63 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/AudioDeviceManager.ts` | 70 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/AudioDeviceManager.ts` | 72 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/AudioDeviceManager.ts` | 74 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/AudioDeviceManager.ts` | 74 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/AudioDeviceManager.ts` | 81 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/AudioDeviceManager.ts` | 92 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/ControlHub.ts` | 26 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/ControlHub.ts` | 80 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/diagnostics.ts` | 30 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/diagnostics.ts` | 52 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/HardwareSimulator.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/HardwareSimulator.ts` | 13 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/HotplugManager.ts` | 35 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/HotplugManager.ts` | 36 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/HotplugManager.ts` | 39 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/HotplugManager.ts` | 44 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/midiClockOut.ts` | 28 | no-unused-vars | no-unused-vars |
| eslint | `src/core/hardware/midiClockOut.ts` | 28 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/catalog.ts` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/catalog.ts` | 16 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/instrument/catalog.ts` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/catalog.ts` | 16 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/instrument/catalog.ts` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/catalog.ts` | 16 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/instrument/catalog.ts` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/catalog.ts` | 16 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 28 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 36 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 36 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 38 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 41 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 41 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 46 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 48 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 51 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 51 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 57 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 57 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/IInstrumentBackend.ts` | 60 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/InstrumentBackend.ts` | 20 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/InstrumentBackend.ts` | 21 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/InstrumentBackend.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/InstrumentBackend.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/InstrumentBackend.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/InstrumentBackend.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `src/core/instrument/InstrumentBackend.ts` | 121 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 46 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 50 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 50 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 52 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 52 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 52 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 55 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 55 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 56 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 56 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 58 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 58 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 58 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 61 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 64 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 64 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 90 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 90 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 92 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 92 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 109 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 127 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 129 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 129 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 131 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 162 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 162 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 164 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 164 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 166 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 228 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 228 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 232 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 234 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 234 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 236 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 236 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 236 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 237 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 237 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 238 | no-unused-vars | no-unused-vars |
| eslint | `src/core/interfaces.ts` | 238 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 39 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 39 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 39 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 45 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 45 | no-unused-vars | no-unused-vars |
| eslint | `src/core/native/NativeAudioBackend.ts` | 45 | no-unused-vars | no-unused-vars |
| eslint | `src/core/sampler/sfzStreaming.ts` | 47 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/SessionMediaStore.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/SessionMediaStore.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/SessionMediaStore.ts` | 24 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/SessionMediaStore.ts` | 26 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/SessionMediaStore.ts` | 27 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/sessionScratchpad.ts` | 124 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/sessionScratchpad.ts` | 124 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/sessionScratchpad.ts` | 129 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/sessionScratchpad.ts` | 129 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/sessionScratchpad.ts` | 134 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/stateReplication.ts` | 35 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/stateReplication.ts` | 121 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/stateReplication.ts` | 121 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/stateReplication.ts` | 121 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/stateReplication.ts` | 121 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/stateReplication.ts` | 122 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/stateReplication.ts` | 122 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/stateReplication.ts` | 123 | no-unused-vars | no-unused-vars |
| eslint | `src/core/session/stateReplication.ts` | 124 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/SceneRenderers.ts` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/SceneRenderers.ts` | 16 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/SourceExtractionPipeline.ts` | 30 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/SourceExtractionPipeline.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/SourceExtractionPipeline.ts` | 77 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/SourceExtractionPipeline.ts` | 101 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/spatialRenderers.ts` | 45 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/spatialRenderers.ts` | 83 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/spatialRenderers.ts` | 114 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/SpatialScene.ts` | 82 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/SpatialScene.ts` | 83 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/SpatialScene.ts` | 91 | no-unused-vars | no-unused-vars |
| eslint | `src/core/spatial/SpatialScene.ts` | 92 | no-unused-vars | no-unused-vars |
| eslint | `src/core/transport/MediasoupTransport.ts` | 33 | no-unused-vars | no-unused-vars |
| eslint | `src/core/transport/MediasoupTransport.ts` | 33 | no-unused-vars | no-unused-vars |
| eslint | `src/core/transport/MediasoupTransport.ts` | 34 | no-unused-vars | no-unused-vars |
| eslint | `src/core/transport/MediasoupTransport.ts` | 35 | no-unused-vars | no-unused-vars |
| eslint | `src/core/transport/MediasoupTransport.ts` | 37 | no-unused-vars | no-unused-vars |
| eslint | `src/core/transport/TransportRegistry.ts` | 18 | no-unused-vars | no-unused-vars |
| eslint | `src/core/transport/TransportRegistry.ts` | 18 | no-unused-vars | no-unused-vars |
| eslint | `src/core/transport/TransportRegistry.ts` | 19 | no-unused-vars | no-unused-vars |
| eslint | `src/core/transport/TransportRegistry.ts` | 20 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/melody.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/melody.ts` | 23 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/voice/melody.ts` | 90 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/melody.ts` | 90 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/melody.ts` | 90 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/SingingEngine.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/SingingEngine.ts` | 32 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/SingingEngine.ts` | 33 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/SongGenerator.ts` | 21 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/SongGenerator.ts` | 21 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/SongOutputBridge.ts` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/SongOutputBridge.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/SpeechToIntent.ts` | 17 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/VoiceControlService.ts` | 18 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/VoiceMonkService.ts` | 13 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/VoiceMonkService.ts` | 13 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/voice/VoiceMonkService.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/VoiceMonkService.ts` | 31 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/VoiceMonkService.ts` | 109 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/VoiceMonkService.ts` | 109 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/VoiceMonkService.ts` | 109 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/VoiceMonkService.ts` | 120 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/VoiceMonkService.ts` | 120 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/WebSpeechTtsProvider.ts` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/core/voice/WebSpeechTtsProvider.ts` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/core/WebAudioBackend.ts` | 48 | no-unused-vars | no-unused-vars |
| eslint | `src/core/WebAudioBackend.ts` | 72 | no-unused-vars | no-unused-vars |
| eslint | `src/core/workers/AsyncSandbox.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/core/workers/computeWorker.ts` | 11 | no-unused-vars | no-unused-vars |
| eslint | `src/core/workers/computeWorker.ts` | 34 | no-unused-vars | no-unused-vars |
| eslint | `src/core/workers/RingBuffer.ts` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/core/workers/RingBuffer.ts` | 14 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/workers/WorkerPool.ts` | 20 | no-unused-vars | no-unused-vars |
| eslint | `src/core/workers/WorkerPool.ts` | 21 | no-unused-vars | no-unused-vars |
| eslint | `src/core/workers/WorkerPool.ts` | 51 | no-unused-vars | no-unused-vars |
| eslint | `src/core/workers/WorkerPool.ts` | 51 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/core/workers/WorkerPool.ts` | 64 | no-unused-vars | no-unused-vars |
| eslint | `src/core/workers/WorkerPool.ts` | 83 | @typescript-eslint/no-unused-expressions | @typescript-eslint/no-unused-expressions |
| eslint | `src/core/workers/WorkerPool.ts` | 91 | no-unused-vars | no-unused-vars |
| eslint | `src/core/workers/WorkletPool.ts` | 11 | no-unused-vars | no-unused-vars |
| eslint | `src/data/musicLibrary.ts` | 20 | prefer-const | prefer-const |
| eslint | `src/hooks/useAudioAI.ts` | 24 | no-unused-vars | no-unused-vars |
| eslint | `src/hooks/useAudioAI.ts` | 24 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/hooks/useMIDI.ts` | 183 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/hooks/useMIDI.ts` | 185 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/hooks/useMidiClockOut.ts` | 25 | no-unused-vars | no-unused-vars |
| eslint | `src/hooks/useMidiClockOut.ts` | 28 | no-unused-vars | no-unused-vars |
| deepseek-pro | `src/hooks/useSessionSync.ts` | 24 | bug | `as never` assertion bypasses full Sample type validation |
| eslint | `src/hooks/useWebRTC.ts` | 40 | react-hooks/exhaustive-deps | react-hooks/exhaustive-deps |
| eslint | `src/plugins/dsp-engine/DspEnginePlugin.tsx` | 25 | no-unused-vars | no-unused-vars |
| eslint | `src/plugins/mischpult/MischpultPlugin.tsx` | 2 | no-unused-vars | no-unused-vars |
| eslint | `src/plugins/mischpult/MischpultPlugin.tsx` | 2 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/plugins/mischpult/MischpultPlugin.tsx` | 2 | no-unused-vars | no-unused-vars |
| eslint | `src/plugins/mischpult/MischpultPlugin.tsx` | 2 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/plugins/mischpult/MischpultPlugin.tsx` | 4 | no-unused-vars | no-unused-vars |
| eslint | `src/plugins/mischpult/MischpultPlugin.tsx` | 4 | no-unused-vars | no-unused-vars |
| eslint | `src/plugins/mischpult/MischpultPlugin.tsx` | 5 | no-unused-vars | no-unused-vars |
| eslint | `src/plugins/mischpult/MischpultPlugin.tsx` | 5 | no-unused-vars | no-unused-vars |
| eslint | `src/plugins/PluginBase.tsx` | 9 | no-unused-vars | no-unused-vars |
| eslint | `src/plugins/types.ts` | 13 | no-unused-vars | no-unused-vars |
| eslint | `src/plugins/types.ts` | 14 | no-unused-vars | no-unused-vars |
| eslint | `src/plugins/types.ts` | 15 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioAnalyzer.ts` | 153 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioAnalyzer.ts` | 153 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/utils/audioAnalyzer.ts` | 158 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioAnalyzer.ts` | 158 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/utils/audioAnalyzer.ts` | 216 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioAnalyzer.ts` | 216 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/utils/audioContextFactory.ts` | 8 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioDeviceManager.ts` | 71 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioDeviceManager.ts` | 177 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioDeviceManager.ts` | 191 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioDeviceManager.ts` | 191 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioDeviceManager.ts` | 192 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioDeviceManager.ts` | 192 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioDeviceManager.ts` | 217 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioDeviceManager.ts` | 217 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 2 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 2 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 106 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 107 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 109 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 211 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 212 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 213 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 216 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 354 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 585 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 586 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 1118 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 1118 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 1219 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 1655 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 1946 | prefer-const | prefer-const |
| eslint | `src/utils/audioEngine.ts` | 1963 | @typescript-eslint/ban-ts-comment | @typescript-eslint/ban-ts-comment |
| eslint | `src/utils/audioEngine.ts` | 1965 | @typescript-eslint/ban-ts-comment | @typescript-eslint/ban-ts-comment |
| eslint | `src/utils/audioEngine.ts` | 2265 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 2317 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 2342 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/audioEngine.ts` | 2543 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/ClockSync.ts` | 7 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/collab.ts` | 87 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/crdt.ts` | 17 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/crdt.ts` | 68 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/crdt.ts` | 69 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/LocalEmbeddingProvider.ts` | 41 | eslint | ESLint-Finding |
| eslint | `src/utils/ObjectPool.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/ObjectPool.ts` | 12 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/rbac.ts` | 177 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/rbac.ts` | 177 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/rbac.ts` | 179 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/rbac.ts` | 179 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/RbacCache.ts` | 18 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/stemSplitter.ts` | 64 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/stemSplitter.ts` | 106 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/telemetry.ts` | 49 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/telemetry.ts` | 49 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/telemetry.ts` | 49 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/telemetry.ts` | 55 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/telemetry.ts` | 55 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/telemetry.ts` | 55 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/usageAnalytics.ts` | 16 | prefer-const | prefer-const |
| eslint | `src/utils/WebRTCManager.ts` | 53 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/WebRTCManager.ts` | 53 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/WebRTCManager.ts` | 89 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/WebRTCManager.ts` | 89 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/WebRTCManager.ts` | 90 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/WebRTCManager.ts` | 93 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/WebRTCManager.ts` | 95 | no-unused-vars | no-unused-vars |
| eslint | `src/utils/WebRTCManager.ts` | 126 | no-unused-vars | no-unused-vars |
| hf-qwen | `src/utils/WebRTCManager.ts` | 270 | architecture | Doppelter Zugriff auf Socket-Instanz |
| eslint | `tests/aiControl.test.ts` | 168 | no-unused-vars | no-unused-vars |
| eslint | `tests/aiControl.test.ts` | 168 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `tests/aiRateLimitRoutes.test.ts` | 2 | no-unused-vars | no-unused-vars |
| eslint | `tests/aiRateLimitRoutes.test.ts` | 2 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `tests/aiSecurity.test.ts` | 2 | no-unused-vars | no-unused-vars |
| eslint | `tests/aiSecurity.test.ts` | 2 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `tests/architecture.test.ts` | 27 | no-unused-vars | no-unused-vars |
| eslint | `tests/audioEngine.test.ts` | 82 | no-unused-vars | no-unused-vars |
| eslint | `tests/clock.test.ts` | 11 | no-unused-vars | no-unused-vars |
| eslint | `tests/clock.test.ts` | 11 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `tests/clock.test.ts` | 52 | no-unused-vars | no-unused-vars |
| eslint | `tests/clock.test.ts` | 52 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `tests/clockProcessorWorklet.test.ts` | 27 | no-unused-vars | no-unused-vars |
| eslint | `tests/clockProcessorWorklet.test.ts` | 28 | no-unused-vars | no-unused-vars |
| eslint | `tests/clockProcessorWorklet.test.ts` | 30 | no-unused-vars | no-unused-vars |
| eslint | `tests/clockProcessorWorklet.test.ts` | 30 | no-unused-vars | no-unused-vars |
| eslint | `tests/clockProcessorWorklet.test.ts` | 30 | no-unused-vars | no-unused-vars |
| eslint | `tests/clockProcessorWorklet.test.ts` | 63 | no-unused-vars | no-unused-vars |
| eslint | `tests/controlHub.test.ts` | 7 | no-unused-vars | no-unused-vars |
| eslint | `tests/controlHub.test.ts` | 8 | no-unused-vars | no-unused-vars |
| eslint | `tests/controlHub.test.ts` | 21 | no-unused-vars | no-unused-vars |
| eslint | `tests/controlHub.test.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `tests/controlHub.test.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 167 | no-unused-vars | no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 167 | no-unused-vars | no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 252 | no-unused-vars | no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 252 | no-unused-vars | no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 252 | no-unused-vars | no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 255 | no-unused-vars | no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 255 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 255 | no-unused-vars | no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 258 | no-unused-vars | no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 310 | no-unused-vars | no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 310 | no-unused-vars | no-unused-vars |
| eslint | `tests/coverageGaps.test.ts` | 310 | no-unused-vars | no-unused-vars |
| eslint | `tests/drumSynthProcessorWorklet.test.ts` | 8 | no-unused-vars | no-unused-vars |
| eslint | `tests/drumSynthProcessorWorklet.test.ts` | 9 | no-unused-vars | no-unused-vars |
| eslint | `tests/drumSynthProcessorWorklet.test.ts` | 9 | no-unused-vars | no-unused-vars |
| eslint | `tests/e2e/hardware.spec.ts` | 24 | no-unused-vars | no-unused-vars |
| eslint | `tests/e2e/hardware.spec.ts` | 25 | no-unused-vars | no-unused-vars |
| eslint | `tests/e2e/hardware.spec.ts` | 39 | no-unused-vars | no-unused-vars |
| eslint | `tests/e2e/responsive.spec.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `tests/fm6ProcessorWorklet.test.ts` | 9 | no-unused-vars | no-unused-vars |
| eslint | `tests/fm6ProcessorWorklet.test.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `tests/fm6ProcessorWorklet.test.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `tests/granularProcessorWorklet.test.ts` | 9 | no-unused-vars | no-unused-vars |
| eslint | `tests/granularProcessorWorklet.test.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `tests/granularProcessorWorklet.test.ts` | 10 | no-unused-vars | no-unused-vars |
| eslint | `tests/masteringProcessorWorklet.test.ts` | 18 | no-unused-vars | no-unused-vars |
| eslint | `tests/masteringProcessorWorklet.test.ts` | 19 | no-unused-vars | no-unused-vars |
| eslint | `tests/masteringProcessorWorklet.test.ts` | 19 | no-unused-vars | no-unused-vars |
| eslint | `tests/masteringProcessorWorklet.test.ts` | 65 | no-unused-vars | no-unused-vars |
| eslint | `tests/masteringProcessorWorklet.test.ts` | 65 | no-unused-vars | no-unused-vars |
| eslint | `tests/monitorRouting.test.ts` | 174 | no-unused-vars | no-unused-vars |
| eslint | `tests/nativeRuntimeBackend.test.ts` | 8 | no-unused-vars | no-unused-vars |
| eslint | `tests/nativeRuntimeBackend.test.ts` | 9 | no-unused-vars | no-unused-vars |
| eslint | `tests/nativeRuntimeBackend.test.ts` | 12 | no-unused-vars | no-unused-vars |
| eslint | `tests/nativeRuntimeBackend.test.ts` | 22 | no-unused-vars | no-unused-vars |
| eslint | `tests/nativeRuntimeBackend.test.ts` | 23 | no-unused-vars | no-unused-vars |
| eslint | `tests/phase2Runtime.test.ts` | 20 | no-unused-vars | no-unused-vars |
| eslint | `tests/phase2Runtime.test.ts` | 21 | no-unused-vars | no-unused-vars |
| eslint | `tests/phase2Runtime.test.ts` | 29 | no-unused-vars | no-unused-vars |
| eslint | `tests/phase2Runtime.test.ts` | 30 | no-unused-vars | no-unused-vars |
| eslint | `tests/portalWorkerSnapshots.test.ts` | 18 | no-unused-vars | no-unused-vars |
| eslint | `tests/portalWorkerSnapshots.test.ts` | 18 | no-unused-vars | no-unused-vars |
| eslint | `tests/portalWorkerSnapshots.test.ts` | 65 | no-unused-vars | no-unused-vars |
| eslint | `tests/portalWorkerSnapshots.test.ts` | 66 | no-unused-vars | no-unused-vars |
| eslint | `tests/portalWorkerSnapshots.test.ts` | 66 | no-unused-vars | no-unused-vars |
| eslint | `tests/promptCatalog.test.ts` | 11 | no-unused-vars | no-unused-vars |
| eslint | `tests/promptCatalog.test.ts` | 11 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `tests/storageRecovery.test.ts` | 87 | no-unused-vars | no-unused-vars |
| eslint | `tests/storageRecovery.test.ts` | 88 | no-unused-vars | no-unused-vars |
| eslint | `tests/storageRecovery.test.ts` | 100 | no-unused-vars | no-unused-vars |
| eslint | `tests/storageRecovery.test.ts` | 109 | no-unused-vars | no-unused-vars |
| eslint | `tests/telemetryXrun.test.ts` | 2 | no-unused-vars | no-unused-vars |
| eslint | `tests/telemetryXrun.test.ts` | 2 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `tests/v2AudioGraph.test.ts` | 2 | no-unused-vars | no-unused-vars |
| eslint | `tests/v2AudioGraph.test.ts` | 2 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `tests/v2AudioGraph.test.ts` | 86 | no-unused-vars | no-unused-vars |
| eslint | `tests/v2AudioGraph.test.ts` | 86 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `tests/voiceBrowser.test.ts` | 4 | no-unused-vars | no-unused-vars |
| eslint | `tests/voiceBrowser.test.ts` | 4 | @typescript-eslint/no-unused-vars | @typescript-eslint/no-unused-vars |
| eslint | `tests/webrtcManager.test.ts` | 51 | no-unused-vars | no-unused-vars |
| jscpd | `utils/aiRhythmGenerator.ts` | – | duplication | Code-Duplikat |

<details>
<summary>Details öffnen</summary>

**Code-Duplikat** – `ai/localDemucs.ts:?` (jscpd)

Duplikat zwischen ai/localDemucs.ts und utils/stemSplitter.ts

*Evidenz:*   const len = buffer[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.s

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `audio-runtime/src/main.rs:?` (jscpd)

Duplikat zwischen audio-runtime/src/main.rs und audio-runtime/src/main.rs

*Evidenz:*             if let Ok(cfg) = device.default_output_config() {
                info.default_sample_rate = Some(cfg.sample_rate().0);
                info.channels = Some(cfg.channels());
                info.buffer_size = match cfg.buffer_size() {
                    // cpal meldet bei manchen ALSA-Geräten u32::MAX als
                    // Sentinel – das ist kein nutzbarer Wert, also `None`.
                    cpal::SupportedBufferSize::Range { max, .. } if *max <= 1_000_000 => Some(*max),
   

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `audio/worklets/eqProcessor.ts:?` (jscpd)

Duplikat zwischen audio/worklets/eqProcessor.ts und audio/worklets/eqProcessor.ts

*Evidenz:*   private setLowshelf(f: BandState, gain: number, freq: number, q: number) {
    const w = 2 * Math.PI * freq / sampleRate; const a = Math.pow(10, gain / 40);
    const cw = Math.cos(w), sn = Math.sin(w);
    const alpha = sn / 2 * Math.sqrt((a + 1 / a) * (1 / q - 1) + 2);
    const twoSA = 2 * Math.sqrt(a) * alpha;
    const b0 = a * ((a + 1) - (a - 1) * cw + twoSA);

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `backend-core/python/celery_app.py:?` (jscpd)

Duplikat zwischen backend-core/python/celery_app.py und stem-ai/main.py

*Evidenz:*     global _device
    if _device is not None:
        return _device
    with _device_lock:
        if _device is not None:
            return _device
        env_dev = os.environ.get("AI_DEVICE", "").strip().lower()
        if env_dev in ("cuda", "mps", "cpu"):
            _device = env_dev
            logger.info("AI_DEVICE aus ENV: %s", _device)
            return _device
        try:
            import torch
            if torch.cuda.is_available():
                _device = "cuda"
        

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**no-unused-vars** – `build-worklets.mjs:4` (eslint)

'copyFile' is defined but never used.

---

**Code-Duplikat** – `components/AiMonkDock.tsx:?` (jscpd)

Duplikat zwischen components/AiMonkDock.tsx und components/AiMonkTerminal.tsx

*Evidenz:*       setResults((prev) => [`✗ ${e instanceof Error ? e.message : String(e)}`, ...prev].slice(0, 30));
    } finally {
      setBusy(false);
      setTask('');
    }
  }, [busy]);

  const quickActions = [
    { label: '▶ PLAY', icon: Play, run: () => { void audioEngine.play(); } },
    { label: '⏹ STOP', icon: Square, run: () => { audioEngine.stop(); } },
    { label: 'KI-PATTERN', icon: Wand2, run: () => { void run('Erzeuge ein Techno-Pattern für den Sequencer und wende es an'); } },
  ];

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `components/RecorderTerminal.tsx:?` (jscpd)

Duplikat zwischen components/RecorderTerminal.tsx und components/VoiceGenTerminal.tsx

*Evidenz:*               Master Recorder <span className="text-[10px] font-mono text-indigo-400 border border-indigo-500/30 px-2 py-0.5 rounded-sm">BIT-PERFECT</span>
            </h2>
          </div>
        </div>

        <select value={state} onChange={(e) => updateState(e.target.value as any)} className="bg-black text-white text-xs p-1 rounded">
            <option value="OFF">OFF</option>
            <option value="AUTO_AI">AI</option>
            <option value="PRO">ACTIVE</option>
        </select

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `core/computeLocal.ts:?` (jscpd)

Duplikat zwischen core/computeLocal.ts und core/workers/computeWorker.ts

*Evidenz:* const LOCAL_HANDLERS: Record<string, (input: any) => unknown> = {
  'reduce': (input: { values: number[]; op?: 'sum' | 'avg' | 'max' }) => {
    const v = input.values ?? [];
    const op = input.op ?? 'sum';
    if (op === 'avg') return v.reduce((a, b) => a + b, 0) / (v.length || 1);
    if (op === 'max') return v.length ? Math.max(...v) : 0;
    return v.reduce((a, b) => a + b, 0);
  },
  'segment-energy': (input: { samples: number[]; window: number }) => {
    const s = input.samples ?? [];
 

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `core/hardware/midiCodec.ts:?` (jscpd)

Duplikat zwischen core/hardware/midiCodec.ts und core/hardware/midiCodec.ts

*Evidenz:* export function rpn(channel: number, parameter: number, value14: number): number[] {
  const ch = clamp7(channel - 1) & 0x0f;
  const pMsb = (Math.max(0, Math.min(16383, Math.round(parameter))) >> 7) & 0x7f;
  const pLsb = Math.max(0, Math.min(16383, Math.round(parameter))) & 0x7f;
  const v = Math.max(0, Math.min(16383, Math.round(value14)));
  return [
    0xb0 | ch, 101, pMsb,

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `core/instrument/drumSynth.ts:?` (jscpd)

Duplikat zwischen core/instrument/drumSynth.ts und core/instrument/earlyReflections.ts

*Evidenz:* function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderKick(durationSec = 0.4, sampleRate = 48000): Float32Array {

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `core/instrument/drumSynth.ts:?` (jscpd)

Duplikat zwischen core/instrument/drumSynth.ts und core/instrument/epiano.ts

*Evidenz:* function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderKick(durationSec = 0.4, sampleRate = 48000): Float32Array {

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `core/instrument/drumSynth.ts:?` (jscpd)

Duplikat zwischen core/instrument/drumSynth.ts und core/session/seedManagement.ts

*Evidenz:* function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderKick(durationSec = 0.4, sampleRate = 48000): Float32Array {

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `core/instrument/fmEngine.ts:?` (jscpd)

Duplikat zwischen core/instrument/fmEngine.ts und core/instrument/fmEngine.ts

*Evidenz:*       if (op === fbOp) modIn += st.fb * voice.feedbackGain;

      // Hüllkurve (lineare Segmente, vorberechnet in createFmVoice).
      if (st.seg < 4) {
        const segNow = st.segs[st.seg];
        st.envPos += 1;
        if (st.envPos >= segNow.dur) {
          st.seg += 1;
          st.envPos = 0;
        }
      }
      const segIdx = Math.min(st.seg, 3);
      const env = st.seg >= 4
        ? 0
        : Math.max(0, Math.min(1, st.segs[segIdx].start + st.segs[segIdx].delta * st.envPos)

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `core/voice/melody.ts:?` (jscpd)

Duplikat zwischen core/voice/melody.ts und core/voice/melody.ts

*Evidenz:*       samples[offset + i] = Math.sin(2 * Math.PI * freq * t) * env * 0.5;
    }
    offset += length;
  }

  // WAV/PCM-Encoder (16-bit mono).
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.se

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `core/voice/VoiceMonkService.ts:?` (jscpd)

Duplikat zwischen core/voice/VoiceMonkService.ts und core/voice/melody.ts

*Evidenz:*   view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `hetzner/sfu-rtp-entry.js:?` (jscpd)

Duplikat zwischen hetzner/sfu-rtp-entry.js und hetzner/sfu-rtp-entry.js

*Evidenz:*     if (mode === 'consumer') {
      const recvParams = await ack('createTransport');
      const recvTransport = device.createRecvTransport(recvParams);
      recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          await ack('connectTransport', { transportId: recvTransport.id, dtlsParameters });
          result.steps.push('dtls-recv-connected');
          callback();
        } catch (e) { errback(e); }
      });
      const { id, kind, rtpParamete

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `hetzner/sfu-rtp-multi-run.mjs:?` (jscpd)

Duplikat zwischen hetzner/sfu-rtp-multi-run.mjs und hetzner/sfu-rtp-run.mjs

*Evidenz:* const CONSUMERS = Number(process.env.CONSUMERS || 2);

const server = http.createServer(async (req, res) => {
  try {
    const file = req.url === '/' ? '/sfu-rtp-test.html' : req.url.split('?')[0];
    const data = await readFile(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(LOCAL

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `plugins/dsp-engine/DspEnginePlugin.tsx:?` (jscpd)

Duplikat zwischen plugins/dsp-engine/DspEnginePlugin.tsx und plugins/instrumente/InstrumentePlugin.tsx

*Evidenz:*   async requestLock(userId: string): Promise<boolean> {
    const success = await hubConnector.lockPlugin(this.config.id, userId);
    if (success) {
      this.lockStatus = { lockedBy: userId, timestamp: Date.now(), active: true };
    }
    return success;
  }

  async releaseLock(userId: string): Promise<void> {
    await hubConnector.unlockPlugin(this.config.id, userId);
    this.lockStatus = { lockedBy: null, timestamp: 0, active: false };
  }

  async updateState(newState: PluginState): Pr

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**Code-Duplikat** – `presets.ts:?` (jscpd)

Duplikat zwischen presets.ts und presets.ts

*Evidenz:*       channel4: [true, false, true, true, false, true, false, true, true, false, true, false, true, true, false, false],
      channel5: [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false],
      channel6: [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false],
      channel7: [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false,

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

**no-unused-vars** – `scripts/check-react-memo.mjs:6` (eslint)

'existsSync' is defined but never used.

---

**no-unused-vars** – `scripts/download-orchestral.mjs:17` (eslint)

'createReadStream' is defined but never used.

---

**prefer-const** – `scripts/dsp-benchmark.ts:67` (eslint)

'b0' is never reassigned. Use 'const' instead.

---

**prefer-const** – `scripts/dsp-benchmark.ts:67` (eslint)

'b1' is never reassigned. Use 'const' instead.

---

**prefer-const** – `scripts/dsp-benchmark.ts:67` (eslint)

'b2' is never reassigned. Use 'const' instead.

---

**prefer-const** – `scripts/dsp-benchmark.ts:67` (eslint)

'a1' is never reassigned. Use 'const' instead.

---

**prefer-const** – `scripts/dsp-benchmark.ts:67` (eslint)

'a2' is never reassigned. Use 'const' instead.

---

**no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:66` (eslint)

'context' is assigned a value but never used.

---

**no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:66` (eslint)

'page' is assigned a value but never used.

---

**no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:84` (eslint)

'page' is assigned a value but never used.

---

**no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:101` (eslint)

'page' is assigned a value but never used.

---

**no-unused-vars** – `scripts/hetzner/stress-test.mjs:76` (eslint)

'id' is defined but never used.

---

**prefer-const** – `scripts/hetzner/stress-test.mjs:177` (eslint)

'joinLat' is never reassigned. Use 'const' instead.

---

**prefer-const** – `scripts/hetzner/stress-test.mjs:178` (eslint)

'relayLat' is never reassigned. Use 'const' instead.

---

**prefer-const** – `scripts/memory-pressure-gate.mjs:31` (eslint)

'state' is never reassigned. Use 'const' instead.

---

**no-unused-vars** – `scripts/wake-on-login/worker.js:147` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `scripts/wake-on-login/worker.js:167` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `server.ts:28` (eslint)

'ENABLE_STEMS' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `server.ts:28` (eslint)

'ENABLE_STEMS' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `server.ts:1272` (eslint)

'opts' is defined but never used.

---

**no-unused-vars** – `server.ts:1276` (eslint)

'event' is defined but never used.

---

**no-unused-vars** – `server.ts:1276` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `server.ts:1276` (eslint)

'name' is defined but never used.

---

**no-unused-vars** – `server.ts:1276` (eslint)

'value' is defined but never used.

---

**no-unused-vars** – `server.ts:1277` (eslint)

'event' is defined but never used.

---

**no-unused-vars** – `server.ts:1277` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `server.ts:1277` (eslint)

'name' is defined but never used.

---

**no-unused-vars** – `server.ts:1277` (eslint)

'stream' is defined but never used.

---

**no-unused-vars** – `server.ts:1277` (eslint)

'info' is defined but never used.

---

**no-unused-vars** – `server.ts:1278` (eslint)

'event' is defined but never used.

---

**no-unused-vars** – `server.ts:1278` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `server.ts:1278` (eslint)

'arg' is defined but never used.

---

**no-unused-vars** – `server.ts:1776` (eslint)

'err' is defined but never used.

---

**no-unused-vars** – `server/cloudAutomation.ts:7` (eslint)

'HeadObjectCommand' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `server/cloudAutomation.ts:7` (eslint)

'HeadObjectCommand' is defined but never used. Allowed unused vars must match /^_/u.

---

**Hardcoded Model Name in `generate_sample_task`** – `services/backend-core/python/celery_app.py:144` (hf-qwen)

Der Name des MusicGen-Modells wird hartcodiert als 'facebook/musicgen-small', was die Flexibilität reduziert, verschiedene Modelle basierend auf Umgebungsvariablen zu verwenden.

*Evidenz:* model_name = os.environ.get("AI_MUSICGEN_MODEL", "facebook/musicgen-small").strip()

*Empfehlung:* Stelle sicher, dass `AI_MUSICGEN_MODEL` korrekt verwendet wird und keine Default-Werte überschreiben, falls sie explizit gesetzt wurden.

---

**Hardcoded Default-Werte für Ollama** – `services/backend-core/python/hypersonic_moa.py:77` (hf-qwen)

Die Umgebungsvariablen `OLLAMA_URL` und `OLLAMA_MODEL` sind optional, aber ihre Standardwerte sind hartcodiert. Dies kann zu Problemen führen, wenn diese Werte nicht korrekt gesetzt sind oder sich ändern müssen.

*Evidenz:* ```python
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434/api/generate")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1")
```

*Empfehlung:* Überprüfen Sie, ob die Standardwerte sinnvoll sind und dokumentieren Sie sie klar. Alternativ könnten Sie eine Warnung ausgeben, falls die Umgebungsvariablen nicht gesetzt sind.

---

**ESLint-Finding** – `services/mixer/index.js:2` (eslint)

Unused eslint-disable directive (no problems were reported from 'no-undef').

---

**ESLint-Finding** – `services/mixer/index.js:2` (eslint)

Unused eslint-disable directive (no problems were reported from 'no-console').

---

**ESLint-Finding** – `services/mixer/index.js:2` (eslint)

Unused eslint-disable directive (no problems were reported from 'no-constant-condition').

---

**ESLint-Finding** – `services/mixer/index.js:2` (eslint)

Unused eslint-disable directive (no problems were reported from 'no-control-regex').

---

**ESLint-Finding** – `services/mixer/index.js:2` (eslint)

Unused eslint-disable directive (no problems were reported from 'no-useless-escape').

---

**no-unused-vars** – `services/portal-worker/src/index.js:33` (eslint)

'REPO_URL' is assigned a value but never used.

---

**Hardcoded Max Duration in Generate Handler** – `services/samplemonk-ai-runtime/handlers.py:150` (hf-qwen)

In `hf_generate` wird `max_seconds` durch eine feste Obergrenze begrenzt, was möglicherweise nicht flexibel genug ist, um verschiedene Anwendungsfälle abzudecken.

*Evidenz:* max_seconds = min(float(payload.get("maxDuration", 10)), float(definition.maxDuration))

*Empfehlung:* Erwäge, `maxDuration` dynamisch basierend auf der Definition oder anderen Parametern zu berechnen, anstatt eine feste Obergrenze zu setzen.

---

**Python-Versionsbereich erlaubt inkompatibles Python 3.13 mit exakt gepinntem torch 2.4.1** – `services/samplemonk-ai-runtime/pyproject.toml:11` (deepseek-flash)

requires-python = ">=3.10" definiert keine obere Grenze, während torch==2.4.1 offiziell kein Python 3.13 unterstützt. In einer Umgebung mit Python 3.13 kann die Installation oder der Import der Runtime fehlschlagen, obwohl die Projekt-Metadaten diese Umgebung explizit erlauben.

*Evidenz:* Zeile 5: requires-python = ">=3.10"
Zeile 11: "torch==2.4.1"

*Empfehlung:* requires-python = ">=3.10,<3.13" setzen oder torch auf eine Python-3.13-kompatible Version (z. B. >=2.6) anheben.

---

**Unsichere JSON-Logausgabe durch unescaped Variablen** – `services/samplemonk-ai-runtime/startup.sh:13` (deepseek-pro)

Die Echo-Zeile interpoliert AI_RUNTIME_DEVICE und AI_MODEL_MANIFEST direkt in einen JSON-String. Enthalten diese Werte Anführungszeichen, Backslashes oder Zeilenumbrüche, wird das Log-Objekt ungültig und kann Log-Parser brechen. Dies betrifft die dokumentierte strukturierte Protokollierung.

*Evidenz:* echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"level\":\"INFO\",\"service\":\"samplemonk-ai-runtime\",\"msg\":\"starting\",\"device\":\"${AI_RUNTIME_DEVICE}\",\"manifest\":\"${AI_MODEL_MANIFEST}\"}"

*Empfehlung:* Nutze ein JSON-Tool wie jq oder escape die Werte explizit, z.B. printf '{"ts":"%s","level":"INFO","service":"samplemonk-ai-runtime","msg":"starting","device":"%s","manifest":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$AI_RUNTIME_DEVICE" "$AI_MODEL_MANIFEST"

---

**Startup log prints absolute path and device but no secret material** – `services/samplemonk-ai-runtime/startup.sh:15` (deepseek-flash)

The log line prints AI_RUNTIME_DEVICE and AI_MODEL_MANIFEST path. This is not a direct secret leak, but the absolute path is unnecessary and the echo format will happily embed anything if a later maintainer adds an env var containing credentials.

*Evidenz:* echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"level\":\"INFO\",\"service\":\"samplemonk-ai-runtime\",\"msg\":\"starting\",\"device\":\"${AI_RUNTIME_DEVICE}\",\"manifest\":\"${AI_MODEL_MANIFEST}\"}"

*Empfehlung:* Keep the log minimal: omit absolute path; print only manifest basename or model count. Never interpolate un-encoded environment variables into JSON text without escaping.

---

**--timeout-keep-alive is confused with request/start timeout** – `services/samplemonk-ai-runtime/startup.sh:23` (deepseek-flash)

The only timeout configured is --timeout-keep-alive 30, which controls HTTP keep-alive idle, not startup or slow-request timeouts. A slow model warm-up or hung dependency can block the process indefinitely without a health-check-visible failure.

*Evidenz:* --workers 1 \
  --timeout-keep-alive 30

*Empfehlung:* Add --timeout-graceful-shutdown and configure a health-check/readiness timeout at the orchestration layer, since Uvicorn does not offer a full request timeout.

---

**no-unused-vars** – `src/ai/costMonitor.ts:20` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/ai/costMonitor.ts:26` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/ai/localDemucs.ts:77` (eslint)

'p' is defined but never used.

---

**no-unused-vars** – `src/App.tsx:22` (eslint)

'Sliders' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/App.tsx:22` (eslint)

'Sliders' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/App.tsx:22` (eslint)

'Play' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/App.tsx:22` (eslint)

'Play' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/App.tsx:22` (eslint)

'Square' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/App.tsx:22` (eslint)

'Square' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/App.tsx:348` (eslint)

'o' is defined but never used.

---

**no-unused-vars** – `src/audio/bounce/OfflineBounceEngine.ts:34` (eslint)

'sampleRate' is assigned a value but never used.

---

**no-unused-vars** – `src/audio/spatial/node.ts:24` (eslint)

'metrics' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/node.ts:74` (eslint)

'metrics' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/node.ts:200` (eslint)

'metrics' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:12` (eslint)

'left' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:12` (eslint)

'right' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:13` (eslint)

'inputL' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:13` (eslint)

'inputR' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:13` (eslint)

'outL' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:13` (eslint)

'outR' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:31` (eslint)

'block' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:31` (eslint)

'irLen' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:32` (eslint)

'irL' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:32` (eslint)

'irR' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:32` (eslint)

'len' is defined but never used.

---

**no-unused-vars** – `src/audio/spatial/wasmHrtf.ts:33` (eslint)

'block' is defined but never used.

---

**no-unused-vars** – `src/audio/wasm/WasmPluginHost.ts:4` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/audio/wasm/WasmPluginHost.ts:4` (eslint)

'output' is defined but never used.

---

**no-unused-vars** – `src/audio/wasm/WasmPluginHost.ts:5` (eslint)

'name' is defined but never used.

---

**no-unused-vars** – `src/audio/wasm/WasmPluginHost.ts:5` (eslint)

'value' is defined but never used.

---

**no-unused-vars** – `src/audio/worklets/analyzerProcessor.ts:17` (eslint)

'_outputs' is defined but never used.

---

**no-unused-vars** – `src/audio/worklets/analyzerProcessor.ts:17` (eslint)

'_parameters' is defined but never used.

---

**prefer-const** – `src/audio/worklets/dspProcessor.ts:135` (eslint)

'y1' is never reassigned. Use 'const' instead.

---

**no-unused-vars** – `src/audio/worklets/itSynthProcessor.ts:154` (eslint)

'velocity' is defined but never used.

---

**no-unused-vars** – `src/audio/worklets/lufsProcessor.ts:14` (eslint)

'_outputs' is defined but never used.

---

**no-unused-vars** – `src/audio/worklets/lufsProcessor.ts:14` (eslint)

'_parameters' is defined but never used.

---

**no-unused-vars** – `src/components/AudioActionMenuHost.tsx:48` (eslint)

'req' is defined but never used.

---

**no-unused-vars** – `src/components/AudioActionMenuHost.tsx:89` (eslint)

'SUBMENU_WIDTH' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/AudioActionMenuHost.tsx:89` (eslint)

'SUBMENU_WIDTH' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/B2BModal.tsx:14` (eslint)

'roomId' is defined but never used.

---

**no-unused-vars** – `src/components/B2BModal.tsx:14` (eslint)

'username' is defined but never used.

---

**react-hooks/exhaustive-deps** – `src/components/BeatVisualizer.tsx:68` (eslint)

React Hook useEffect has a missing dependency: 'isPlaying'. Either include it or remove the dependency array.

---

**no-unused-vars** – `src/components/DJ4ChMixer.tsx:97` (eslint)

'v' is defined but never used.

---

**no-unused-vars** – `src/components/DJ4ChMixer.tsx:127` (eslint)

'v' is defined but never used.

---

**no-unused-vars** – `src/components/drop/AiChatPanel.tsx:14` (eslint)

'addChatMessage' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/drop/AiChatPanel.tsx:14` (eslint)

'addChatMessage' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/drop/DJTransitionPanel.tsx:24` (eslint)

'selectedProfile' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/drop/DJTransitionPanel.tsx:24` (eslint)

'selectedProfile' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/drop/DropGeneratorPanel.tsx:8` (eslint)

'Zap' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/drop/DropGeneratorPanel.tsx:8` (eslint)

'Zap' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/drop/DropGeneratorPanel.tsx:8` (eslint)

'RefreshCw' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/drop/DropGeneratorPanel.tsx:8` (eslint)

'RefreshCw' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/drop/DropGeneratorPanel.tsx:17` (eslint)

'suggestedProfiles' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/drop/DropGeneratorPanel.tsx:17` (eslint)

'suggestedProfiles' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/drop/DropGeneratorPanel.tsx:115` (eslint)

'e' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/drop/DropGeneratorPanel.tsx:115` (eslint)

'e' is defined but never used. Allowed unused args must match /^_/u.

---

**no-unused-vars** – `src/components/drop/DropPresetBrowser.tsx:12` (eslint)

'favorites' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/drop/DropPresetBrowser.tsx:12` (eslint)

'favorites' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/drop/DropPresetBrowser.tsx:12` (eslint)

'savePreset' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/drop/DropPresetBrowser.tsx:12` (eslint)

'savePreset' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/drop/DropPresetBrowser.tsx:16` (eslint)

'showSaveDialog' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/drop/DropPresetBrowser.tsx:16` (eslint)

'showSaveDialog' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/drop/DropPresetBrowser.tsx:25` (eslint)

'handleSaveNew' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/drop/DropPresetBrowser.tsx:25` (eslint)

'handleSaveNew' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/drop/SamplerTopPanel.tsx:10` (eslint)

'DropProfile' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/drop/SamplerTopPanel.tsx:10` (eslint)

'DropProfile' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/DropTarget.tsx:6` (eslint)

'sample' is defined but never used.

---

**no-unused-vars** – `src/components/DropTerminal.tsx:8` (eslint)

'Power' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/DropTerminal.tsx:8` (eslint)

'Power' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/DrumMachineTerminal.tsx:36` (eslint)

'EMPTY_16' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/DrumMachineTerminal.tsx:36` (eslint)

'EMPTY_16' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**ESLint-Finding** – `src/components/DrumMachineTerminal.tsx:95` (eslint)

Unused eslint-disable directive (no problems were reported from 'react-hooks/exhaustive-deps').

---

**react-hooks/exhaustive-deps** – `src/components/DrumMachineTerminal.tsx:117` (eslint)

React Hook useEffect has a missing dependency: 'stepCount'. Either include it or remove the dependency array. You can also replace multiple useState variables with useReducer if 'setPatterns' needs the current value of 'stepCount'.

---

**no-unused-vars** – `src/components/DSPTerminal.tsx:243` (eslint)

'_i' is defined but never used.

---

**no-unused-vars** – `src/components/EQPluginTerminal.tsx:115` (eslint)

'v' is defined but never used.

---

**no-unused-vars** – `src/components/EQPluginTerminal.tsx:179` (eslint)

'v' is defined but never used.

---

**ESLint-Finding** – `src/components/EQPluginTerminal.tsx:261` (eslint)

Unused eslint-disable directive (no problems were reported from 'react-hooks/exhaustive-deps').

---

**no-unused-vars** – `src/components/ErrorBoundary.tsx:25` (eslint)

'_' is defined but never used.

---

**react-hooks/exhaustive-deps** – `src/components/FXEngineTerminal.tsx:58` (eslint)

React Hook useEffect has a missing dependency: 'applyFx'. Either include it or remove the dependency array.

---

**no-unused-vars** – `src/components/instrument/GarageBandInstrumentView.tsx:19` (eslint)

'PlayZone' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/instrument/GarageBandInstrumentView.tsx:19` (eslint)

'PlayZone' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/instrument/InstrumentCanvas.tsx:8` (eslint)

'midi' is defined but never used.

---

**no-unused-vars** – `src/components/instrument/InstrumentCanvas.tsx:8` (eslint)

'velocity' is defined but never used.

---

**no-unused-vars** – `src/components/instrument/PadGrid.tsx:10` (eslint)

'midi' is defined but never used.

---

**no-unused-vars** – `src/components/instrument/PadGrid.tsx:10` (eslint)

'velocity' is defined but never used.

---

**no-unused-vars** – `src/components/instrument/UniversalKeyboard.tsx:11` (eslint)

'midi' is defined but never used.

---

**no-unused-vars** – `src/components/instrument/UniversalKeyboard.tsx:11` (eslint)

'velocity' is defined but never used.

---

**no-unused-vars** – `src/components/instrument/UniversalKeyboard.tsx:12` (eslint)

'midi' is defined but never used.

---

**no-unused-vars** – `src/components/InstrumentsTerminal.tsx:8` (eslint)

'listByCategory' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/InstrumentsTerminal.tsx:8` (eslint)

'listByCategory' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/InstrumentsTerminal.tsx:11` (eslint)

'getProgramForInstrument' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/InstrumentsTerminal.tsx:11` (eslint)

'getProgramForInstrument' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/LibraryTerminal.tsx:2` (eslint)

'Play' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/LibraryTerminal.tsx:2` (eslint)

'Play' is defined but never used. Allowed unused vars must match /^_/u.

---

**react-hooks/exhaustive-deps** – `src/components/MasteringOverlay.tsx:66` (eslint)

React Hook useEffect has a missing dependency: 'activePreset'. Either include it or remove the dependency array.

---

**no-unused-vars** – `src/components/MasterPlayerTerminal.tsx:73` (eslint)

'f' is defined but never used.

---

**no-unused-vars** – `src/components/MasterPlayerTerminal.tsx:151` (eslint)

'v' is defined but never used.

---

**react-hooks/exhaustive-deps** – `src/components/MasterPlayerTerminal.tsx:197` (eslint)

React Hook useEffect has a missing dependency: 'steps.length'. Either include it or remove the dependency array.

---

**no-unused-vars** – `src/components/MIDIControllerTerminal.tsx:51` (eslint)

'isConnected' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/MIDIControllerTerminal.tsx:51` (eslint)

'isConnected' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**ESLint-Finding** – `src/components/MIDIControllerTerminal.tsx:90` (eslint)

Unused eslint-disable directive (no problems were reported from 'react-hooks/exhaustive-deps').

---

**react-hooks/exhaustive-deps** – `src/components/MIDIControllerTerminal.tsx:144` (eslint)

React Hook useMemo has a missing dependency: 'profiles'. Either include it or remove the dependency array.

---

**no-unused-vars** – `src/components/MIDIControllerTerminal.tsx:399` (eslint)

'_' is defined but never used.

---

**no-unused-vars** – `src/components/MIDIControllerTerminal.tsx:399` (eslint)

'_i' is defined but never used.

---

**no-unused-vars** – `src/components/MIDIControllerTerminal.tsx:400` (eslint)

'_' is defined but never used.

---

**no-unused-vars** – `src/components/MIDIControllerTerminal.tsx:400` (eslint)

'_i' is defined but never used.

---

**no-unused-vars** – `src/components/MischpultTerminal.tsx:16` (eslint)

'channel' is defined but never used.

---

**no-unused-vars** – `src/components/MischpultTerminal.tsx:16` (eslint)

'updates' is defined but never used.

---

**no-unused-vars** – `src/components/mixer/DeckSkins.tsx:29` (eslint)

'deck' is defined but never used.

---

**no-unused-vars** – `src/components/mixer/DeckSkins.tsx:29` (eslint)

'skin' is defined but never used.

---

**no-unused-vars** – `src/components/mixer/DeckSkins.tsx:31` (eslint)

'label' is defined but never used.

---

**no-unused-vars** – `src/components/mixer/DeckSkins.tsx:142` (eslint)

'label' is defined but never used.

---

**no-unused-vars** – `src/components/MoaAssistant.tsx:12` (eslint)

'active' is defined but never used.

---

**no-unused-vars** – `src/components/RackRow.tsx:19` (eslint)

'entry' is defined but never used.

---

**react-hooks/exhaustive-deps** – `src/components/RecorderTerminal.tsx:126` (eslint)

React Hook useCallback has an unnecessary dependency: 'takes.length'. Either exclude it or remove the dependency array.

---

**no-unused-vars** – `src/components/SafeModuleBoundary.tsx:35` (eslint)

'_' is defined but never used.

---

**no-unused-vars** – `src/components/SampleModuleWrapper.tsx:7` (eslint)

'sample' is defined but never used.

---

**no-unused-vars** – `src/components/SemanticSampleSearch.tsx:10` (eslint)

'sample' is defined but never used.

---

**no-unused-vars** – `src/components/SessionScratchpadPanel.tsx:21` (eslint)

'name' is defined but never used.

---

**no-unused-vars** – `src/components/SessionScratchpadPanel.tsx:23` (eslint)

'item' is defined but never used.

---

**no-unused-vars** – `src/components/SettingsDialog.tsx:89` (eslint)

'id' is defined but never used.

---

**react-hooks/exhaustive-deps** – `src/components/SettingsDialog.tsx:122` (eslint)

React Hook useEffect has missing dependencies: 'settings' and 'update'. Either include them or remove the dependency array.

---

**no-unused-vars** – `src/components/SpatialScene.tsx:14` (eslint)

'TrackType' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/SpatialScene.tsx:14` (eslint)

'TrackType' is defined but never used. Allowed unused vars must match /^_/u.

---

**react-hooks/exhaustive-deps** – `src/components/SpatialScene.tsx:207` (eslint)

The 'releaseSpatialSource' function makes the dependencies of useCallback Hook (at line 201) change on every render. Move it inside the useCallback callback. Alternatively, wrap the definition of 'releaseSpatialSource' in its own useCallback() Hook.

---

**no-unused-vars** – `src/components/SpatialScene.tsx:608` (eslint)

'r' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/components/SpatialScene.tsx:608` (eslint)

'r' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/components/SpatialSourceIcon.tsx:7` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/components/SpatialSourceIcon.tsx:8` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/components/SpatialSourceIcon.tsx:8` (eslint)

'x' is defined but never used.

---

**no-unused-vars** – `src/components/SpatialSourceIcon.tsx:8` (eslint)

'y' is defined but never used.

---

**no-unused-vars** – `src/components/SpatialSourceIcon.tsx:9` (eslint)

'id' is defined but never used.

---

**react-hooks/exhaustive-deps** – `src/components/SynthesizerTerminal.tsx:87` (eslint)

React Hook useEffect has missing dependencies: 'cutoff', 'decay', and 'engine'. Either include them or remove the dependency array.

---

**no-unused-vars** – `src/context/AccessContext.tsx:8` (eslint)

'role' is defined but never used.

---

**no-unused-vars** – `src/context/AccessContext.tsx:9` (eslint)

'action' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:48` (eslint)

'mode' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:49` (eslint)

'profile' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:50` (eslint)

'prompt' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:51` (eslint)

'profile' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:51` (eslint)

'quantized' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:52` (eslint)

'fromCh' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:52` (eslint)

'toCh' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:52` (eslint)

'profile' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:53` (eslint)

'profile' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:53` (eslint)

'name' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:53` (eslint)

'tags' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:54` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:55` (eslint)

'presetId' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:56` (eslint)

'text' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:56` (eslint)

'sender' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:56` (eslint)

'profile' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:58` (eslint)

'start' is defined but never used.

---

**no-unused-vars** – `src/context/DropContext.tsx:58` (eslint)

'end' is defined but never used.

---

**react-hooks/exhaustive-deps** – `src/context/DropContext.tsx:168` (eslint)

React Hook useCallback has a missing dependency: 'addChatMessage'. Either include it or remove the dependency array.

---

**react-hooks/exhaustive-deps** – `src/context/DropContext.tsx:213` (eslint)

React Hook useCallback has a missing dependency: 'addChatMessage'. Either include it or remove the dependency array.

---

**react-hooks/exhaustive-deps** – `src/context/DropContext.tsx:224` (eslint)

React Hook useCallback has a missing dependency: 'addChatMessage'. Either include it or remove the dependency array.

---

**no-unused-vars** – `src/context/ModuleStateContext.tsx:2` (eslint)

'storageGet' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/context/ModuleStateContext.tsx:2` (eslint)

'storageGet' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/context/ModuleStateContext.tsx:19` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/context/ModuleStateContext.tsx:19` (eslint)

'state' is defined but never used.

---

**no-unused-vars** – `src/context/ModuleStateContext.tsx:19` (eslint)

'opts' is defined but never used.

---

**no-unused-vars** – `src/context/PluginManagerContext.tsx:13` (eslint)

'pluginId' is defined but never used.

---

**no-unused-vars** – `src/context/PluginManagerContext.tsx:13` (eslint)

'userId' is defined but never used.

---

**no-unused-vars** – `src/context/PluginManagerContext.tsx:14` (eslint)

'pluginId' is defined but never used.

---

**no-unused-vars** – `src/context/PluginManagerContext.tsx:14` (eslint)

'userId' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:60` (eslint)

'content' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:61` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:65` (eslint)

'track' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:66` (eslint)

'track' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:66` (eslint)

'content' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:67` (eslint)

'track' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:70` (eslint)

'channelId' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:72` (eslint)

'channelId' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:72` (eslint)

'content' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:73` (eslint)

'channelId' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:79` (eslint)

'channelId' is defined but never used.

---

**no-unused-vars** – `src/context/ProjectContext.tsx:79` (eslint)

'content' is defined but never used.

---

**no-unused-vars** – `src/context/SampleContext.tsx:9` (eslint)

'sample' is defined but never used.

---

**no-unused-vars** – `src/context/SampleContext.tsx:10` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/context/SampleContext.tsx:11` (eslint)

'sample' is defined but never used.

---

**no-unused-vars** – `src/context/SampleContext.tsx:14` (eslint)

'sample' is defined but never used.

---

**no-unused-vars** – `src/context/SampleContext.tsx:19` (eslint)

'sample' is defined but never used.

---

**no-unused-vars** – `src/context/SampleContext.tsx:26` (eslint)

'pluginId' is defined but never used.

---

**no-unused-vars** – `src/context/SampleContext.tsx:26` (eslint)

'sample' is defined but never used.

---

**ESLint-Finding** – `src/context/SampleContext.tsx:81` (eslint)

Unused eslint-disable directive (no problems were reported from 'react-hooks/exhaustive-deps').

---

**no-unused-vars** – `src/context/SessionContext.tsx:11` (eslint)

'sample' is defined but never used.

---

**no-unused-vars** – `src/context/SessionContext.tsx:12` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:22` (eslint)

'ParsedMidiEvent' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/adapters.ts:22` (eslint)

'ParsedMidiEvent' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/adapters.ts:22` (eslint)

'rpn' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/adapters.ts:22` (eslint)

'rpn' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/adapters.ts:22` (eslint)

'nrpn' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/adapters.ts:22` (eslint)

'nrpn' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/adapters.ts:22` (eslint)

'midiClock' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/adapters.ts:22` (eslint)

'midiClock' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/adapters.ts:22` (eslint)

'midiStart' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/adapters.ts:22` (eslint)

'midiStart' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/adapters.ts:23` (eslint)

'midiContinue' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/adapters.ts:23` (eslint)

'midiContinue' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/adapters.ts:23` (eslint)

'midiStop' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/adapters.ts:23` (eslint)

'midiStop' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/adapters.ts:23` (eslint)

'midiSongPosition' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/adapters.ts:23` (eslint)

'midiSongPosition' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/adapters.ts:43` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:43` (eslint)

'fromPeerId' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:44` (eslint)

'peerId' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:45` (eslint)

'peerId' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:52` (eslint)

'_sessionId' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:52` (eslint)

'_userId' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:83` (eslint)

'_kind' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:83` (eslint)

'_task' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:130` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:133` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:134` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:192` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:193` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:197` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:198` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:200` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:201` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:303` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:390` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:391` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:395` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:396` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:400` (eslint)

'opts' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:486` (eslint)

'reportId' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:486` (eslint)

'data' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:503` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:504` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:506` (eslint)

'url' is assigned a value but never used.

---

**no-unused-vars** – `src/core/adapters.ts:508` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/core/adapters.ts:509` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `src/core/ai/LlmRouter.ts:50` (eslint)

'req' is defined but never used.

---

**no-unused-vars** – `src/core/ai/LlmRouter.ts:107` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/ai/LlmRouter.ts:108` (eslint)

'baseUrl' is defined but never used.

---

**no-unused-vars** – `src/core/ai/LlmRouter.ts:109` (eslint)

'envName' is defined but never used.

---

**no-unused-vars** – `src/core/ai/LlmRouter.ts:110` (eslint)

'model' is defined but never used.

---

**no-unused-vars** – `src/core/ai/MoaAgent.ts:35` (eslint)

'req' is defined but never used.

---

**no-unused-vars** – `src/core/ai/MoaAgent.ts:39` (eslint)

'userId' is defined but never used.

---

**no-unused-vars** – `src/core/ai/MoaAgent.ts:39` (eslint)

'command' is defined but never used.

---

**no-unused-vars** – `src/core/ai/MoaAgent.ts:41` (eslint)

'userId' is defined but never used.

---

**no-unused-vars** – `src/core/ai/MoaAgent.ts:42` (eslint)

'pluginId' is defined but never used.

---

**no-unused-vars** – `src/core/ai/MoaAgent.ts:43` (eslint)

'command' is defined but never used.

---

**no-unused-vars** – `src/core/ai/MoaAgent.ts:82` (eslint)

'complete' is assigned a value but never used.

---

**no-unused-vars** – `src/core/ai/MoaAgent.ts:83` (eslint)

'voice' is assigned a value but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/aiLogger.ts:53` (eslint)

'service' is assigned a value but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/circuitBreaker.ts:25` (eslint)

'name' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/costTracker.ts:63` (eslint)

'model' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/ai/orchestrator/costTracker.ts:63` (eslint)

'model' is defined but never used. Allowed unused args must match /^_/u.

---

**no-unused-vars** – `src/core/ai/orchestrator/evaluation.ts:127` (eslint)

'm' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/mcpRuntime.ts:31` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/mcpRuntime.ts:41` (eslint)

'_h' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/mcpRuntime.ts:73` (eslint)

'task' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/mcpRuntime.ts:73` (eslint)

'model' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/mcpRuntime.ts:73` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/mcpRuntime.ts:75` (eslint)

'query' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/mcpRuntime.ts:77` (eslint)

'modelId' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/mcpRuntime.ts:78` (eslint)

'modelId' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/mcpRuntime.ts:80` (eslint)

'cmd' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/modelManager.ts:18` (eslint)

'modelId' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/modelManager.ts:19` (eslint)

'modelId' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/modelManager.ts:41` (eslint)

'endpoint' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/promptIteration.ts:28` (eslint)

'pluginId' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/promptIteration.ts:28` (eslint)

'version' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/promptIteration.ts:28` (eslint)

'promptContent' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/sessionManager.ts:28` (eslint)

'session' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/sessionManager.ts:85` (eslint)

'modelId' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/ai/orchestrator/sessionManager.ts:85` (eslint)

'modelId' is defined but never used. Allowed unused args must match /^_/u.

---

**no-unused-vars** – `src/core/ai/orchestrator/types.ts:119` (eslint)

'task' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/types.ts:119` (eslint)

'model' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/types.ts:121` (eslint)

'task' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/types.ts:121` (eslint)

'model' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/types.ts:123` (eslint)

'task' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/types.ts:123` (eslint)

'model' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/types.ts:123` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/types.ts:123` (eslint)

'signal' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/types.ts:129` (eslint)

'provider' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/types.ts:130` (eslint)

'code' is defined but never used.

---

**no-unused-vars** – `src/core/ai/orchestrator/types.ts:132` (eslint)

'retryable' is defined but never used.

---

**no-unused-vars** – `src/core/audio/AudioGraph.ts:21` (eslint)

'sampleRate' is defined but never used.

---

**no-unused-vars** – `src/core/audio/AudioGraph.ts:86` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/audio/AudioGraph.ts:87` (eslint)

'min' is defined but never used.

---

**no-unused-vars** – `src/core/audio/AudioGraph.ts:88` (eslint)

'max' is defined but never used.

---

**no-unused-vars** – `src/core/audio/backends/types.ts:10` (eslint)

'sampleRate' is defined but never used.

---

**no-unused-vars** – `src/core/audio/backends/types.ts:10` (eslint)

'length' is defined but never used.

---

**no-unused-vars** – `src/core/audio/backends/types.ts:10` (eslint)

'channels' is defined but never used.

---

**no-unused-vars** – `src/core/audio/backends/types.ts:12` (eslint)

'graph' is defined but never used.

---

**no-unused-vars** – `src/core/audio/backends/types.ts:12` (eslint)

'ctx' is defined but never used.

---

**no-unused-vars** – `src/core/audio/backends/types.ts:12` (eslint)

'output' is defined but never used.

---

**no-unused-vars** – `src/core/audio/backends/WorkletAdapter.ts:10` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/audio/backends/WorkletAdapter.ts:10` (eslint)

'output' is defined but never used.

---

**no-unused-vars** – `src/core/audio/backends/WorkletAdapter.ts:10` (eslint)

'ctx' is defined but never used.

---

**no-unused-vars** – `src/core/audio/backends/WorkletAdapter.ts:19` (eslint)

'type' is defined but never used.

---

**no-unused-vars** – `src/core/audio/backends/WorkletAdapter.ts:20` (eslint)

'processFn' is defined but never used.

---

**no-unused-vars** – `src/core/audio/compat/GraphEngineAdapter.ts:13` (eslint)

'state' is defined but never used.

---

**no-unused-vars** – `src/core/audio/compat/GraphEngineAdapter.ts:18` (eslint)

'engine' is defined but never used.

---

**no-unused-vars** – `src/core/audio/compat/GraphEngineAdapter.ts:19` (eslint)

'bridge' is assigned a value but never used.

---

**no-unused-vars** – `src/core/audio/compat/GraphPlaybackEngine.ts:9` (eslint)

'source' is defined but never used.

---

**no-unused-vars** – `src/core/audio/compat/GraphPlaybackEngine.ts:9` (eslint)

'ctx' is defined but never used.

---

**no-unused-vars** – `src/core/audio/compat/GraphPlaybackEngine.ts:18` (eslint)

'renderBlock' is defined but never used.

---

**no-unused-vars** – `src/core/audio/compat/GraphPlaybackEngine.ts:19` (eslint)

'sampleRate' is assigned a value but never used.

---

**no-unused-vars** – `src/core/audio/compat/GraphPlaybackEngine.ts:20` (eslint)

'blockSize' is assigned a value but never used.

---

**no-unused-vars** – `src/core/audio/compat/GraphPlaybackEngine.ts:46` (eslint)

'block' is defined but never used.

---

**no-unused-vars** – `src/core/audio/compat/GraphPlaybackEngine.ts:46` (eslint)

'time' is defined but never used.

---

**no-unused-vars** – `src/core/audio/nodes/basicNodes.ts:15` (eslint)

'type' is defined but never used.

---

**no-unused-vars** – `src/core/audio/nodes/basicNodes.ts:21` (eslint)

'ctx' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/audio/nodes/basicNodes.ts:21` (eslint)

'ctx' is defined but never used. Allowed unused args must match /^_/u.

---

**no-unused-vars** – `src/core/audio/nodes/basicNodes.ts:25` (eslint)

'ctx' is defined but never used.

---

**no-unused-vars** – `src/core/audio/nodes/basicNodes.ts:31` (eslint)

'sourceBuffer' is defined but never used.

---

**no-unused-vars** – `src/core/audio/nodes/basicNodes.ts:31` (eslint)

'sourceSampleRate' is assigned a value but never used.

---

**no-unused-vars** – `src/core/audio/runtime/ipc.ts:38` (eslint)

'message' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/ipc.ts:39` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/ipc.ts:39` (eslint)

'message' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/ipc.ts:40` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/ipc.ts:40` (eslint)

'response' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/NativeRuntimeAudioBackend.ts:35` (eslint)

'event' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/NativeRuntimeAudioBackend.ts:38` (eslint)

'client' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/NativeRuntimeAudioBackend.ts:120` (eslint)

'event' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/NativeRuntimeClient.ts:26` (eslint)

'v' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/NativeRuntimeClient.ts:26` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/NativeRuntimeClient.ts:27` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/NativeRuntimeClient.ts:55` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/NativeRuntimeSpawner.ts:21` (eslint)

'binPath' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/StdioTransport.ts:16` (eslint)

'stdin' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/StdioTransport.ts:36` (eslint)

'message' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/StdioTransport.ts:37` (eslint)

'response' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/StdioTransport.ts:44` (eslint)

'message' is defined but never used.

---

**no-unused-vars** – `src/core/audio/runtime/StdioTransport.ts:48` (eslint)

'response' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:30` (eslint)

'target' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:31` (eslint)

'target' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:46` (eslint)

'value' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:47` (eslint)

'value' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:47` (eslint)

'time' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:49` (eslint)

'time' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:71` (eslint)

'ctx' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:83` (eslint)

'node' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:84` (eslint)

'nodeOrId' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:85` (eslint)

'source' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:85` (eslint)

'target' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:86` (eslint)

'source' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:86` (eslint)

'target' is defined but never used.

---

**no-unused-vars** – `src/core/audio/types.ts:88` (eslint)

'ctx' is defined but never used.

---

**no-unused-vars** – `src/core/clock/MasterClock.ts:48` (eslint)

'onMetrics' is defined but never used.

---

**no-unused-vars** – `src/core/clock/MasterClock.ts:48` (eslint)

's' is defined but never used.

---

**no-unused-vars** – `src/core/clock/MonastryMasterClock.ts:30` (eslint)

'bpm' is defined but never used.

---

**no-unused-vars** – `src/core/clock/MonastryMasterClock.ts:31` (eslint)

'swing' is defined but never used.

---

**no-unused-vars** – `src/core/clock/MonastryMasterClock.ts:36` (eslint)

'silent' is defined but never used.

---

**no-unused-vars** – `src/core/clock/MonastryMasterClock.ts:39` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/computeLocal.ts:7` (eslint)

'input' is defined but never used.

---

**prefer-const** – `src/core/drop/AiDropGenerator.ts:169` (eslint)

'baseProfile' is never reassigned. Use 'const' instead.

---

**no-unused-vars** – `src/core/drop/AiServerBridge.ts:7` (eslint)

'DropProfile' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/drop/AiServerBridge.ts:7` (eslint)

'DropProfile' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/drop/ClockBridge.ts:50` (eslint)

'state' is defined but never used.

---

**no-unused-vars** – `src/core/drop/ClockBridge.ts:185` (eslint)

'state' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropAudioAdapter.ts:23` (eslint)

'channelId' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropAudioAdapter.ts:23` (eslint)

'level' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropAudioAdapter.ts:25` (eslint)

'channelId' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropAudioAdapter.ts:25` (eslint)

'pan' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropAudioAdapter.ts:27` (eslint)

'channelId' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropAudioAdapter.ts:27` (eslint)

'muted' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropAudioAdapter.ts:32` (eslint)

'pluginId' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropAudioAdapter.ts:32` (eslint)

'parameterId' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropAudioAdapter.ts:32` (eslint)

'value' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropContextAnalyzer.ts:11` (eslint)

'getDropProfilesForPlugins' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/drop/DropContextAnalyzer.ts:11` (eslint)

'getDropProfilesForPlugins' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/drop/DropContextAnalyzer.ts:224` (eslint)

'context' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/drop/DropContextAnalyzer.ts:224` (eslint)

'context' is defined but never used. Allowed unused args must match /^_/u.

---

**no-unused-vars** – `src/core/drop/DropEngine.ts:16` (eslint)

'progress' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropEngine.ts:40` (eslint)

'profileId' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropEngine.ts:41` (eslint)

'progress' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropEngine.ts:41` (eslint)

'profileId' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropEngine.ts:42` (eslint)

'profileId' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropEngine.ts:43` (eslint)

'pluginId' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropEngine.ts:43` (eslint)

'parameterId' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropEngine.ts:43` (eslint)

'value' is defined but never used.

---

**no-unused-vars** – `src/core/drop/DropEngine.ts:44` (eslint)

'error' is defined but never used.

---

**no-unused-vars** – `src/core/drop/PluginParameterBridge.ts:136` (eslint)

'progress' is defined but never used.

---

**no-unused-vars** – `src/core/edge/EdgeDspClient.ts:29` (eslint)

's' is defined but never used.

---

**no-unused-vars** – `src/core/edge/EdgeDspClient.ts:37` (eslint)

's' is defined but never used.

---

**no-unused-vars** – `src/core/edge/FailoverController.ts:16` (eslint)

'from' is defined but never used.

---

**no-unused-vars** – `src/core/edge/FailoverController.ts:16` (eslint)

'to' is defined but never used.

---

**no-unused-vars** – `src/core/edge/FailoverController.ts:16` (eslint)

'state' is defined but never used.

---

**no-unused-vars** – `src/core/edge/FailoverController.ts:20` (eslint)

'from' is defined but never used.

---

**no-unused-vars** – `src/core/edge/FailoverController.ts:20` (eslint)

'to' is defined but never used.

---

**no-unused-vars** – `src/core/edge/FailoverController.ts:20` (eslint)

'state' is defined but never used.

---

**no-unused-vars** – `src/core/events/ControlBus.ts:9` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/AudioDeviceManager.ts:63` (eslint)

'deviceId' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/AudioDeviceManager.ts:70` (eslint)

'deviceId' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/AudioDeviceManager.ts:72` (eslint)

'deviceId' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/AudioDeviceManager.ts:74` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/AudioDeviceManager.ts:74` (eslint)

'event' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/AudioDeviceManager.ts:81` (eslint)

'event' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/AudioDeviceManager.ts:92` (eslint)

'event' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/ControlHub.ts:26` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/ControlHub.ts:80` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/diagnostics.ts:30` (eslint)

'entry' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/diagnostics.ts:52` (eslint)

'entry' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/HardwareSimulator.ts:10` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/HardwareSimulator.ts:13` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/HotplugManager.ts:35` (eslint)

'event' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/HotplugManager.ts:36` (eslint)

'device' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/HotplugManager.ts:39` (eslint)

'device' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/HotplugManager.ts:44` (eslint)

'event' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/midiClockOut.ts:28` (eslint)

'data' is defined but never used.

---

**no-unused-vars** – `src/core/hardware/midiClockOut.ts:28` (eslint)

'timestampMs' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/catalog.ts:16` (eslint)

'SynthDef' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/instrument/catalog.ts:16` (eslint)

'SynthDef' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/instrument/catalog.ts:16` (eslint)

'FmDef' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/instrument/catalog.ts:16` (eslint)

'FmDef' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/instrument/catalog.ts:16` (eslint)

'DrumDef' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/instrument/catalog.ts:16` (eslint)

'DrumDef' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/instrument/catalog.ts:16` (eslint)

'FxDef' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/instrument/catalog.ts:16` (eslint)

'FxDef' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:28` (eslint)

'category' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:31` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:36` (eslint)

'note' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:36` (eslint)

'velocity' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:38` (eslint)

'time' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:41` (eslint)

'name' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:41` (eslint)

'value' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:46` (eslint)

'label' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:48` (eslint)

'label' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:51` (eslint)

'channelId' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:51` (eslint)

'routeTo' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:57` (eslint)

'program' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:57` (eslint)

'channel' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/IInstrumentBackend.ts:60` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/InstrumentBackend.ts:20` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/InstrumentBackend.ts:21` (eslint)

'note' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/InstrumentBackend.ts:22` (eslint)

'time' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/InstrumentBackend.ts:23` (eslint)

'def' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/InstrumentBackend.ts:23` (eslint)

'note' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/InstrumentBackend.ts:23` (eslint)

'velocity' is defined but never used.

---

**no-unused-vars** – `src/core/instrument/InstrumentBackend.ts:121` (eslint)

'_channel' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:46` (eslint)

'bpm' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:50` (eslint)

'track' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:50` (eslint)

'url' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:52` (eslint)

'track' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:52` (eslint)

'velocity' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:52` (eslint)

'time' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:55` (eslint)

'track' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:55` (eslint)

'gain01' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:56` (eslint)

'track' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:56` (eslint)

'pan' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:58` (eslint)

'track' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:58` (eslint)

'band' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:58` (eslint)

'gain' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:61` (eslint)

'gain01' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:64` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:64` (eslint)

'step' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:90` (eslint)

'kind' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:90` (eslint)

'task' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:92` (eslint)

'task' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:92` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:109` (eslint)

'job' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:127` (eslint)

'src' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:129` (eslint)

'signal' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:129` (eslint)

'source' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:131` (eslint)

'setupId' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:162` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:162` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:164` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:164` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:166` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:228` (eslint)

'sessionId' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:228` (eslint)

'userId' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:232` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:234` (eslint)

'peerId' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:234` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:236` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:236` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:236` (eslint)

'fromPeerId' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:237` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:237` (eslint)

'peerId' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:238` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/core/interfaces.ts:238` (eslint)

'peerId' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:19` (eslint)

'deviceId' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:19` (eslint)

'sampleRate' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:19` (eslint)

'bufferSize' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:22` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:22` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:22` (eslint)

'output' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:39` (eslint)

'_deviceId' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:39` (eslint)

'_sampleRate' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:39` (eslint)

'_bufferSize' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:45` (eslint)

'_cb' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:45` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/native/NativeAudioBackend.ts:45` (eslint)

'output' is defined but never used.

---

**no-unused-vars** – `src/core/sampler/sfzStreaming.ts:47` (eslint)

'budgetBytes' is assigned a value but never used.

---

**no-unused-vars** – `src/core/session/SessionMediaStore.ts:22` (eslint)

'item' is defined but never used.

---

**no-unused-vars** – `src/core/session/SessionMediaStore.ts:23` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/session/SessionMediaStore.ts:24` (eslint)

'userId' is defined but never used.

---

**no-unused-vars** – `src/core/session/SessionMediaStore.ts:26` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/session/SessionMediaStore.ts:27` (eslint)

'userId' is defined but never used.

---

**no-unused-vars** – `src/core/session/sessionScratchpad.ts:124` (eslint)

'mime' is defined but never used.

---

**no-unused-vars** – `src/core/session/sessionScratchpad.ts:124` (eslint)

'value' is defined but never used.

---

**no-unused-vars** – `src/core/session/sessionScratchpad.ts:129` (eslint)

'mime' is defined but never used.

---

**no-unused-vars** – `src/core/session/sessionScratchpad.ts:129` (eslint)

'value' is defined but never used.

---

**no-unused-vars** – `src/core/session/sessionScratchpad.ts:134` (eslint)

'mime' is defined but never used.

---

**no-unused-vars** – `src/core/session/stateReplication.ts:35` (eslint)

'peerId' is defined but never used.

---

**no-unused-vars** – `src/core/session/stateReplication.ts:121` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/session/stateReplication.ts:121` (eslint)

'type' is defined but never used.

---

**no-unused-vars** – `src/core/session/stateReplication.ts:121` (eslint)

'data' is defined but never used.

---

**no-unused-vars** – `src/core/session/stateReplication.ts:121` (eslint)

'version' is defined but never used.

---

**no-unused-vars** – `src/core/session/stateReplication.ts:122` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/session/stateReplication.ts:122` (eslint)

'data' is defined but never used.

---

**no-unused-vars** – `src/core/session/stateReplication.ts:123` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/session/stateReplication.ts:124` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/core/spatial/SceneRenderers.ts:16` (eslint)

'scene' is defined but never used.

---

**no-unused-vars** – `src/core/spatial/SceneRenderers.ts:16` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/spatial/SourceExtractionPipeline.ts:30` (eslint)

'source' is defined but never used.

---

**no-unused-vars** – `src/core/spatial/SourceExtractionPipeline.ts:31` (eslint)

'source' is defined but never used.

---

**no-unused-vars** – `src/core/spatial/SourceExtractionPipeline.ts:77` (eslint)

'_source' is defined but never used.

---

**no-unused-vars** – `src/core/spatial/SourceExtractionPipeline.ts:101` (eslint)

'scene' is defined but never used.

---

**no-unused-vars** – `src/core/spatial/spatialRenderers.ts:45` (eslint)

'_src' is defined but never used.

---

**no-unused-vars** – `src/core/spatial/spatialRenderers.ts:83` (eslint)

'_src' is defined but never used.

---

**no-unused-vars** – `src/core/spatial/spatialRenderers.ts:114` (eslint)

'_src' is defined but never used.

---

**no-unused-vars** – `src/core/spatial/SpatialScene.ts:82` (eslint)

'room' is assigned a value but never used.

---

**no-unused-vars** – `src/core/spatial/SpatialScene.ts:83` (eslint)

'listener' is assigned a value but never used.

---

**no-unused-vars** – `src/core/spatial/SpatialScene.ts:91` (eslint)

'outputLayout' is assigned a value but never used.

---

**no-unused-vars** – `src/core/spatial/SpatialScene.ts:92` (eslint)

'mode' is assigned a value but never used.

---

**no-unused-vars** – `src/core/transport/MediasoupTransport.ts:33` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `src/core/transport/MediasoupTransport.ts:33` (eslint)

'fromPeerId' is defined but never used.

---

**no-unused-vars** – `src/core/transport/MediasoupTransport.ts:34` (eslint)

'peerId' is defined but never used.

---

**no-unused-vars** – `src/core/transport/MediasoupTransport.ts:35` (eslint)

'peerId' is defined but never used.

---

**no-unused-vars** – `src/core/transport/MediasoupTransport.ts:37` (eslint)

'producers' is defined but never used.

---

**no-unused-vars** – `src/core/transport/TransportRegistry.ts:18` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `src/core/transport/TransportRegistry.ts:18` (eslint)

'fromPeerId' is defined but never used.

---

**no-unused-vars** – `src/core/transport/TransportRegistry.ts:19` (eslint)

'peerId' is defined but never used.

---

**no-unused-vars** – `src/core/transport/TransportRegistry.ts:20` (eslint)

'peerId' is defined but never used.

---

**no-unused-vars** – `src/core/voice/melody.ts:23` (eslint)

'frames' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/voice/melody.ts:23` (eslint)

'frames' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/voice/melody.ts:90` (eslint)

'b1' is defined but never used.

---

**no-unused-vars** – `src/core/voice/melody.ts:90` (eslint)

'a1' is defined but never used.

---

**no-unused-vars** – `src/core/voice/melody.ts:90` (eslint)

'a2' is defined but never used.

---

**no-unused-vars** – `src/core/voice/SingingEngine.ts:31` (eslint)

'model' is defined but never used.

---

**no-unused-vars** – `src/core/voice/SingingEngine.ts:32` (eslint)

'phrase' is defined but never used.

---

**no-unused-vars** – `src/core/voice/SingingEngine.ts:33` (eslint)

'text' is defined but never used.

---

**no-unused-vars** – `src/core/voice/SongGenerator.ts:21` (eslint)

'prompt' is defined but never used.

---

**no-unused-vars** – `src/core/voice/SongGenerator.ts:21` (eslint)

'options' is defined but never used.

---

**no-unused-vars** – `src/core/voice/SongOutputBridge.ts:14` (eslint)

'source' is defined but never used.

---

**no-unused-vars** – `src/core/voice/SongOutputBridge.ts:31` (eslint)

'sink' is defined but never used.

---

**no-unused-vars** – `src/core/voice/SpeechToIntent.ts:17` (eslint)

'command' is defined but never used.

---

**no-unused-vars** – `src/core/voice/VoiceControlService.ts:18` (eslint)

'ctx' is defined but never used.

---

**no-unused-vars** – `src/core/voice/VoiceMonkService.ts:13` (eslint)

'renderMelodyWav' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/voice/VoiceMonkService.ts:13` (eslint)

'renderMelodyWav' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/voice/VoiceMonkService.ts:31` (eslint)

'text' is defined but never used.

---

**no-unused-vars** – `src/core/voice/VoiceMonkService.ts:31` (eslint)

'options' is defined but never used.

---

**no-unused-vars** – `src/core/voice/VoiceMonkService.ts:109` (eslint)

'text' is defined but never used.

---

**no-unused-vars** – `src/core/voice/VoiceMonkService.ts:109` (eslint)

'notes' is defined but never used.

---

**no-unused-vars** – `src/core/voice/VoiceMonkService.ts:109` (eslint)

'bpm' is defined but never used.

---

**no-unused-vars** – `src/core/voice/VoiceMonkService.ts:120` (eslint)

'_notes' is defined but never used.

---

**no-unused-vars** – `src/core/voice/VoiceMonkService.ts:120` (eslint)

'_bpm' is defined but never used.

---

**no-unused-vars** – `src/core/voice/WebSpeechTtsProvider.ts:12` (eslint)

'text' is defined but never used.

---

**no-unused-vars** – `src/core/voice/WebSpeechTtsProvider.ts:12` (eslint)

'options' is defined but never used.

---

**no-unused-vars** – `src/core/WebAudioBackend.ts:48` (eslint)

'_time' is defined but never used.

---

**no-unused-vars** – `src/core/WebAudioBackend.ts:72` (eslint)

'step' is defined but never used.

---

**no-unused-vars** – `src/core/workers/AsyncSandbox.ts:10` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/workers/computeWorker.ts:11` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/workers/computeWorker.ts:34` (eslint)

'input' is defined but never used.

---

**no-unused-vars** – `src/core/workers/RingBuffer.ts:14` (eslint)

'T' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/workers/RingBuffer.ts:14` (eslint)

'T' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/workers/WorkerPool.ts:20` (eslint)

'v' is defined but never used.

---

**no-unused-vars** – `src/core/workers/WorkerPool.ts:21` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `src/core/workers/WorkerPool.ts:51` (eslint)

'T' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/core/workers/WorkerPool.ts:51` (eslint)

'T' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/core/workers/WorkerPool.ts:64` (eslint)

'v' is defined but never used.

---

**@typescript-eslint/no-unused-expressions** – `src/core/workers/WorkerPool.ts:83` (eslint)

Expected an assignment or function call and instead saw an expression.

---

**no-unused-vars** – `src/core/workers/WorkerPool.ts:91` (eslint)

'd' is defined but never used.

---

**no-unused-vars** – `src/core/workers/WorkletPool.ts:11` (eslint)

'msg' is defined but never used.

---

**prefer-const** – `src/data/musicLibrary.ts:20` (eslint)

'title' is never reassigned. Use 'const' instead.

---

**no-unused-vars** – `src/hooks/useAudioAI.ts:24` (eslint)

'e' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/hooks/useAudioAI.ts:24` (eslint)

'e' is defined but never used.

---

**react-hooks/exhaustive-deps** – `src/hooks/useMIDI.ts:183` (eslint)

The ref value 'boundInputs.current' will likely have changed by the time this effect cleanup function runs. If this ref points to a node rendered by React, copy 'boundInputs.current' to a variable inside the effect, and use that variable in the cleanup function.

---

**react-hooks/exhaustive-deps** – `src/hooks/useMIDI.ts:185` (eslint)

The ref value 'parsers.current' will likely have changed by the time this effect cleanup function runs. If this ref points to a node rendered by React, copy 'parsers.current' to a variable inside the effect, and use that variable in the cleanup function.

---

**no-unused-vars** – `src/hooks/useMidiClockOut.ts:25` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/hooks/useMidiClockOut.ts:28` (eslint)

'on' is defined but never used.

---

**`as never` assertion bypasses full Sample type validation** – `src/hooks/useSessionSync.ts:24` (deepseek-pro)

The incoming ADD branch validates only id, name, and url, then casts the object to `never` when calling addToScratchpad. This bypasses TypeScript's type checking and allows objects that may be missing other required Sample fields to enter the scratchpad state, potentially causing downstream runtime errors.

*Evidenz:* addToScratchpad(sample as never);

*Empfehlung:* Replace the partial checks with a complete type guard for the Sample shape and call addToScratchpad with the properly typed variable (no `as never` or `as any`).

---

**react-hooks/exhaustive-deps** – `src/hooks/useWebRTC.ts:40` (eslint)

React Hook useEffect has missing dependencies: 'handleAnswer', 'handleCandidate', 'handleOffer', and 'peers'. Either include them or remove the dependency array.

---

**no-unused-vars** – `src/plugins/dsp-engine/DspEnginePlugin.tsx:25` (eslint)

'_timestamp' is defined but never used.

---

**no-unused-vars** – `src/plugins/mischpult/MischpultPlugin.tsx:2` (eslint)

'Sliders' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/plugins/mischpult/MischpultPlugin.tsx:2` (eslint)

'Sliders' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/plugins/mischpult/MischpultPlugin.tsx:2` (eslint)

'Volume2' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/plugins/mischpult/MischpultPlugin.tsx:2` (eslint)

'Volume2' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/plugins/mischpult/MischpultPlugin.tsx:4` (eslint)

'_plugin' is defined but never used.

---

**no-unused-vars** – `src/plugins/mischpult/MischpultPlugin.tsx:4` (eslint)

'_currentUserId' is defined but never used.

---

**no-unused-vars** – `src/plugins/mischpult/MischpultPlugin.tsx:5` (eslint)

'_chId' is defined but never used.

---

**no-unused-vars** – `src/plugins/mischpult/MischpultPlugin.tsx:5` (eslint)

'_bus' is defined but never used.

---

**no-unused-vars** – `src/plugins/PluginBase.tsx:9` (eslint)

'state' is defined but never used.

---

**no-unused-vars** – `src/plugins/types.ts:13` (eslint)

'userId' is defined but never used.

---

**no-unused-vars** – `src/plugins/types.ts:14` (eslint)

'userId' is defined but never used.

---

**no-unused-vars** – `src/plugins/types.ts:15` (eslint)

'newState' is defined but never used.

---

**no-unused-vars** – `src/utils/audioAnalyzer.ts:153` (eslint)

'binHz' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/utils/audioAnalyzer.ts:153` (eslint)

'binHz' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/utils/audioAnalyzer.ts:158` (eslint)

'center' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/utils/audioAnalyzer.ts:158` (eslint)

'center' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/utils/audioAnalyzer.ts:216` (eslint)

'fn' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/utils/audioAnalyzer.ts:216` (eslint)

'fn' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/utils/audioContextFactory.ts:8` (eslint)

'options' is defined but never used.

---

**no-unused-vars** – `src/utils/audioDeviceManager.ts:71` (eslint)

'change' is defined but never used.

---

**no-unused-vars** – `src/utils/audioDeviceManager.ts:177` (eslint)

'change' is defined but never used.

---

**no-unused-vars** – `src/utils/audioDeviceManager.ts:191` (eslint)

'type' is defined but never used.

---

**no-unused-vars** – `src/utils/audioDeviceManager.ts:191` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/utils/audioDeviceManager.ts:192` (eslint)

'type' is defined but never used.

---

**no-unused-vars** – `src/utils/audioDeviceManager.ts:192` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/utils/audioDeviceManager.ts:217` (eslint)

'type' is defined but never used.

---

**no-unused-vars** – `src/utils/audioDeviceManager.ts:217` (eslint)

'cb' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:2` (eslint)

'random' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `src/utils/audioEngine.ts:2` (eslint)

'random' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/utils/audioEngine.ts:106` (eslint)

'data' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:107` (eslint)

'value' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:109` (eslint)

'state' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:211` (eslint)

'step' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:212` (eslint)

'step' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:213` (eslint)

'step' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:216` (eslint)

'step' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:354` (eslint)

'count' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:585` (eslint)

'n' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:586` (eslint)

'n' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:1118` (eslint)

'rawCtx' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `src/utils/audioEngine.ts:1118` (eslint)

'rawCtx' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `src/utils/audioEngine.ts:1219` (eslint)

'_state' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:1655` (eslint)

'step' is defined but never used.

---

**prefer-const** – `src/utils/audioEngine.ts:1946` (eslint)

'semitone' is never reassigned. Use 'const' instead.

---

**@typescript-eslint/ban-ts-comment** – `src/utils/audioEngine.ts:1963` (eslint)

Use "@ts-expect-error" instead of "@ts-ignore", as "@ts-ignore" will do nothing if the following line is error-free.

---

**@typescript-eslint/ban-ts-comment** – `src/utils/audioEngine.ts:1965` (eslint)

Use "@ts-expect-error" instead of "@ts-ignore", as "@ts-ignore" will do nothing if the following line is error-free.

---

**no-unused-vars** – `src/utils/audioEngine.ts:2265` (eslint)

'active' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:2317` (eslint)

'id' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:2342` (eslint)

'_ctx' is defined but never used.

---

**no-unused-vars** – `src/utils/audioEngine.ts:2543` (eslint)

'_i' is defined but never used.

---

**no-unused-vars** – `src/utils/ClockSync.ts:7` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `src/utils/collab.ts:87` (eslint)

'_sessionId' is assigned a value but never used.

---

**no-unused-vars** – `src/utils/crdt.ts:17` (eslint)

'peer' is defined but never used.

---

**no-unused-vars** – `src/utils/crdt.ts:68` (eslint)

'minStepSec' is assigned a value but never used.

---

**no-unused-vars** – `src/utils/crdt.ts:69` (eslint)

'maxForwardStep' is assigned a value but never used.

---

**ESLint-Finding** – `src/utils/LocalEmbeddingProvider.ts:41` (eslint)

Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-var-requires').

---

**no-unused-vars** – `src/utils/ObjectPool.ts:10` (eslint)

'item' is defined but never used.

---

**no-unused-vars** – `src/utils/ObjectPool.ts:12` (eslint)

'item' is defined but never used.

---

**no-unused-vars** – `src/utils/rbac.ts:177` (eslint)

'userId' is defined but never used.

---

**no-unused-vars** – `src/utils/rbac.ts:177` (eslint)

't' is defined but never used.

---

**no-unused-vars** – `src/utils/rbac.ts:179` (eslint)

'userId' is defined but never used.

---

**no-unused-vars** – `src/utils/rbac.ts:179` (eslint)

't' is defined but never used.

---

**no-unused-vars** – `src/utils/RbacCache.ts:18` (eslint)

'ttlMs' is assigned a value but never used.

---

**no-unused-vars** – `src/utils/stemSplitter.ts:64` (eslint)

'p' is defined but never used.

---

**no-unused-vars** – `src/utils/stemSplitter.ts:106` (eslint)

'ctx' is defined but never used.

---

**no-unused-vars** – `src/utils/telemetry.ts:49` (eslint)

'pipeline' is defined but never used.

---

**no-unused-vars** – `src/utils/telemetry.ts:49` (eslint)

'lastMs' is defined but never used.

---

**no-unused-vars** – `src/utils/telemetry.ts:49` (eslint)

'budgetMs' is defined but never used.

---

**no-unused-vars** – `src/utils/telemetry.ts:55` (eslint)

'pipeline' is defined but never used.

---

**no-unused-vars** – `src/utils/telemetry.ts:55` (eslint)

'lastMs' is defined but never used.

---

**no-unused-vars** – `src/utils/telemetry.ts:55` (eslint)

'budgetMs' is defined but never used.

---

**prefer-const** – `src/utils/usageAnalytics.ts:16` (eslint)

'state' is never reassigned. Use 'const' instead.

---

**no-unused-vars** – `src/utils/WebRTCManager.ts:53` (eslint)

'stream' is defined but never used.

---

**no-unused-vars** – `src/utils/WebRTCManager.ts:53` (eslint)

'senderId' is defined but never used.

---

**no-unused-vars** – `src/utils/WebRTCManager.ts:89` (eslint)

'stream' is defined but never used.

---

**no-unused-vars** – `src/utils/WebRTCManager.ts:89` (eslint)

'senderId' is defined but never used.

---

**no-unused-vars** – `src/utils/WebRTCManager.ts:90` (eslint)

'message' is defined but never used.

---

**no-unused-vars** – `src/utils/WebRTCManager.ts:93` (eslint)

'message' is defined but never used.

---

**no-unused-vars** – `src/utils/WebRTCManager.ts:95` (eslint)

'message' is defined but never used.

---

**no-unused-vars** – `src/utils/WebRTCManager.ts:126` (eslint)

'info' is defined but never used.

---

**Doppelter Zugriff auf Socket-Instanz** – `src/utils/WebRTCManager.ts:270` (hf-qwen)

In mehreren Stellen wird `this.socket` direkt verwendet, ohne vorher zu prüfen, ob es definiert ist. Dies kann zu Fehlern führen, wenn der Socket nicht initialisiert wurde.

*Evidenz:* this.socket?.emit('join-session', { userId: this.sessionUserId, mode: this.masterOutMode ? 'master-out' : 'member' });

*Empfehlung:* Füge eine explizite Prüfung hinzu, ob `this.socket` definiert ist, bevor es verwendet wird, um sicherzustellen, dass keine Operationen auf einem nicht-initialisierten Socket ausgeführt werden.

---

**no-unused-vars** – `tests/aiControl.test.ts:168` (eslint)

'req' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `tests/aiControl.test.ts:168` (eslint)

'req' is defined but never used. Allowed unused args must match /^_/u.

---

**no-unused-vars** – `tests/aiRateLimitRoutes.test.ts:2` (eslint)

'http' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `tests/aiRateLimitRoutes.test.ts:2` (eslint)

'http' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `tests/aiSecurity.test.ts:2` (eslint)

'http' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `tests/aiSecurity.test.ts:2` (eslint)

'http' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `tests/architecture.test.ts:27` (eslint)

'_ctx' is defined but never used.

---

**no-unused-vars** – `tests/audioEngine.test.ts:82` (eslint)

'step' is defined but never used.

---

**no-unused-vars** – `tests/clock.test.ts:11` (eslint)

'now' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `tests/clock.test.ts:11` (eslint)

'now' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `tests/clock.test.ts:52` (eslint)

'b' is assigned a value but never used.

---

**@typescript-eslint/no-unused-vars** – `tests/clock.test.ts:52` (eslint)

'b' is assigned a value but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `tests/clockProcessorWorklet.test.ts:27` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `tests/clockProcessorWorklet.test.ts:28` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `tests/clockProcessorWorklet.test.ts:30` (eslint)

'inputs' is defined but never used.

---

**no-unused-vars** – `tests/clockProcessorWorklet.test.ts:30` (eslint)

'outputs' is defined but never used.

---

**no-unused-vars** – `tests/clockProcessorWorklet.test.ts:30` (eslint)

'parameters' is defined but never used.

---

**no-unused-vars** – `tests/clockProcessorWorklet.test.ts:63` (eslint)

'm' is defined but never used.

---

**no-unused-vars** – `tests/controlHub.test.ts:7` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `tests/controlHub.test.ts:8` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `tests/controlHub.test.ts:21` (eslint)

'msg' is defined but never used.

---

**no-unused-vars** – `tests/controlHub.test.ts:22` (eslint)

'ev' is defined but never used.

---

**no-unused-vars** – `tests/controlHub.test.ts:23` (eslint)

'_msg' is defined but never used.

---

**no-unused-vars** – `tests/coverageGaps.test.ts:167` (eslint)

'_url' is defined but never used.

---

**no-unused-vars** – `tests/coverageGaps.test.ts:167` (eslint)

'_opts' is defined but never used.

---

**no-unused-vars** – `tests/coverageGaps.test.ts:252` (eslint)

'channels' is defined but never used.

---

**no-unused-vars** – `tests/coverageGaps.test.ts:252` (eslint)

'length' is defined but never used.

---

**no-unused-vars** – `tests/coverageGaps.test.ts:252` (eslint)

'sampleRate' is defined but never used.

---

**no-unused-vars** – `tests/coverageGaps.test.ts:255` (eslint)

'length' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `tests/coverageGaps.test.ts:255` (eslint)

'length' is defined but never used. Allowed unused args must match /^_/u.

---

**no-unused-vars** – `tests/coverageGaps.test.ts:255` (eslint)

'_sr' is defined but never used.

---

**no-unused-vars** – `tests/coverageGaps.test.ts:258` (eslint)

'_buf' is defined but never used.

---

**no-unused-vars** – `tests/coverageGaps.test.ts:310` (eslint)

'_c' is defined but never used.

---

**no-unused-vars** – `tests/coverageGaps.test.ts:310` (eslint)

'_l' is defined but never used.

---

**no-unused-vars** – `tests/coverageGaps.test.ts:310` (eslint)

'_sr' is defined but never used.

---

**no-unused-vars** – `tests/drumSynthProcessorWorklet.test.ts:8` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `tests/drumSynthProcessorWorklet.test.ts:9` (eslint)

'inputs' is defined but never used.

---

**no-unused-vars** – `tests/drumSynthProcessorWorklet.test.ts:9` (eslint)

'outputs' is defined but never used.

---

**no-unused-vars** – `tests/e2e/hardware.spec.ts:24` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `tests/e2e/hardware.spec.ts:25` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `tests/e2e/hardware.spec.ts:39` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `tests/e2e/responsive.spec.ts:22` (eslint)

'_drop' is assigned a value but never used.

---

**no-unused-vars** – `tests/fm6ProcessorWorklet.test.ts:9` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `tests/fm6ProcessorWorklet.test.ts:10` (eslint)

'inputs' is defined but never used.

---

**no-unused-vars** – `tests/fm6ProcessorWorklet.test.ts:10` (eslint)

'outputs' is defined but never used.

---

**no-unused-vars** – `tests/granularProcessorWorklet.test.ts:9` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `tests/granularProcessorWorklet.test.ts:10` (eslint)

'inputs' is defined but never used.

---

**no-unused-vars** – `tests/granularProcessorWorklet.test.ts:10` (eslint)

'outputs' is defined but never used.

---

**no-unused-vars** – `tests/masteringProcessorWorklet.test.ts:18` (eslint)

'e' is defined but never used.

---

**no-unused-vars** – `tests/masteringProcessorWorklet.test.ts:19` (eslint)

'inputs' is defined but never used.

---

**no-unused-vars** – `tests/masteringProcessorWorklet.test.ts:19` (eslint)

'outputs' is defined but never used.

---

**no-unused-vars** – `tests/masteringProcessorWorklet.test.ts:65` (eslint)

's' is defined but never used.

---

**no-unused-vars** – `tests/masteringProcessorWorklet.test.ts:65` (eslint)

'sr' is defined but never used.

---

**no-unused-vars** – `tests/monitorRouting.test.ts:174` (eslint)

'_ts' is assigned a value but never used.

---

**no-unused-vars** – `tests/nativeRuntimeBackend.test.ts:8` (eslint)

'r' is defined but never used.

---

**no-unused-vars** – `tests/nativeRuntimeBackend.test.ts:9` (eslint)

'm' is defined but never used.

---

**no-unused-vars** – `tests/nativeRuntimeBackend.test.ts:12` (eslint)

'payloads' is defined but never used.

---

**no-unused-vars** – `tests/nativeRuntimeBackend.test.ts:22` (eslint)

'message' is defined but never used.

---

**no-unused-vars** – `tests/nativeRuntimeBackend.test.ts:23` (eslint)

'response' is defined but never used.

---

**no-unused-vars** – `tests/phase2Runtime.test.ts:20` (eslint)

'message' is defined but never used.

---

**no-unused-vars** – `tests/phase2Runtime.test.ts:21` (eslint)

'response' is defined but never used.

---

**no-unused-vars** – `tests/phase2Runtime.test.ts:29` (eslint)

'message' is defined but never used.

---

**no-unused-vars** – `tests/phase2Runtime.test.ts:30` (eslint)

'response' is defined but never used.

---

**no-unused-vars** – `tests/portalWorkerSnapshots.test.ts:18` (eslint)

'request' is defined but never used.

---

**no-unused-vars** – `tests/portalWorkerSnapshots.test.ts:18` (eslint)

'env' is defined but never used.

---

**no-unused-vars** – `tests/portalWorkerSnapshots.test.ts:65` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `tests/portalWorkerSnapshots.test.ts:66` (eslint)

'serverId' is defined but never used.

---

**no-unused-vars** – `tests/portalWorkerSnapshots.test.ts:66` (eslint)

'payload' is defined but never used.

---

**no-unused-vars** – `tests/promptCatalog.test.ts:11` (eslint)

'PLUGIN_MOA_TASKS' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `tests/promptCatalog.test.ts:11` (eslint)

'PLUGIN_MOA_TASKS' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `tests/storageRecovery.test.ts:87` (eslint)

'n' is defined but never used.

---

**no-unused-vars** – `tests/storageRecovery.test.ts:88` (eslint)

'n' is defined but never used.

---

**no-unused-vars** – `tests/storageRecovery.test.ts:100` (eslint)

'err' is defined but never used.

---

**no-unused-vars** – `tests/storageRecovery.test.ts:109` (eslint)

'err' is defined but never used.

---

**no-unused-vars** – `tests/telemetryXrun.test.ts:2` (eslint)

'http' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `tests/telemetryXrun.test.ts:2` (eslint)

'http' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `tests/v2AudioGraph.test.ts:2` (eslint)

'AudioGraph' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `tests/v2AudioGraph.test.ts:2` (eslint)

'AudioGraph' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `tests/v2AudioGraph.test.ts:86` (eslint)

'ctx' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `tests/v2AudioGraph.test.ts:86` (eslint)

'ctx' is defined but never used. Allowed unused args must match /^_/u.

---

**no-unused-vars** – `tests/voiceBrowser.test.ts:4` (eslint)

'DeterministicTtsProvider' is defined but never used.

---

**@typescript-eslint/no-unused-vars** – `tests/voiceBrowser.test.ts:4` (eslint)

'DeterministicTtsProvider' is defined but never used. Allowed unused vars must match /^_/u.

---

**no-unused-vars** – `tests/webrtcManager.test.ts:51` (eslint)

'd' is defined but never used.

---

**Code-Duplikat** – `utils/aiRhythmGenerator.ts:?` (jscpd)

Duplikat zwischen utils/aiRhythmGenerator.ts und utils/audioEngine.ts

*Evidenz:*   const patterns: Record<TrackType, boolean[]> = {
    channel1: Array(16).fill(false),
    channel2: Array(16).fill(false),
    channel3: Array(16).fill(false),
    channel4: Array(16).fill(false),
    channel5: Array(16).fill(false),
    channel6: Array(16).fill(false),
    channel7: Array(16).fill(false),
    channel8: Array(16).fill(false),

*Empfehlung:* Duplizierten Code in eine gemeinsame Funktion extrahieren.

---

</details>

### INFO (2)

| Quelle | Datei | Zeile | Kategorie | Titel |
|---|---|---|---|---|
| deepseek-flash | `services/samplemonk-ai-runtime/startup.sh` | 17 | architecture | Manifest default path creation not bounded to script directory after cd |
| deepseek-pro | `src/hooks/useSessionSync.ts` | 37 | architecture | No ordering/versioning for SCRATCHPAD_UPDATE messages |

<details>
<summary>Details öffnen</summary>

**Manifest default path creation not bounded to script directory after cd** – `services/samplemonk-ai-runtime/startup.sh:17` (deepseek-flash)

The default AI_MODEL_MANIFEST is set to $(pwd)/model_manifest.json, i.e., relative to the current working directory set on line 6. If line 6 is changed or overridden by a wrapper that first cd's somewhere else, the manifest default silently points to the wrong location.

*Evidenz:* export AI_MODEL_MANIFEST="${AI_MODEL_MANIFEST:-$(pwd)/model_manifest.json}"

*Empfehlung:* Use ${BASH_SOURCE[0]}-based script dir expansion before this line and set the default as "$SCRIPT_DIR/model_manifest.json".

---

**No ordering/versioning for SCRATCHPAD_UPDATE messages** – `src/hooks/useSessionSync.ts:37` (deepseek-pro)

SCRATCHPAD_UPDATE messages contain only type, action, and payload with no sequence number or timestamp. With multiple peers and possible out-of-order delivery (especially across different WebRTC data channels or reconnects), a later REMOVE can arrive before an earlier ADD for the same scratchpad item, causing state desync—violating the project's zero state desync mandate.

*Evidenz:* webRTCManager.sendData({ type: 'SCRATCHPAD_UPDATE', action: 'ADD', sample });
webRTCManager.sendData({ type: 'SCRATCHPAD_UPDATE', action: 'REMOVE', id });

*Empfehlung:* Add a monotonically increasing version/timestamp per scratchpad item or a session-wide operation sequence number and resolve conflicts on receipt.

---

</details>
