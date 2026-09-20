/**
 * audioMONASTRY · MOS-Gate als Entscheidung (INFRA-AI-007)
 * ========================================================
 * Das MOS-Harness erfasst Hörerwertungen je Sprachmodell und berechnet ein Gate
 * (`AI_MOS_MIN_SCORE` Default 4.0, `AI_MOS_MIN_RATINGS` Default 3 verschiedene
 * HÖRER). Bis 2026-09-20 hatte dieses Gate **keinen Abnehmer**: `gateFor()`/
 * `summaryFor()` wurden nur in Tests gelesen, keine Modellwahl hing daran.
 *
 * Hier hängt die erste echte Entscheidung daran: **die Wahl des TTS-Modells der
 * Rolle `voiceGen`**. Die Regeln sind bewusst konservativ und ehrlich:
 *
 *   `ok`          – genug Hörer UND Score über der Schwelle → Modell ist gewählt
 *   `provisional` – erste Wertungen liegen vor, aber noch nicht genug Hörer:
 *                   die Bewertung ist unvollständig, nicht schlecht → erlaubt
 *   `unrated`     – keine Wertung → erlaubt (es wird kein MOS erfunden)
 *   `blocked`     – genug Hörer UND Score unter der Schwelle → dieses Modell
 *                   wird NICHT verwendet
 *
 * Ist das angeforderte Modell `blocked`, wechselt die Entscheidung auf den
 * ersten erlaubten Kandidaten derselben Rolle. Ist AUSNAHMSLOS alles blockiert,
 * wird nichts ausgeführt – der Aufrufer bekommt `blocked` samt Begründung und
 * lehnt ab (kein stiller Weiterbetrieb mit einem durchgefallenen Modell).
 */
import { GPU_ROLES } from './endpointRegistry';
import { mosHarness, type MosHarness, type MosSummary } from './mosHarness';

/** Status eines Modells gegen das MOS-Gate. */
export type VoiceModelGateStatus = 'ok' | 'provisional' | 'unrated' | 'blocked';

export interface VoiceModelCandidate {
  model: string;
  status: VoiceModelGateStatus;
  evaluators: number;
  avg: number;
  reason: string;
}

export interface VoiceModelDecision {
  /** Modell, das tatsächlich verwendet werden soll. */
  model: string;
  /** Status des GEWÄHLTEN Modells (`blocked` = es darf nichts laufen). */
  status: VoiceModelGateStatus;
  requested: string;
  /** true, wenn gegen das angeforderte Modell entschieden wurde. */
  switched: boolean;
  reason: string;
  /** Bewerteter Zustand des gewählten Modells (für Logs/Statusrouten). */
  summary: MosSummary;
  /** Alle betrachteten Kandidaten in Prüfreihenfolge (Diagnose). */
  considered: VoiceModelCandidate[];
}

/**
 * Die TTS-Modelle der Rolle `voiceGen` aus dem Rollen-Manifest (`preload`).
 * Damit gibt es EINE Quelle der Kandidaten – keine zweite Modell-Liste im Code.
 */
export function voiceModelCandidates(): string[] {
  return GPU_ROLES.voiceGen.preload.filter((model) => model.startsWith('qwen3-tts'));
}

/**
 * Gate-Status einer Hörerwertung. Schwellen und Zählweise (verschiedene HÖRER,
 * nicht Wertungen) kommen unverändert aus `mosHarness`.
 */
export function voiceModelGateStatus(summary: MosSummary): VoiceModelGateStatus {
  if (summary.evaluators >= summary.requiredCount) return summary.pass ? 'ok' : 'blocked';
  return summary.evaluators > 0 ? 'provisional' : 'unrated';
}

/** Rangfolge der erlaubten Zustände: `ok` schlägt `provisional` schlägt `unrated`. */
const RANK: Record<VoiceModelGateStatus, number> = { ok: 0, provisional: 1, unrated: 2, blocked: 3 };

/**
 * Wählt das TTS-Modell für ein Sprachkommando.
 *
 * `candidates` ist injizierbar (Tests/andere Rollen); Default = TTS-Modelle der
 * Rolle `voiceGen` aus dem Manifest. `harness` ist injizierbar, Default ist der
 * Prozess-Singleton (der beim Serverstart aus der Persistenz hydratisiert wird).
 */
export function resolveVoiceModel(
  requested: string,
  options: { candidates?: readonly string[]; harness?: MosHarness } = {},
): VoiceModelDecision {
  const harness = options.harness ?? mosHarness;
  const pool = (options.candidates ?? voiceModelCandidates()).filter(Boolean);
  // Das angeforderte Modell steht immer zur Prüfung an – auch wenn es (noch)
  // nicht im Rollen-Preload steht (Live-Bestand kann abweichen).
  const order = [requested, ...pool.filter((model) => model !== requested)].filter(Boolean);

  const considered: VoiceModelCandidate[] = order.map((model) => {
    const summary = harness.summaryFor(model);
    return {
      model,
      status: voiceModelGateStatus(summary),
      evaluators: summary.evaluators,
      avg: summary.avg,
      reason: summary.reason,
    };
  });

  const allowed = considered.filter((entry) => entry.status !== 'blocked');
  const chosen = [...allowed].sort((a, b) => RANK[a.status] - RANK[b.status])[0];

  if (!chosen) {
    // Alles durchgefallen: keine stille Ersatzwahl, sondern Ablehnung.
    return {
      model: requested,
      status: 'blocked',
      requested,
      switched: false,
      reason: `alle TTS-Modelle der Rolle voiceGen sind durch das MOS-Gate gefallen `
        + `(${considered.map((c) => `${c.model}: ${c.reason}`).join('; ')})`,
      summary: harness.summaryFor(requested),
      considered,
    };
  }

  const summary = harness.summaryFor(chosen.model);
  const switched = chosen.model !== requested;
  return {
    model: chosen.model,
    status: chosen.status,
    requested,
    switched,
    reason: switched
      ? `'${requested}' ist durch das MOS-Gate gefallen (${considered[0].reason}) → `
        + `'${chosen.model}' gewählt (${chosen.status}: ${chosen.reason})`
      : `'${chosen.model}' ${chosen.status}: ${chosen.reason}`,
    summary,
    considered,
  };
}
