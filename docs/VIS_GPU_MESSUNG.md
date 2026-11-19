# vis · erste Messung auf echter GPU (RTX 4090, 2026-11-18)

Rohdaten: `docs/vis-gpu-test/rtx4090-2026-11-18/` (`results.json`, `summary.txt`).
Maschine: Vast-Instanz, 1× RTX 4090 (24 GB), Treiber 610.57, 12 vCPU, 32 GB RAM, Rumänien, ca. 0,44 $/h.
Lauf: `scripts/vis-gpu-selftest.py` in `nvidia/cuda:12.4.1-runtime` mit `NVIDIA_DRIVER_CAPABILITIES=all`,
Laufzeit rund 5 Minuten, 12 echte R2-Medien (6 Bilder, 6 Clips). Instanz danach zerstört.
Das ist die Testumgebung, nicht das gebaute vis-Image; der Nachweis am echten Image steht noch aus.

## Was funktioniert
- **WebGL auf der GPU nur mit `--use-angle=gl-egl`** (ANGLE/NVIDIA, OpenGL ES 3.2) oder `--use-angle=vulkan`.
  Ohne Flag und mit `--use-gl=egl` / `--use-angle=gl` fällt Chromium auf SwiftShader (Software) zurück.
- NVENC (`h264_nvenc`) läuft: 4 s 1080p30 in 0,55 s.
- Alle 25 Effekte kompilieren und rendern auf der GPU; 12/12 Medien geladen, keine übersprungen.
- Der Stream ist gültiger H.264 (1080p24/25/30 und 1440p30, ffprobe ok).

## Was das Ziel (24/25/30 fps) noch verfehlt
| Lauf | erreicht | späte Frames |
| --- | --- | --- |
| 1080p@30 NVENC | 19,1 fps | 269 / 383 |
| 1080p@25 NVENC | 18,2 fps | 235 / 364 |
| 1080p@24 NVENC | 18,3 fps | 233 / 367 |
| 1440p@30 NVENC | 16,6 fps | 333 / 333 |
| 1080p@30 libx264 | 15,5 fps | 206 |

Ursache liegt nicht im Shader: Rendern ist billig. Ohne Effekt braucht ein 1080p-Frame 26 ms, mit Effekten 27-32 ms
(Regisseur mit bis zu 3 Effekten: 39,5 ms). Einzige Ausnahme `noise` mit 79,5 ms (grob 53 ms Aufpreis).

## Zweite Messung: wo die ~27 ms hingehen (gleiche 4090-Klasse, 1080p, gl-egl)
Rohdaten: `frame-bench.*` und `readback-bench-{egl,vulkan}.json` im selben Ordner.

| Schritt | 1080p | 1440p |
| --- | --- | --- |
| `toDataURL` komplett (heutiger Pfad) | 27,4 ms (+ ca. 8 ms CDP) | 45,9 ms |
| `gl.readPixels` synchron | 7,5 ms | 13,5 ms |
| JPEG-Kodierung der Rohpixel allein | 29,2 ms | 50,3 ms |
| PBO: readPixels anstossen | 0,04 ms | 0,06 ms |
| PBO: Wartezeit bis die GPU fertig ist | 13,8 ms (Vulkan 6,3) | 41,1 ms (Vulkan 17,8) |
| PBO: `getBufferSubData` | 6,1 ms | 11,2 ms |

Befunde:
- **Engpass ist die JPEG-Kodierung** (ein CPU-Thread, ca. 20-29 ms bei 1080p), nicht das Auslesen und nicht der Shader.
- JPEG-Qualität ändert die Zeit praktisch nicht (Q88 28,6 ms, Q70 28,8 ms). `toBlob`/Burst ist langsamer (37,9-53,6 ms je Frame).
- `Page.captureScreenshot` ist nicht schneller (35 ms; Vulkan 58 ms). Vulkan statt gl-egl bringt beim Auslesen nichts,
  nur eine kürzere GPU-Wartezeit.
- **Rohe Pixel über die Browser-Steuerleitung (CDP) sind unbrauchbar**: als TypedArray 0,9-2,7 s je Frame;
  als Base64-String lokal gemessen (4 vCPU, nicht auf der GPU-Maschine) ca. 150 ms (yuv420p 1080p) bzw. 290 ms (1440p).

