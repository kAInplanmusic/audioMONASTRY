import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './index.css';
import './styles/amDesign.css';
import { MasterOutPage } from './pages/MasterOutPage';
import { VisualOutPage } from './pages/VisualOutPage';
import { listenerModeForPath } from './core/session/listenerMode';
import { AudioProvider } from './context/AudioContext';
import { SampleProvider } from './context/SampleContext';
import { ModuleStateProvider } from './context/ModuleStateContext';
import { PluginManagerProvider } from './context/PluginManagerContext';
import { SessionProvider } from './context/SessionContext';
import { AccessProvider } from './context/AccessContext';
import { ProjectProvider } from './context/ProjectContext';

import { ErrorBoundary } from './components/ErrorBoundary';
// Registriert die Standard-Sprach-/KI-Kommandos für die Plugin-Steuerung.
import './core/voice/pluginCommandRegistry';
import { trackError } from './utils/errorTracker';
import { startDeviceLayoutWatch } from './hooks/useDeviceLayout';
import { startPluginSettingsSync } from './utils/pluginSettings';
import { startStudioStoreSync } from './utils/studioStoreSync';

// DCT-118: Boot-Diagnostics + Auto-Logging – globale Fehler sichtbar machen
// (kein stiller White-Screen) und automatisch an /api/telemetry melden.
window.addEventListener('error', (event) => {
  console.error('[boot] window.onerror:', event.error ?? event.message);
  trackError('window.onerror', event.error ?? event.message, { filename: event.filename, line: event.lineno });
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[boot] unhandledrejection:', event.reason);
  trackError('unhandledrejection', event.reason);
});
// ...

// Fixe Andock-URLs für die Ghost-User: /master-out bzw. /ghost/5 (PA) und
// /visual-out bzw. /ghost/6 (Beamer).
const bootMode = listenerModeForPath(window.location.pathname);

// Formate: Gerät/Ausrichtung/Auflösung erkennen, bevor der erste Frame steht
// (data-layout an <html>, Vollbild beim ersten Tippen in Handy quer/Pad quer).
if (bootMode === 'member') {
  startDeviceLayoutWatch();
  // Beständige Plugins: Session-Stände der Plugins empfangen (vor dem ersten Join).
  startPluginSettingsSync();
}

// Nichts auf den Geräten (Betreiber 2026-10-06): Studio-Daten kommen vom Server
// und werden vor dem ersten Zeichnen vorgeladen (höchstens 2,5 s).
const studioStoreReady = bootMode === 'member' ? startStudioStoreSync() : Promise.resolve();

void studioStoreReady.finally(() => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {bootMode === 'master-out' ? (
        <MasterOutPage />
      ) : bootMode === 'visual-out' ? (
        <VisualOutPage />
      ) : (
        <AccessProvider>
        <SessionProvider>
            <ModuleStateProvider>
            <PluginManagerProvider>
                <ProjectProvider>
                <SampleProvider>
                <AudioProvider>
                    <App />
                </AudioProvider>
                </SampleProvider>
                </ProjectProvider>
            </PluginManagerProvider>
            </ModuleStateProvider>
        </SessionProvider>
        </AccessProvider>
      )}
    </ErrorBoundary>
  </StrictMode>,
));
