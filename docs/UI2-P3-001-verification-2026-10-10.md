# UI2-P3-001 Verification 2026-10-10
## Status: PARTIAL (kept)

### Prüfungen
- **Tests**: `npm test` grün
  - 335 Test Files passed (2758 Tests)
  - `tests/pwaManifest.test.ts` 4/4 passed
- **Implementierung**
  - `index.html` enthält Meta-Tags `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`
  - `<link rel="manifest" href="/manifest.webmanifest" />`
  - `<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />`
  - Titel nutzt `%APP_VERSION%` → Vite ersetzt aus package.json
  - `public/manifest.webmanifest`:
    - name/short_name: audioMONASTRY
    - lang: de
    - start_url: /
    - display: fullscreen, display_override: [fullscreen, standalone]
    - icons 192x192 any, 512x512 any, 512x512 maskable
  - Icons vorhanden & korrekte Größe:
    - public/assets/apple-touch-icon.png 180×180
    - public/assets/icon-192.png 192×192
    - public/assets/icon-512.png 512×512
    - public/assets/icon-maskable-512.png 512×512
  - `dist/` aufgebaut via `scripts/build-public-assets.mjs` → manifest und Icons kopiert

### Acceptance
**Akzeptanz laut MASTERTODOENDE.json:** Installation über Teilen → Zum Home-Bildschirm getestet.

**Befund:** Technisch vollständig implementiert und automatisch verifiziert. Manuelle Bestätigung der Installation auf iPhone/iPad durch Betreiber steht laut Ticket-Note weiterhin offen:
> Offen: Installation auf iPhone/iPad durch den Betreiber testen (Teilen → Zum Home-Bildschirm).

Da der manuelle Test nicht automatisiert nachvollziehbar ist, bleibt der Status PARTIAL. Gates sind grün, Commit nicht erforderlich.
