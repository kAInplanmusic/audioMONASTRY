/** Plugin-Aktivität des stemMONK markiert den studio-Pod als aktiv. */
export function onPluginStarted(canonicalPluginId: string | null): Promise<PodTriggerReport> | null {
  if (canonicalPluginId !== 'stem') return null;
  // Der stems-Pod ist schon bereit: kein Start noetig, aber die Nutzung muss als
  // Aktivitaet gebucht werden - sonst stoppt der Leerlauf-Sweeper ihn mitten im Plugin.
  if (rt('studio').state === 'ready' || rt('studio').inflight) {
    markPodActivity('studio');
    return null;
  }
  return triggerPodStart('always', 'stemMONK using studio', { only: 'studio' });
}

export class PodWakeBlockedError extends Error {
  constructor(readonly pod: PodRoleId, readonly block: PodWakeBlock, message: string) {
    super(message);
    this.name = 'PodWakeBlockedError';
  }
}

/**
 * Vor jedem Job im Pod-Modus: Ziel-Pod bereit? Bereit = sofort zurück (keine
 * zusätzliche Latenz). Sonst Lazy-Wake: bei einem Generierungs-Auftrag startet
 * der Trigger `aiGeneration` beide Generierungs-Pods (music + voice), der Job
 * wartet nur auf seinen eigenen. Gesperrt (AI aus, Kill-Switch, Budget) →
 * `PodWakeBlockedError`. Nicht bereit geworden → der Job versucht es trotzdem
 * (der Provider meldet dann den echten Fehler).
 */
