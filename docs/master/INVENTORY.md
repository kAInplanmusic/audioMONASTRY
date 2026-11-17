# audioMONASTRY - System Inventory (Golden Master V1)

## Git-Status
- **HEAD Commit:** f5538c636b5e1067055a21201ea10fe26773d7f7
- **Golden Master Tag:** gm-v1.0.0
- **Uncommitted Changes:** gesichert via `git stash`

## Branches
- **Aktuell:** fix/operator
- **Workspace Branches:** 16 erstellt (workspace/mixer, workspace/drop, ..., workspace/record)

## Worktrees (16/16 ✅)
- audioMONASTRY-mixer (workspace/mixer)
- audioMONASTRY-drop (workspace/drop)
- audioMONASTRY-song (workspace/song)
- audioMONASTRY-effect (workspace/effect)
- audioMONASTRY-syntisampler (workspace/syntisampler)
- audioMONASTRY-drumsampler (workspace/drumsampler)
- audioMONASTRY-instru (workspace/instru)
- audioMONASTRY-biblio (workspace/biblio)
- audioMONASTRY-voice (workspace/voice)
- audioMONASTRY-sound (workspace/sound)
- audioMONASTRY-stem (workspace/stem)
- audioMONASTRY-spatial (workspace/spatial)
- audioMONASTRY-eq (workspace/eq)
- audioMONASTRY-dsp (workspace/dsp)
- audioMONASTRY-master (workspace/master)
- audioMONASTRY-record (workspace/record, Hauptrepo)
Zusätzlich: audioMONASTRY-r16 (release/v1.0.0, Commit 7cc6686f)

## 16 Plugins (aus PluginAudioContract)

| ID | Name | Role | Channel | Format | Inputs | Outputs | Latency | Bypassable |
|---|---|---|---|---|---|---|---|---|
| mixer | mixerMONK | channel | - | stereo | 8 | 1 | 0 | false |
| drop | dropMONK | source | 1 | stereo | 0 | 1 | 0 | true |
| song | songMONK | source | 2 | stereo | 0 | 1 | 0 | true |
| effect | effectMONK | fxReturn | - | stereo | 1 | 1 | 0 | true |
| syntisampler | syntisamplerMONK | source | 4 | stereo | 0 | 1 | 0 | true |
| drumsampler | drumsamplerMONK | source | 3 | stereo | 0 | 1 | 0 | true |
| instru | instruMONK | source | 5 | stereo | 0 | 1 | 0 | true |
| biblio | biblioMONK | utility | - | stereo | 0 | 0 | 0 | false |
| voice | voiceMONK | source | 6 | mono→stereo | 0 | 1 | 0 | true |
| sound | soundMONK | source | 7 | stereo | 0 | 1 | 0 | true |
| stem | stemMONK | source | 8 | stereo | 0 | 1 | var | true |
| spatial | spatialMONK | insert | - | stereo | 1 | 1 | 0 | true |
| eq | eqMONK | insert | - | stereo | 1 | 1 | 0 | true |
| dsp | dspMONK | insert | - | stereo | 1 | 1 | 0-3 var | true |
| master | masterMONK | insert | - | stereo | 1 | 1 | 240 | true |
| record | recordMONK | recorder | - | stereo | 1 | 1 | 0 | false |

## Signal Chain
- **Channel Inserts:** spatial
- **Master Inserts:** eq → dsp → master
- **FX Returns:** effect
- **Recorders:** record

## AudioGraph
- **Sample Rate:** 48 kHz
- **Mastering Lookahead:** 5 ms (240 frames)

## Hetzner Infrastructure
- **Production Server:** audiomonastry-prod
- **Server ID:** 176399658
- **IP:** 135.181.251.14
- **Type:** ccx33
- **Location:** hel1
- **Image:** ubuntu-24.04
- **Node.js:** 22.23.5
- **PM2:** online (PID 19123)
- **Nginx:** Port 80/443

## DNS Status
- hallerbans.de → 135.181.251.14 (proxied=false ✅)
- www.hallerbans.de → CNAME hallerbans.de (proxied=false ✅)

## SSL Status
- Let's Encrypt Zertifikat gültig bis 2027-02-15
- Domains: hallerbans.de, www.hallerbans.de

## Worktree Status
- Branches erstellt: 16/16 ✅
- Worktrees erstellt: 16/16 ✅

## Phase C Audits (32 Audits)
- mixerMONK: ✅ Audit 1 (Idea Destroyer) unter docs/audit-AUDITOR.md; ✅ Audit 2 (Struktur) unter docs/audits/mixer_audit2_structure.md
- Alle 16 Plugins: ✅ je 2 Audits unter docs/audits/ (30 Dateien für drop, song, effect, syntisampler, drumsampler, instru, biblio, voice, sound, stem, spatial, eq, dsp, master, record)
- Gesamt: 32/32 Audits abgeschlossen

## Phase D: Full Integration
- ✅ P0: recordMONK Verkabelung, spatialMONK Einbauposition, masterMONK Limiter
- ✅ P1: Kanal-Nummerierung (instru→5, sound→7), eqMONK kanonische EQ
- ✅ P2: producesAudio (6 Adapter mit onProcess), Bypass-Crossfade (BasePluginAdapter)
- ✅ DI-Vollrefaktor: IAudioBackend erweitert (22+ Methoden), AudioEngineBackend + WebAudioBackend implementiert, BasePluginAdapter.getAudio() (context.audio ?? Fallback), alle 7 Adapter auf this.audio umgestellt (SyntiSampler, Record, Eq, Master, Spatial, Dsp, Effect), Test-Mocks ergänzt
- ✅ Build: tsc 0 Fehler, npm run build erfolgreich
- ✅ Deployment: dist auf Hetzner (135.181.251.14), PM2 PID 23302 online, HTTP 200

## Phase E: Produktion & Validierung
- ✅ Server online (PM2, PID 23302)
- ✅ HTTPS https://hallerbans.de → HTTP 200
- ✅ HTTP http://135.181.251.14 → HTTP 200
- ✅ SSL gültig bis 2027-02-15
- ✅ Neuer E2E-Test: tests/e2e/pluginNavigation.spec.ts (16 Plugins, 4 parallele Kontexte)
- ⏳ E2E-Test-Ausführung (Playwright gegen Server)