## Folgerung und Optionen (nichts davon umgesetzt)
Mit dem heutigen Weg (Frame als JPEG über CDP) ist bei 1080p etwa 35 fps der Grenzwert im Leerlauf, in der Session real 19 fps.
1. **Rohframes über Loopback statt CDP:** Szene packt auf der GPU in yuv420p (Shader), liest asynchron per PBO aus
   und schickt die Bytes per `fetch`/WebSocket an einen lokalen Port des Renderers, der sie an `ffmpeg -f rawvideo` weiterreicht.
   Entfällt: JPEG-Kodierung, JPEG-Dekodierung in ffmpeg, JPEG-Verluste. Aufwand hoch (Shader, JS-getriebener Takt, Loopback-Server);
   der Loopback-Durchsatz ist noch nicht gemessen.
2. **JPEG parallel in Worker-Threads** (`OffscreenCanvas.convertToBlob`), PBO-Rohdaten per Transfer an mehrere Worker.
   Weniger Umbau, aber JPEG-Verlust bleibt und die Latenz steigt um einige Frames; Skalierung nicht gemessen.
3. Niedrigere Auflösung/Bildrate als Betriebsstufe (z. B. 1080p@24 mit weniger Effekten) als Übergangslösung.
Gemeinsam: `noise` vereinfachen, `--use-angle=gl-egl` im Pod fest verdrahten, danach am gebauten vis-Image und auf A40/L40/5090 messen.

## Rohframe-Pfad (Stand 2026-11-18, mehrere GPU-Läufe)
Rohdaten: `run-nvenc-host-latency-and-teardown.json` (Host mit NVENC), `run-no-nvenc-host-stable-after-fix.json` (Host ohne NVENC).
Umbau: Die Szene packt das Bild auf der GPU in yuv420p (Shader), liest es per PBO asynchron aus und schickt es per
Loopback-WebSocket an den Renderer; der Takt läuft in der Seite (`startStream`), Features und Status gehen über denselben Socket.

| Messung | Ergebnis |
| --- | --- |
| Packer gegen CPU-Referenz (echte GPU) | max. Abweichung 0,6 Stufen (Rundung), 1080p und 1440p |
| 3,1-MB-Frame zum Renderer, lokal | `fetch`/POST ~300 ms, WebSocket ~22 ms |
| GPU-Seite je Frame (Render anstoßen, Fence, Auslesen) | je < 1 ms |
| Host mit NVENC, saubere Läufe | 1080p@30 ~25 fps, 1080p@25 24,3 fps, 1080p@24 23,5-24,3 fps, 1440p@24 14 fps |
| JPEG-Pfad zum Vergleich (gleicher Host) | 13-20 fps |
| NVENC-Encoder-Latenz je Frame (1080p30, p1/ll/cbr) | aktuell 104 ms (5 Frames Vorlauf) -> mit `-zerolatency 1 -delay 0 -surfaces 2 -rc-lookahead 0` 39 ms (3 Frames) |
| `-zerolatency` allein, AQ aus, `tune ull` | kein weiterer Gewinn |
| `libx264 ultrafast` (CPU) | 40 ms je Frame |

Ursachen und Fehlerbilder, die dabei gefunden wurden:
- **Playwright kopiert jedes WebSocket-Frame der Seite** als Base64 an den Treiber (DevTools-Netzwerkbeobachtung; im Stacktrace:
  `_on_frame_sent` -> `b64decode`). Bei ~25 fps sind das ~100 MB/s. Wer die Ereignisse nicht abholt, lässt sie auflaufen: Antworten der
  Steuerleitung kamen ~108 ms zu spät, `stop()` brauchte 9-15 s, Chromium lief weiter und bremste den Folgelauf (abwechselnd 25 und 8-13 fps).
  Gegenmaßnahme: Die Session holt Ereignisse im Stream-Modus laufend ab (`pump`) und beendet den Prozessbaum des Treibers beim Schließen.
  Danach waren alle zehn Läufe gleichmäßig, ohne Prozessreste. Die Kopien selbst bleiben (CPU-Last in Treiber und Python).
- **NVENC fehlt auf einzelnen Hosts** (`OpenEncodeSessionEx failed: unsupported device`): bei drei von vier getesteten 4090-Hosts.
  Der Pod prüft das beim Start und weicht sichtbar auf `libx264` aus. Auf so einem (zusätzlich von Nachbarn ausgelasteten) Host
  lag der Rohpfad bei 13-14 fps, der JPEG-Pfad bei 18 fps: Mit CPU-Encoder kostet die Base64-Kopie Rechenzeit, die dann fehlt.
- Abgelaufene Upload-Links im Testaufbau kosteten zwei Fehlversuche (nur Messaufbau, kein Produktcode).