export async function ensurePodForJob(pod: PodRoleId, task: AiTask, signal?: AbortSignal): Promise<PodWakeResult> {
  notePodActivity(`job ${task} on ${pod}`);
  const r = rt(pod);
  // FLEET-P1-012: jeder Auftrag zaehlt als Aktivitaet - auch wenn der Pod schon
  // bereit ist und der Aufruf sofort zurueckkehrt.
  markPodActivity(pod);
  if (r.state === 'ready') return { pod, state: 'ready', block: null, startRequested: r.startRequested };
  const trigger = POD_START_TRIGGERS[pod];
  if (trigger === 'aiGeneration' && isAiGenerationTask(task)) {
    // Beide Generierungs-Pods anstoßen (Hintergrund), der Job wartet nur auf seinen.
    void triggerPodStart('aiGeneration', `first ai generation (${task})`).catch(() => { /* geloggt */ });
  }
  const report = await abortable(
    triggerPodStart(trigger, trigger === 'aiGeneration' && isAiGenerationTask(task) ? `first ai generation (${task})` : `lazy wake for job (${task})`, { only: pod }),
    signal,
  );
  const mine = report.pods.find((p) => p.pod === pod) ?? { pod, state: rt(pod).state, block: report.blocked, startRequested: false };
  if (mine.state === 'blocked' && mine.block && mine.block !== 'disabled') {
    throw new PodWakeBlockedError(pod, mine.block, report.message ?? mine.message ?? `Pod ${pod} gesperrt (${mine.block})`);
  }
  return mine;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('Warten auf Pod abgebrochen'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Warten auf Pod abgebrochen'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/** Der Provider meldet: Pod nicht erreichbar → beim nächsten Job neu prüfen. */
export function markPodStale(pod: PodRoleId, why: string): void {
  const r = rt(pod);
  if (r.state !== 'ready') return;
  Object.assign(r, { state: 'off', readyAt: null, error: why });
  syncCostMeter();
  aiLogger.warn('fleet pod marked stale', { pod, error: why });
}

/**
 * Auto-Stop (FLEET-P1-012, Betreiber-Entscheid 2026-10-13: 15 Minuten).
 *
 * Ein Pod, der 15 Minuten weder geweckt wurde noch einen Auftrag gesehen hat,
 * wird gestoppt - sonst laeuft eine A40 weiter, obwohl niemand mehr im Studio
 * arbeitet. Der Wert steht in `AI_POD_AUTOSTOP_IDLE_MS` (Default 15 min).
 *
 * Gestoppt wird nur, was die Flotte selbst gestartet hat (`startRequested`) -
 * ein Pod, den der Betreiber von Hand gestartet hat, bleibt unberuehrt. Die
 * Entscheidung ist rein (kein Netzaufruf) und deshalb einzeln testbar; erst
 * `stopIdlePods` spricht die RunPod-REST-API an.
 */
export const POD_AUTOSTOP_IDLE_DEFAULT_MS = 15 * 60 * 1000;

export function podAutoStopIdleMs(): number {
  return envNumber('AI_POD_AUTOSTOP_IDLE_MS', POD_AUTOSTOP_IDLE_DEFAULT_MS);
}

/** Aktivitaet fuer einen Pod vermerken (Wecken oder laufender Auftrag). */
export function markPodActivity(pod: PodRoleId, atMs: number = Date.now()): void {
  rt(pod).lastActivityAt = atMs;
}

// Ein beendeter Auftrag zaehlt als Aktivitaet: das Leerlauf-Fenster laeuft ab dem
// Auftrags-ENDE, nicht ab dem Start. Ohne das stoppt ein Pod nach einem langen Lauf
// (LEGO, Stems, Song) unmittelbar nach dem Ergebnis und der Folgeauftrag zahlt den Kaltstart.
setJobFinishedHook((pod) => markPodActivity(pod));

/**
 * Ist gerade jemand im Studio? Solange ja, stoppt der Leerlauf-Aufraeumer nichts:
 * der Betreiber-Entscheid lautet "15 Minuten ohne Session ODER Auftrag". Die
 * Praesenz kommt aus dem Realtime-Hub (server.ts -> noteStudioPresence); ohne diese
 * Sperre konnte ein Pod mitten in einer laufenden Studio-Sitzung gestoppt werden
 * (Widerspruch zu RT-AUDIT-P1-015 "Brain warm halten, solange Nutzer im Studio sind").
 */
let studioSessionActive = false;

/** Session-Zustand setzen (Realtime-Hub). */
export function setStudioSessionActive(active: boolean): void {
  studioSessionActive = active;
}

/** Ist eine Studio-Session aktiv? (fuer Status und Tests) */
export function podSessionActive(): boolean {
  return studioSessionActive;
}

/**
 * Praesenzmeldung aus dem Realtime-Hub: Session-Zustand fuehren UND die bereiten Pods
 * als aktiv buchen. Ohne das zweite haelt der Sweeper die Flotte fuer untaetig, weil
 * Praesenz nur beim ersten Join als Aktivitaet zaehlte.
 */
export function noteStudioPresence(members: number): void {
  studioSessionActive = members > 0;
  if (members <= 0) return;
  for (const pod of POD_ROLE_IDS) {
    if (rt(pod).state === 'ready') markPodActivity(pod);
  }
}

/**
 * Untaetige Pods (reine Entscheidung, kein Netzaufruf).
 *
 * Kandidat ist ein Pod, den die Flotte selbst gestartet hat (`startRequested`) und der
 * weder laeuft noch wartet (`podBusy`), wenn seit der letzten Aktivitaet die Leerlaufzeit
 * vergangen ist. Zwei Faelle sind bewusst dabei:
 *  - `ready`: der Normalfall.
 *  - `starting`/`failed`: ein Pod, dessen /ready nie 200 wurde (Modell laedt nicht,
 *    Token falsch). Der wird bereits abgerechnet und wurde vorher NIE gestoppt - ein
 *    reines Kostenleck. Die Uhr laeuft ab `since` (Beginn des Weckversuchs).
 * Nicht gestoppt wird, waehrend jemand im Studio ist (`studioSessionActive`).
 */
export function autoStopCandidates(nowMs: number, idleMs: number = podAutoStopIdleMs()): PodRoleId[] {
  if (studioSessionActive) return [];
  return POD_ROLE_IDS.filter((pod) => {
    const r = rt(pod);
    if (!r.startRequested) return false; // fremd gestartete Pods nicht anfassen
    if (r.state !== 'ready' && r.state !== 'starting' && r.state !== 'failed') return false;
    if (podBusy(pod)) return false; // laufender/gewarteter Auftrag schuetzt den Pod
    const since = r.lastActivityAt ?? r.readyAt ?? r.since;
    if (since === null) return false;
    return nowMs - since >= idleMs;
  });
}

/**
 * Laeuft oder wartet gerade ein Auftrag auf dem Pod? Der Sweeper darf einen
 * beschaeftigten Pod nicht stoppen: ein Video-/LEGO-Lauf dauert laenger als die
 * Leerlaufzeit, und ein wartender Auftrag hat den Pod gerade erst angefordert.
 */
export function podBusy(pod: PodRoleId): boolean {
  const queue = podQueue(pod);
  return queue.runningCount() > 0 || queue.waitingCount() > 0;
}

/** Ist das Herunterfahren per AI_FLEET_SLEEP abgeschaltet? Dann auch kein Auto-Stop. */
function sleepDisabled(): boolean {
  const raw = (process.env.AI_FLEET_SLEEP ?? '').trim().toLowerCase();
  return raw !== '' && ['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * Nach einem Serverneustart laufen die Pods weiter, der Modulzustand ist aber weg:
 * `startRequested` waere false und der Sweeper wuerde sie nie aufraeumen. Deshalb
 * einmal beim Start die eigenen Pod-IDs bei RunPod abfragen und laufende adoptieren
 * (mit Aktivitaetszeitpunkt = jetzt, damit die 15 Minuten ab Adoption zaehlen).
 */
export async function adoptRunningPods(signal?: AbortSignal): Promise<PodRoleId[]> {
  if (fleetMode() !== 'pods' || !wakeEnabled()) return [];
  const adopted: PodRoleId[] = [];
  for (const pod of POD_ROLE_IDS) {
    const id = podId(pod);
    if (!id || rt(pod).state === 'ready') continue;
    try {
      const resp = await fetch(`${restBase()}/pods/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        signal,
      });
      if (!resp.ok) continue;
      const body = (await resp.json()) as { desiredStatus?: string; status?: string };
      if (String(body.desiredStatus).toUpperCase() !== 'RUNNING') continue;
      const r = rt(pod);
      Object.assign(r, {
        state: 'ready', readyAt: Date.now(), lastActivityAt: Date.now(),
        startRequested: true, error: null, block: null, trigger: null, reason: 'adopted',
      });
      adopted.push(pod);
      aiLogger.info('fleet pod adopted', { pod, id, status: body.status ?? null });
    } catch (error) {
      aiLogger.warn('fleet pod adopt failed', { pod, id, error: (error as Error).message });
    }
  }
  return adopted;
}

/** Takt des Leerlauf-Aufraeumers (`AI_POD_AUTOSTOP_SWEEP_MS`, Default 60 s). */
export const POD_AUTOSTOP_SWEEP_DEFAULT_MS = 60 * 1000;

export function podAutoStopSweepMs(): number {
  return envNumber('AI_POD_AUTOSTOP_SWEEP_MS', POD_AUTOSTOP_SWEEP_DEFAULT_MS);
}

/** Soll der Leerlauf-Aufraeumer ueberhaupt laufen? (Serverless oder AI_FLEET_SLEEP=0: nein) */
export function podAutoStopActive(): boolean {
  return fleetMode() === 'pods' && !sleepDisabled();
}

/** Untaetige Pods stoppen; meldet je Pod, was passiert ist (kein Wurf). */
export async function stopIdlePods(nowMs: number = Date.now(), signal?: AbortSignal): Promise<PodAutoStopReport> {
  const idleMs = podAutoStopIdleMs();
  const report: PodAutoStopReport = { checkedAt: nowMs, idleMs, idle: [], stopped: [], failed: [], skipped: null };
  if (fleetMode() !== 'pods') {
    report.skipped = 'fleet-mode';
    return report;
  }
  if (!wakeEnabled()) {
    report.skipped = 'wake-disabled';
    return report;
  }
  // AI_FLEET_SLEEP=0 schaltet das Herunterfahren ab - dann stoppt auch der Sweep nicht.
  // Vorher hing der Auto-Stop nur an AI_FLEET_WAKE, sodass AI_FLEET_SLEEP=0 wirkungslos war.
  if (sleepDisabled()) {
    report.skipped = 'sleep-disabled';
    return report;
  }
  const candidates = autoStopCandidates(nowMs, idleMs);
  report.idle = candidates;
  for (const pod of candidates) {
    const id = podId(pod);
    const r = rt(pod);
    const idleForMs = nowMs - (r.lastActivityAt ?? r.readyAt ?? r.since ?? nowMs);
    // TOCTOU: zwischen Kandidatenwahl und diesem Stop kann ein Auftrag gestartet sein
    // (oder jemand ins Studio gekommen sein). Deshalb unmittelbar vor dem Aufruf erneut pruefen.
    if (podBusy(pod) || studioSessionActive) {
      report.skipped = report.skipped ?? 'busy-again';
      continue;
    }
    if (!id) {
      report.failed.push({ pod, message: `RP_POD_ID_${pod.toUpperCase().replace(/-/g, '_')} fehlt` });
      continue;
    }
    try {
      const resp = await fetch(`${restBase()}/pods/${encodeURIComponent(id)}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const wasReadyAt = r.readyAt;
      Object.assign(r, { state: 'off', readyAt: null, lastActivityAt: null, error: null, trigger: null, reason: null, since: wasReadyAt });
      report.stopped.push(pod);
      aiLogger.info('fleet pod stopped (idle)', { pod, idleForMs, idleMs });
    } catch (error) {
      const message = (error as Error).message;
      report.failed.push({ pod, message });
      aiLogger.warn('fleet pod stop failed', { pod, idleForMs, error: message });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// FLEET-P1-012: Aktivitätssignal für den Idle-Timer des Auto-Stops
// ---------------------------------------------------------------------------
let activityListener: ((why: string) => void) | null = null;

/** Der Auto-Stop (fleetAutostop.ts) hängt sich hier an; null hängt ab. */
export function setPodActivityListener(fn: ((why: string) => void) | null): void {
  activityListener = fn;
}

/** Ein Pod wurde benutzt (Job-Start/-Ende, Wake). Nie werfend, nie blockierend. */
export function notePodActivity(why: string): void {
  try {
    activityListener?.(why);
  } catch (error) {
    aiLogger.warn('fleet pod activity listener failed', { error: (error as Error).message });
  }
}

/** Zustand für fleetStatus() (kein Netzwerkaufruf). */
export function podStartTriggerStatus(): Record<string, unknown> {
  const active = activePods();
  return {
    mode: fleetMode(),
    wakeEnabled: wakeEnabled(),
    budget: {
      activePods: active.length,
      eurPerHour: Number(podFleetEurPerHour(active.length).toFixed(3)),
      maxEurPerHour: podFleetMaxEurPerHour(),
      // FLEET-P1-012: Kostenzeile (deutsch) + laufender Zähler.
      costLine: formatEurPerHour(podFleetEurPerHour(active.length)),
      meter: podCostMeter.status(),
    },
    pods: POD_ROLE_IDS.map((pod) => {
      const r = rt(pod);
      return {
        pod,
        startTrigger: POD_START_TRIGGERS[pod],
        state: r.state,
        trigger: r.trigger,
        reason: r.reason,
        since: r.since,
        readyAt: r.readyAt,
        startRequested: r.startRequested,
        block: r.block,
        error: r.error,
        configured: Boolean(podBaseUrl(pod)),
        lastActivityAt: r.lastActivityAt,
      };
    }),
    autoStop: {
      idleMs: podAutoStopIdleMs(),
      sweepMs: podAutoStopSweepMs(),
      candidates: autoStopCandidates(Date.now(), podAutoStopIdleMs()),
      busy: POD_ROLE_IDS.filter((pod) => podBusy(pod)),
    },
    lastTriggers: lastReports.map((rep) => ({ trigger: rep.trigger, reason: rep.reason, blocked: rep.blocked, pods: rep.pods.map((p) => `${p.pod}:${p.state}`) })),
  };
}

/** Nur für Tests. */
export function __resetPodStartTriggers(): void {
  runtimes = new Map(POD_ROLE_IDS.map((pod) => [pod, freshRuntime()]));
  killSwitchGuard = () => false;
  lastReports = [];
  podCostMeter.reset();
}

/** Kill-Switch-Zustand (für den Auto-Stop-Status; Stoppen ist nie gesperrt). */
export function podKillSwitchActive(): boolean {
  try {
    return killSwitchGuard();
  } catch {
    return false;
  }
}
