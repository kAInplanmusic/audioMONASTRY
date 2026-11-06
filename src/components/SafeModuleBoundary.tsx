import { Component, Fragment, ErrorInfo, ReactNode } from 'react';
import { ModuleBoundaryAttemptContext } from '../utils/lazyChunk';

interface Props {
  children: ReactNode;
  /** Optionaler Name des abgesicherten Bereichs (z. B. 'eqMONK', 'perforMONK'). */
  name?: string;
}

// Extrahiert einen lesbaren Namen des gerenderten Moduls (z.B. 'McpTerminal'),
// damit ein Crash eindeutig zuzuordnen ist.
function resolveElementName(children: ReactNode): string {
  if (Array.isArray(children)) {
    return children.map(resolveElementName).filter(Boolean).join(', ');
  }
  if (children && typeof children === 'object' && 'type' in (children as any)) {
    const type = (children as any).type;
    if (typeof type === 'string') return type;             // DOM-Element
    if (type && type.displayName) return type.displayName;  // benannte Funktion/Klasse
    if (type && type.name) return type.name;                // Funktionsname / Klassenname
    return 'Unbekanntes Modul-Element';
  }
  return '(kein Element)';
}

interface State {
  hasError: boolean;
  /** Name des betroffenen Moduls - erst nach `componentDidCatch` bekannt. */
  crashedModuleName: string;
  /**
   * Zaehler der Wiederherstellungsversuche. Er ist der `key` des Kindbaums:
   * ein neuer Versuch MONTIERT die Modul-Inhalte neu. Nur so bekommt eine
   * fehlgeschlagene `lazy`-Instanz (siehe `lazyWithRetry`) einen echten
   * neuen Ladeversuch - React selbst haelt die Ablehnung sonst fuer immer.
   */
  attempt: number;
}

/**
 * Fehlergrenze fuer EINEN Modul-/Rack-Bereich.
 *
 * UI-2026-11-06-001: Diese Grenze sass zusaetzlich um die KOMPLETTE App
 * (`App.tsx` → `<SafeModuleBoundary><AppComponent /></SafeModuleBoundary>`).
 * Ein fehlgeschlagener Chunk-Import eines Moduls (belegt:
 * `PerformanceMonitorTerminal`, das der perforMONK immer rendert) riss damit
 * die gesamte Studio-UI weg - nur noch die Fehlerbox mit 55 Zeichen stand in
 * `#root`. Die Grenze gehoert deshalb ausschliesslich um den betroffenen
 * Modulbereich: Kopfzeile, Navigation, Mastergraph, Rack und Session bleiben
 * stehen, der Fehler ist lokal sichtbar und lokal behebbar.
 *
 * Zusaetzlich: kommt das Netz zurueck (`online`), setzt sich die Grenze selbst
 * zurueck. Zusammen mit `lazyWithRetry` laedt das Modul dann ohne Reload der
 * Seite nach - vorher war RETRY eine Attrappe, weil React die abgelehnte
 * `lazy`-Instanz dauerhaft zwischenspeichert.
 */
export class SafeModuleBoundary extends Component<Props, State> {
  private crashedModuleName = '';
  private crashedError: Error | null = null;
  private crashedStack = '';
  public state: State = {
    hasError: false,
    crashedModuleName: '',
    attempt: 0,
  };

  public static getDerivedStateFromError(_: Error): Partial<State> {
    return { hasError: true };
  }

  public componentDidMount() {
    window.addEventListener('online', this.handleOnline);
  }

  public componentWillUnmount() {
    window.removeEventListener('online', this.handleOnline);
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.crashedModuleName = this.props.name || resolveElementName(this.props.children);
    // componentStack zeigt die genaue Komponenten-Hierarchie, in der der Fehler
    // gefangen wurde – entscheidend, wenn `error` selbst undefined ist.
    this.crashedError = error;
    this.crashedStack = errorInfo?.componentStack || '';
    // Namen in den State: der erste Render nach dem Fehler laeuft VOR
    // componentDidCatch und zeigte deshalb bisher "Modul-Fehler :" ohne Namen.
    this.setState({ crashedModuleName: this.crashedModuleName });
    console.error(`Plugin Module crashed (${this.crashedModuleName}):`, error, errorInfo);
  }

  private handleReset = () => {
    this.setState((prev) => ({ hasError: false, attempt: prev.attempt + 1 }));
  };

  /** Netz ist zurueck: lokal gescheiterte Module duerfen neu laden. */
  private handleOnline = () => {
    if (this.state.hasError) this.handleReset();
  };

  public render() {
    if (this.state.hasError) {
      const moduleName = this.state.crashedModuleName || this.crashedModuleName;
      return (
        <div
          data-testid="module-boundary-error"
          data-module={moduleName || undefined}
          className="p-4 bg-red-950/20 border border-red-500 rounded-lg text-red-400 text-xs font-mono flex items-center justify-between gap-3"
        >
          <div>
            <span>Modul-Fehler {moduleName ? `[${moduleName}]` : ''}: Modul konnte nicht geladen werden.</span>
            {this.crashedError?.message ? <div className="mt-1 text-red-300">Fehler: {this.crashedError.message}</div> : null}
            {this.crashedStack ? <pre className="mt-1 text-[10px] leading-tight text-red-400/70 overflow-auto max-h-20">{this.crashedStack}</pre> : null}
          </div>
          <button type="button"
            onClick={this.handleReset}
            className="ml-4 shrink-0 px-3 py-1 bg-red-900/50 border border-red-500 rounded text-red-300 hover:bg-red-900 transition-colors text-[10px] font-bold uppercase tracking-widest"
          >
            Retry
          </button>
        </div>
      );
    }

    // `attempt` geht als Kontext an `lazyWithRetry` (neue lazy-Instanz = echter
    // neuer Ladeversuch) und als `key` an den Teilbaum (frischer Modul-State).
    return (
      <ModuleBoundaryAttemptContext.Provider value={this.state.attempt}>
        <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
      </ModuleBoundaryAttemptContext.Provider>
    );
  }
}
