/**
 * audioMONASTRY · OS-Aggregation für Mehrgeräte-Ausgabe (Xonar U7 ×N)
 * ====================================================================
 * Browser können nativ nur EIN Ausgabegerät ansteuern. Für 12.x/18.x/24.x
 * mit mehreren Xonar U7 braucht es EIN virtuelles Aggregat-Gerät auf
 * OS-Ebene. Dieses Modul liefert Plattform-Erkennung, Status und die
 * exakten Anleitungen/Skript-Referenzen dafür.
 */

export type AudioOS = 'windows' | 'linux' | 'macos' | 'unknown';

export function detectOS(): AudioOS {
  const ua = (globalThis.navigator?.userAgent ?? '').toLowerCase();
  if (/windows/.test(ua)) return 'windows';
  if (/linux/.test(ua)) return 'linux';
  if (/mac os|macintosh/.test(ua)) return 'macos';
  return 'unknown';
}

export interface AggregationGuide {
  os: AudioOS;
  title: string;
  /** 1..n Schritte als Klartext. */
  steps: string[];
  /** Referenz-Skript im Repo (falls vorhanden). */
  script?: string;
  command?: string;
}

export function aggregationGuide(os: AudioOS = detectOS()): AggregationGuide {
  switch (os) {
    case 'windows':
      return {
        os,
        title: 'Windows – ASIO4ALL / Voicemeeter / Lautsprecher gruppieren',
        steps: [
          '1) Alle Xonar U7 per USB verbinden (Treiber von ASUS installieren).',
          '2) Systemsteuerung → Sound → Wiedergabe: alle U7 sichtbar?',
          '3) Option A (schnell): Sound → Aufnahme → Stereomix aktivieren; in der App als Ausgabe wählen.',
          '4) Option B (pro): ASIO4ALL installieren, alle U7 aktivieren, als ein Gerät aggregieren.',
          '5) Option C (flexibel): Voicemeeter Potato – je U7 ein Hardware-Out, Routing nach Kanalplan.',
          '6) In der App: Settings → Ausgabe → Aggregat-Gerät wählen; Spatial-Setup 12.x/18.x/24.x übernehmen.',
        ],
        script: 'scripts/windows-aggregate.ps1',
        command: 'powershell -ExecutionPolicy Bypass -File scripts/windows-aggregate.ps1',
      };
    case 'linux':
      return {
        os,
        title: 'Linux – PipeWire Combine-Sink',
        steps: [
          '1) Alle Xonar U7 verbinden (als separate Sinks sichtbar).',
          '2) Skript ausführen: bash scripts/pipewire-combine-sink.sh',
          '3) Das Skript erkennt U7-Sinks und erzeugt einen Combine-Sink mit Kanal-Map (8/16/24/32 Kanäle).',
          '4) In der App: Settings → Ausgabe → "xonar_aggregate" wählen.',
        ],
        script: 'scripts/pipewire-combine-sink.sh',
        command: 'bash scripts/pipewire-combine-sink.sh',
      };
    case 'macos':
      return {
        os,
        title: 'macOS – Multi-Output-/Aggregat-Gerät',
        steps: [
          '1) Alle Xonar U7 verbinden.',
          '2) "Audio-MIDI-Setup" öffnen → "+" unten links → "Aggregat-Gerät erzeugen".',
          '3) Alle U7 hinzufügen und als ein Gerät zusammenfassen (Reihenfolge = Kanalreihenfolge).',
          '4) In der App: Settings → Ausgabe → Aggregat-Gerät wählen.',
        ],
        script: 'scripts/macos-aggregate.sh',
        command: 'bash scripts/macos-aggregate.sh',
      };
    default:
      return {
        os: 'unknown',
        title: 'Unbekanntes OS',
        steps: ['Aggregation manuell über die Sound-Einstellungen des Betriebssystems einrichten.'],
      };
  }
}

export interface AggregationStatus {
  crossOriginIsolated: boolean;
  os: AudioOS;
  guide: AggregationGuide;
}

export function aggregationStatus(): AggregationStatus {
  const isolated = (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  return {
    crossOriginIsolated: isolated,
    os: detectOS(),
    guide: aggregationGuide(),
  };
}
