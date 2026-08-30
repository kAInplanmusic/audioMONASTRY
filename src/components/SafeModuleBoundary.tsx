import {  Component, ErrorInfo, ReactNode  } from 'react';

interface Props {
  children: ReactNode;
}

// Extrahiert einen lesbaren Namen des gerenderten Moduls (z.B. 'SequencerPluginTerminal'),
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
}

export class SafeModuleBoundary extends Component<Props, State> {
  private crashedModuleName = '';
  private crashedError: Error | null = null;
  private crashedStack = '';
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(_: Error): Partial<State> {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.crashedModuleName = resolveElementName(this.props.children);
    // componentStack zeigt die genaue Komponenten-Hierarchie, in der der Fehler
    // gefangen wurde – entscheidend, wenn `error` selbst undefined ist.
    this.crashedError = error;
    this.crashedStack = errorInfo?.componentStack || '';
    console.error(`Plugin Module crashed (${this.crashedModuleName}):`, error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 bg-red-950/20 border border-red-500 rounded-lg text-red-400 text-xs font-mono flex items-center justify-between">
            <span>Modul-Fehler {this.crashedModuleName ? `[${this.crashedModuleName}]` : ''}: Modul konnte nicht geladen werden.</span>
            {this.crashedError?.message ? <div className="mt-1 text-red-300">Fehler: {this.crashedError.message}</div> : null}
            {this.crashedStack ? <pre className="mt-1 text-[10px] leading-tight text-red-400/70 overflow-auto max-h-20">{this.crashedStack}</pre> : null}
            <button type="button"
              onClick={this.handleReset}
              className="ml-4 px-3 py-1 bg-red-900/50 border border-red-500 rounded text-red-300 hover:bg-red-900 transition-colors text-[10px] font-bold uppercase tracking-widest"
            >
              Retry
            </button>
        </div>
      );
    }

    return this.props.children;
  }
}