Offen (Stand vor dem eigenen Treiber; Punkte 1 und 2 sind inzwischen umgesetzt, siehe unten):
1. **Playwright-Overhead ganz vermeiden** (eigener CDP-Treiber oder anderer Weg ohne Netzwerkbeobachtung): würde die ~100 MB/s Kopien
   beseitigen, `stop()` auf < 1 s bringen und auf Hosts ohne NVENC den Rohpfad nutzbar machen.
2. **Hostwechsel**: `vast-pods.py up` soll bei `encoderFallback` den vis-Pod auf einen anderen Host verlegen.
3. 1440p@30 erreicht auch mit NVENC nur ~11-14 fps; 1440p@24 14 fps.
4. Images neu bauen und attestieren (Code im Image-Kontext hat sich geändert), danach Messung am gebauten vis-Image und auf A40/L40/5090.

## Eigener Chromium-Treiber (Punkt 1 der offenen Liste, umgesetzt)
`visual_renderer.py` startet Chromium jetzt selbst (`CdpChromium`, eigene Prozessgruppe, DevTools über einen kleinen WebSocket-Client,
nur `Runtime.evaluate`) und liefert Szene und Medien über einen Loopback-HTTP-Server mit Range-Unterstützung (`LocalSite`). Es wird keine
DevTools-Domäne aktiviert, die Nutzdaten kopiert: Die ~100 MB/s Base64-Kopien der Frames entfallen, ebenso das Routing durch den
Playwright-Treiber. Playwright bleibt als Rückfall (`AI_VIS_DRIVER=playwright`, oder automatisch mit `driverNote` im Status, wenn der
Treiber nicht startet) und dient weiter zum Nachschlagen des Chromium-Pfads (`AI_VIS_CHROMIUM_PATH` hat Vorrang).
Lokal gemessen (Software-WebGL, 1080p, nicht auf der GPU): ~5,7 statt ~4,3 fps, `stop()` ~0,4 s, alle 12 Chromium-Prozesse beendet.

**Auf der GPU gemessen** (RTX 4090 mit NVENC, `run-cdp-driver.json`, zehn Sessions nacheinander, alle gleichmäßig, keine Prozessreste vor einem Lauf):

| Lauf (Rohframe-Pfad, NVENC) | fps | späte Frames | `stop()` |
| --- | --- | --- | --- |
| 1080p@30 (vier Wiederholungen) | 29,4-29,5 | 5-6 | 0,36-0,55 s |
| 1080p@25 | 24,7 | 4 | 0,36 s |
| 1080p@24 | 23,6 | 5 | 0,36 s |
| 1440p@30 | 28,9 | 7 | 0,52 s |
| 1440p@24 | 23,3 | 7 | 0,52 s |
| 1080p@30 mit `libx264` (CPU-Encoder) | 29,7 | 4 | 0,53 s |
| 1080p@30 JPEG-Pfad zum Vergleich | 18,1 | 151 | 0,35 s |

Vorher (Playwright): 1080p@30 ~25 fps mit Wechselmuster, 1440p@30 11-14 fps, `stop()` 9-15 s. Die Ack-Latenz je Frame liegt bei ~17-30 ms,
das Warten auf freie Sendeplätze bei 4-8 ms. Damit sind die Ziel-fps 24/25/30 bei 1080p und 1440p auf dieser Karte erreicht.
Der CPU-Encoder hält 1080p@30 ebenfalls, solange der Host nicht von Nachbarn ausgelastet ist (auf dem überlasteten Host zuvor nicht gemessen mit dem neuen Treiber).

## Hostwechsel bei fehlendem NVENC (Punkt 2, umgesetzt)
- Der vis-Pod meldet `GET /visual/capabilities` (`nvenc`, `nvencReason`, `lowLatencyFlags`).
- `vast-pods.py up` liest das, sobald der vis-Pod bereit ist (`enforce_vis_encoder`). Modus `VAST_VIS_NVENC`: `require` (Standard) bricht
  `up` kontrolliert ab, schreibt die Maschine in `<state_dir>/bad-hosts.json` (7 Tage gültig) und lässt das bestehende Aufräumen alle Instanzen
  entfernen; `warn` meldet nur, `off` prüft nicht. Beim nächsten `up` überspringt `fresh_offer` gesperrte Hosts, nur für die Rolle `vis`.
- Bewusst **kein** Tausch mitten im Lauf: Die Kaufschleife erlaubt keinen zweiten Vertrag für eine vergebene Rolle (Kostenabsicherung);
  das habe ich nicht gegen Vast testen können und deshalb nicht aufgeweicht. Ein erneutes `up` genügt.
- `resume` (gleicher Host, kein Tausch möglich) warnt nur. Ältere Images ohne den Endpunkt gelten als nicht prüfbar und brechen nicht ab.
