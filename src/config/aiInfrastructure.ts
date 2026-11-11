/**
 * Physical eight-role fleet: deploy/runpod/pod-fleet.json.
 * GPU_ROLE_IDS retains the historical serverless API namespace; it is not a Pod list.
 * Resident model metadata below mirrors the selected pinned manifest entries.
 */
export const GPU_ROLE_IDS = [
  'brain',
  'ears',
  'voiceGen',
  'music',
  'audio-gen',
  'imageHq',
  'videoReal',
  'videoAbstract',
  'orchestrator',
] as const;

/** Rolle eines Flotten-Endpoints. */
export type GpuRoleId = (typeof GPU_ROLE_IDS)[number];

/**
 * Alle zulässigen GPU-Endpoint-Rollen.
 *
 * Seit der 8-Instanzen-Architektur sind Visuals eigene Manifest-Rollen
 * (`imageHq`, `videoReal`, `videoAbstract`) statt manifestfreier Sonderfälle –
 * die frühere Aufteilung in `vision`/`video` entfällt damit.
 */
export const GPU_ENDPOINT_ROLES = [...GPU_ROLE_IDS] as const;

/** Rolle eines beliebigen GPU-Endpoints. */
export type GpuEndpointRole = (typeof GPU_ENDPOINT_ROLES)[number];

/**
 * Liest eine Zahl aus der Umgebung — browser-sicher: ohne `process` (Client-Bundle)
 * faellt der Wert auf `fallback` zurueck, statt mit `ReferenceError` zu crashen.
 * Wird auch von den client-erreichbaren Orchestrator-Modulen genutzt
 * (circuitBreaker, costTracker).
 */
export function envNumber(name: string, fallback: number): number {
  if (typeof process === 'undefined' || !process.env) return fallback;
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Liest einen String aus der Umgebung — browser-sicher (siehe `envNumber`). */
export function envString(name: string, fallback: string): string {
  if (typeof process === 'undefined' || !process.env) return fallback;
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/** Harte Obergrenze aktiver GPU-Endpoints (Kostenregel). */
export const AI_MAX_GPU_ENDPOINTS = envNumber('AI_MAX_GPU_ENDPOINTS', 8);

/** Budget: maximale Kosten pro laufender Stunde (EUR) für die gesamte Flotte. */
export const AI_MAX_FLEET_EUR_PER_HOUR = envNumber('AI_MAX_FLEET_EUR_PER_HOUR', 10);

/** Budget: maximale Speicher-/Snapshot-Kosten pro Monat (EUR), Hetzner + RunPod. */
export const AI_MAX_STORAGE_EUR_PER_MONTH = envNumber('AI_MAX_STORAGE_EUR_PER_MONTH', 5);

/** Harte Obergrenze der Hetzner-Server (Rollen app/sfu/ai/master/edge). */
export const AI_MAX_HETZNER_SERVERS = envNumber('AI_MAX_HETZNER_SERVERS', 5);

/**
 * Zielband der laufenden Flottenkosten (EUR/h) — weicher Korridor unterhalb der
 * harten Grenze `AI_MAX_FLEET_EUR_PER_HOUR`. Oberhalb `max` soll die Flotte
 * gedrosselt werden, ohne die harte Grenze zu reißen.
 */
export const AI_TARGET_FLEET_EUR_PER_HOUR = { min: 5, max: 7.5 } as const;

/**
 * Erfahrungswert der laufenden Hetzner-Kosten aller fünf Rollen (app/sfu/ai/
 * master/edge) in EUR/h — Konstitution §3. Der Guard rechnet ihn zur GPU-Flotte
 * dazu, weil die Konstitutionsgrenze (10 €/h) BEIDE Seiten umfasst.
 */
export const AI_HETZNER_EUR_PER_HOUR = envNumber('AI_HETZNER_EUR_PER_HOUR', 0.054);

/**
 * Angenommene Speicher-/Snapshot-Kosten in EUR/Monat.
 *
 * Ist-Wert der Flotte (2026-09-20 per Hetzner-API gemessen): 10 Snapshots,
 * 2 je Rolle (Retention `SNAPSHOT_RETENTION=2`), Summe image_size ≈ 50,4 GB
 * ≈ 0,50 €/Monat bei ~0,01 €/GB/Monat. Die früheren 0,30 €/Monat gingen von
 * fünf Snapshots (~25,5 GB) aus; die Retention hält jetzt zehn. Dient dem
 * Storage-Guard als Ist-Wert, solange die Abrechnung nicht live gelesen wird.
 */
export const AI_ESTIMATED_STORAGE_EUR_PER_MONTH = envNumber('AI_ESTIMATED_STORAGE_EUR_PER_MONTH', 0.5);

/**
 * Laufzeit-Grenzen der Budget-Guards.
 *
 * Die Werte starten aus den Konstanten oben (env-gestützt) und sind zur Laufzeit
 * überschreibbar: Ops kann die Grenzen senken (z. B. Zielband erzwingen), und
 * Tests können eine Überschreitung herstellen, ohne die Umgebung zu verbiegen.
 */
export interface AiBudgetLimits {
  maxEurPerHour: number;
  maxStorageEurPerMonth: number;
  maxGpuEndpoints: number;
  maxHetznerServers: number;
}

let budgetLimits: AiBudgetLimits = {
  maxEurPerHour: AI_MAX_FLEET_EUR_PER_HOUR,
  maxStorageEurPerMonth: AI_MAX_STORAGE_EUR_PER_MONTH,
  maxGpuEndpoints: AI_MAX_GPU_ENDPOINTS,
  maxHetznerServers: AI_MAX_HETZNER_SERVERS,
};

/** Aktuelle Laufzeit-Grenzen (Kopie — Mutation von außen ist wirkungslos). */
export function getBudgetLimits(): AiBudgetLimits {
  return { ...budgetLimits };
}

/** Setzt einzelne Laufzeit-Grenzen und liefert den neuen Stand. */
export function setBudgetLimits(partial: Partial<AiBudgetLimits>): AiBudgetLimits {
  budgetLimits = { ...budgetLimits, ...partial };
  return getBudgetLimits();
}

/** Stellt den env-Stand wieder her (Ops-Reset bzw. Test-Isolation). */
export function resetBudgetLimits(): AiBudgetLimits {
  budgetLimits = {
    maxEurPerHour: AI_MAX_FLEET_EUR_PER_HOUR,
    maxStorageEurPerMonth: AI_MAX_STORAGE_EUR_PER_MONTH,
    maxGpuEndpoints: AI_MAX_GPU_ENDPOINTS,
    maxHetznerServers: AI_MAX_HETZNER_SERVERS,
  };
  return getBudgetLimits();
}

/**
 * Visual-Rollen: laufen NICHT dauerhaft, sondern erst bei Abruf/Aktivierung
 * (Bild-/Video-Generierung) und fallen danach per `idleTimeout` auf Null zurück.
 * Alle übrigen Rollen laufen bei "AI an" voll (kein Lazy-Load).
 */
export const AI_VISUAL_ROLES = [
  'imageHq',
  'videoReal',
  'videoAbstract',
] as const satisfies readonly GpuEndpointRole[];

/** true, wenn die Rolle eine bedarfsgesteuerte Visual-Rolle ist. */
export function isVisualRole(role: GpuEndpointRole): boolean {
  return (AI_VISUAL_ROLES as readonly GpuEndpointRole[]).includes(role);
}

/** Rollen, die bei "AI an" immer laufen (alle außer den Visual-Rollen). */
export function alwaysOnRoles(): GpuEndpointRole[] {
  return GPU_ENDPOINT_ROLES.filter((role) => !isVisualRole(role));
}

/**
 * Budget-Guard: OBERGRENZE je Endpoint-Rolle in EUR/h (48-GB-GPU, scale-to-zero).
 *
 * FLEET-P1-015 (e): Es gibt genau EINE Preis-Tabelle - `RUNPOD_48GB_USD_PER_HOUR`
 * weiter unten ist der Listenpreis, aus dem `estimateCostUsd` und die
 * Resident-Schaetzung rechnen. Diese Tabelle ist bewusst NICHT gleich diesem
 * umgerechneten Wert, sondern eine konservative Obergrenze fuer den Guard
 * (0,49 EUR/h >= 0,49 USD/h * 0,92 = 0,4508 EUR/h). Ein Guard darf nie zu
 * niedrig liegen; ein Test haelt die Ungleichung fest, damit die beiden
 * Tabellen nicht wieder auseinanderlaufen.
 */
export const FLEET_ROLE_EUR_PER_HOUR: Record<GpuEndpointRole, number> = {
  brain: 0.49,
  ears: 0.49,
  voiceGen: 0.49,
  music: 0.49,
  'audio-gen': 0.34,
  imageHq: 0.49,
  videoReal: 0.49,
  videoAbstract: 0.49,
  orchestrator: 0.49,
};

/**
 * Alt-Endpoints, die NICHT mehr verwendet werden dürfen (nur Doku/Status).
 * `audiomonastry-ai` war der gemeinsame HF-Custom-Container, die übrigen die
 * abgeschalteten HF-Pilot-/CLAP-Endpoints.
 */
export const LEGACY_GPU_ENDPOINTS = [
  'audiomonastry-ai',
  'audiomonastry-ai-pilot',
  'audiomonastry-ai-clap',
] as const;

/** Namenskonvention der RunPod-Serverless-Endpoints je Rolle. */
const ENDPOINT_NAME_BY_ROLE: Record<GpuEndpointRole, string> = {
  brain: 'audiomonastry-ai-brain',
  ears: 'audiomonastry-ai-ears',
  voiceGen: 'audiomonastry-ai-voice',
  music: 'audiomonastry-ai-music',
  'audio-gen': 'audiomonastry-ai-audio-gen',
  imageHq: 'audiomonastry-ai-image',
  videoReal: 'audiomonastry-ai-video-real',
  videoAbstract: 'audiomonastry-ai-video-abstract',
  orchestrator: 'audiomonastry-ai-orchestrator',
};

export function endpointNameForRole(role: GpuEndpointRole): string {
  return ENDPOINT_NAME_BY_ROLE[role];
}

/**
 * Verhindert versehentlich konfigurierte GPU-Infrastruktur jenseits der
 * erlaubten Rollen. Wird beim Start des Provider-Routers aufgerufen.
 */
export function assertGpuEndpointBudget(): void {
  const max = getBudgetLimits().maxGpuEndpoints;
  if (!Number.isInteger(max) || max < 1 || max > GPU_ENDPOINT_ROLES.length) {
    throw new Error(
      `AI_MAX_GPU_ENDPOINTS muss zwischen 1 und ${GPU_ENDPOINT_ROLES.length} liegen (aktuell: ${max}). ` +
        `Die AI-Flotte besteht aus den Rollen ${GPU_ENDPOINT_ROLES.join(', ')} – weitere GPU-Endpoints sind nicht erlaubt.`,
    );
  }
}

/** Wirft, wenn die Hetzner-Serverzahl die Konstitution überschreitet. */
export function assertHetznerServerBudget(count: number): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Hetzner-Serverzahl muss eine nicht-negative Ganzzahl sein (erhielt: ${count}).`);
  }
  if (count > getBudgetLimits().maxHetznerServers) {
    throw new Error(
      `Hetzner-Flotte ${count} Server übersteigt die Konstitution von ${getBudgetLimits().maxHetznerServers} Servern ` +
        `(app/sfu/ai/master/edge) — siehe docs/INFRA_KONSTITUTION.md.`,
    );
  }
}

/** Summe der Erfahrungswerte für einen Satz aktiver Rollen (EUR/h). */
export function estimateFleetEurPerHour(active: readonly GpuEndpointRole[]): number {
  return active.reduce((sum, role) => sum + (FLEET_ROLE_EUR_PER_HOUR[role] ?? 0), 0);
}

/**
 * Wirft, wenn eine laufende Flotte teurer wäre als erlaubt.
 * `extraEurPerHour` bildet die Hetzner-Instanzen ab (nicht in der Rollen-Tabelle).
 */
export function assertFleetHourlyBudget(active: readonly GpuEndpointRole[], extraEurPerHour = 0): void {
  const total = estimateFleetEurPerHour(active) + Math.max(0, extraEurPerHour);
  const limit = getBudgetLimits().maxEurPerHour;
  if (total > limit) {
    throw new Error(
      `Flotten-Kosten ${total.toFixed(2)} €/h übersteigen das Budget von ${limit} €/h ` +
        `(Rollen: ${active.join(', ')}${extraEurPerHour ? `, Hetzner +${extraEurPerHour.toFixed(2)} €/h` : ''}).`,
    );
  }
}

/** Wirft, wenn Speicher-/Snapshot-Kosten das Monatsbudget sprengen würden. */
export function assertStorageBudget(monthlyEur: number): void {
  if (!Number.isFinite(monthlyEur) || monthlyEur < 0) {
    throw new Error(`Speicherkosten müssen eine nicht-negative Zahl sein (erhielt: ${monthlyEur}).`);
  }
  const limit = getBudgetLimits().maxStorageEurPerMonth;
  if (monthlyEur > limit) {
    throw new Error(
      `Speicherkosten ${monthlyEur.toFixed(2)} €/Monat übersteigen das Budget von ` +
        `${limit} €/Monat (Hetzner + RunPod).`,
    );
  }
}

/** Ist-Stand eines Budgets inkl. Bewertung gegen Grenze und Zielband. */
export interface BudgetCheck {
  /** Ist-Wert (EUR/h bzw. EUR/Monat). */
  value: number;
  /** Harte Grenze aus den Laufzeit-Limits. */
  limit: number;
  withinLimit: boolean;
  /** Fehlermeldung des Guards, wenn die Grenze gerissen ist. */
  violation?: string;
}

/**
 * Prüft einen Wert gegen einen Guard und liefert das Ergebnis statt zu werfen.
 * Für Status-/Alarm-Pfade (Flotten-Status, Monitoring): dort soll eine
 * Überschreitung sichtbar und geloggt werden, ohne die Antwort abzureißen.
 */
function checkBudget(value: number, guard: () => void, limit: number): BudgetCheck {
  try {
    guard();
    return { value, limit, withinLimit: true };
  } catch (error) {
    return { value, limit, withinLimit: false, violation: (error as Error).message };
  }
}

/**
 * Gesamtbericht der laufenden und der Speicher-Kosten gegen die Konstitution.
 * Pur (kein Netzwerk), für `fleetStatus()` und die Budget-Route.
 */
export interface FleetBudgetReport {
  /** GPU-Rollen allein (EUR/h). */
  gpuEurPerHour: number;
  /** Hetzner-Anteil (EUR/h). */
  hetznerEurPerHour: number;
  /** Gesamt laufend (EUR/h) — GPU + Hetzner. */
  totalEurPerHour: number;
  hourly: BudgetCheck;
  /** Zielband aus `AI_TARGET_FLEET_EUR_PER_HOUR`. */
  target: { min: number; max: number; within: boolean };
  storage: BudgetCheck;
}

export function fleetBudgetReport(
  active: readonly GpuEndpointRole[],
  hetznerEurPerHour = AI_HETZNER_EUR_PER_HOUR,
  storageEurPerMonth = AI_ESTIMATED_STORAGE_EUR_PER_MONTH,
): FleetBudgetReport {
  const gpuEurPerHour = estimateFleetEurPerHour(active);
  const hetzner = Math.max(0, hetznerEurPerHour);
  const total = gpuEurPerHour + hetzner;
  const hourly = checkBudget(total, () => assertFleetHourlyBudget(active, hetzner), getBudgetLimits().maxEurPerHour);
  return {
    gpuEurPerHour,
    hetznerEurPerHour: hetzner,
    totalEurPerHour: total,
    hourly,
    target: {
      ...AI_TARGET_FLEET_EUR_PER_HOUR,
      within: total >= AI_TARGET_FLEET_EUR_PER_HOUR.min && total <= AI_TARGET_FLEET_EUR_PER_HOUR.max,
    },
    storage: checkBudget(
      storageEurPerMonth,
      () => assertStorageBudget(storageEurPerMonth),
      getBudgetLimits().maxStorageEurPerMonth,
    ),
  };
}

// ============================================================================
// RunPod SSOT 2026-11-09: 7 KI-Pods + 1 visPod, ausschliesslich A40 (48GB).
// Aktive Modelle und Revisionspins: deploy/runpod/pod-fleet.json + model_manifest.json.
// Diese Werte sind bis zum GPU-Live-Test VRAM-Schaetzungen.
// ============================================================================

/** Harte Grenze: laufende AI-Kosten zusätzlich zur Hetzner-Basis (EUR/h). */
export const AI_MAX_AI_EUR_PER_HOUR = Math.min(8, envNumber('AI_MAX_AI_EUR_PER_HOUR', 8));

/** Umrechnung $ → € (wie docs/AI_COST_GUIDE.md). */
export const USD_TO_EUR = envNumber('AI_USD_TO_EUR', 0.92);

/** RunPod-Listenpreise 48 GB in $/h, nach Abrechnungsart. */
export const RUNPOD_48GB_USD_PER_HOUR = {
  pod: { A40: 0.35, L40S: 0.79 },
  serverlessFlex: { A40: 1.22, L40S: 1.75 },
} as const;

export type ResidentBilling = keyof typeof RUNPOD_48GB_USD_PER_HOUR;
export type ResidentGpu = 'A40' | 'L40S';

/** Nutzbarer VRAM je 48-GB-Karte: Budget minus Sicherheitsmarge (model_manifest.json). */
export const RESIDENT_USABLE_VRAM_GB = 42;

/**
 * Ein dauerhaft residentes Modell. `vramGb` = Gewichte (+ eingebaute Textencoder),
 * GESCHÄTZT (aus HF-Parameterzahlen bzw. Manifest) – keine A40-Messung (FLEET-P1-011).
 */
export interface ResidentModel {
  id: string;
  vramGb: number;
  license: string;
  /**
   * 'manifest' = steht in model_manifest.json mit Handler (Schätzung wird gegengeprüft);
   * 'neu' = entschieden, aber ohne Handler: Manifest-Eintrag mit status "neu" (in keiner
   * Rolle, wird nie geladen) – Ausnahme RP1, dessen Zielmodell nicht im Manifest steht.
   */
  status: 'manifest' | 'neu';
  /** true = Lizenzbedingungen (Gating/AGPL/GPL/ungeklärt) vor kommerziellem Einsatz prüfen. */
  licenseCheck?: boolean;
  /** true = nur nicht-kommerziell frei; erlaubt, weil alles privat/Forschung ist (Betreiber 2026-10-07/-12). */
  nonCommercial?: boolean;
  /** 'onRequest' = resident, läuft aber nur auf ausdrücklichen Wunsch; 'fallback' = Ersatz bei kommerzieller Nutzung. */
  usage?: 'onRequest' | 'fallback';
}

/** Zusätzlich reservierter VRAM ohne eigenes Modell (z. B. vLLM-KV-Cache), geschätzt. */
export interface ResidentReserve {
  id: string;
  vramGb: number;
}

/** Modelle, die auf zwei residenten Pods bewusst separat vorgeladen werden. */
export const AI_RESIDENT_SHARED_MODELS = ['acestep-v15-shared'] as const;

/** Rollen ohne GPU-Instanz: Visuals entstehen aus vorhandenem Material (Betreiber 2026-10-07). */

/** Eine residente 48-GB-Instanz. */
export interface ResidentInstance {
  id: string;
  /** API-Rollen, die diese Instanz direkt abdeckt (fachliche Pods besitzen eigene AI_ROLE). */
  covers: readonly GpuEndpointRole[];
  models: readonly ResidentModel[];
  reserves?: readonly ResidentReserve[];
}

/**
 * Selected eight-role model inventory, including the vis restoration models.
 * Capacity estimates are checked against each selected GPU class by the drift test.
 * Runtime certification is separate from this declared inventory.
 */
export const AI_RESIDENT_FLEET = [
  {
    "id": "brain",
    "covers": [
      "brain",
      "orchestrator"
    ],
    "models": [
      {
        "id": "qwen38-27b-fp8",
        "vramGb": 37,
        "license": "Apache-2.0",
        "status": "manifest"
      }
    ],
    "reserves": [
      {
        "id": "runtime-headroom",
        "vramGb": 4
      }
    ]
  },
  {
    "id": "ears",
    "covers": [
      "ears"
    ],
    "models": [
      {
        "id": "moss-music-8b-instruct",
        "vramGb": 26,
        "license": "Apache-2.0",
        "status": "manifest"
      },
      {
        "id": "clap-music",
        "vramGb": 4,
        "license": "Apache-2.0",
        "status": "manifest"
      },
      {
        "id": "beat-this",
        "vramGb": 1,
        "license": "MIT (Code, LICENSE im GitHub-Repo gelesen 2026-10-12); Gewichte-Lizenz unbelegt",
        "status": "manifest"
      },
      {
        "id": "songformer",
        "vramGb": 3,
        "license": "unklar (kein HF-Lizenz-Tag; README-Badge CC BY 4.0; MuQ-Abhaengigkeit ungeprueft)",
        "status": "manifest"
      },
      {
        "id": "dsp-analysis",
        "vramGb": 0,
        "license": "private-test",
        "status": "manifest"
      },
      {
        "id": "basic-pitch",
        "vramGb": 0,
        "license": "private-test",
        "status": "manifest"
      }
    ],
    "reserves": [
      {
        "id": "runtime-headroom",
        "vramGb": 2
      }
    ]
  },
  {
    "id": "voice",
    "covers": [
      "voiceGen"
    ],
    "models": [
      {
        "id": "qwen3-tts-17b",
        "vramGb": 8,
        "license": "Apache-2.0",
        "status": "manifest"
      },
      {
        "id": "qwen3-tts-voicedesign",
        "vramGb": 8,
        "license": "Apache-2.0",
        "status": "manifest"
      },
      {
        "id": "moss-soundeffect-v2.0",
        "vramGb": 8,
        "license": "Apache-2.0",
        "status": "manifest"
      },
      {
        "id": "acestep-v15-xl-base",
        "vramGb": 10,
        "license": "MIT",
        "status": "manifest"
      },
      {
        "id": "acestep-v15-shared",
        "vramGb": 2,
        "license": "MIT",
        "status": "manifest"
      }
    ],
    "reserves": [
      {
        "id": "runtime-headroom",
        "vramGb": 3
      }
    ]
  },
  {
    "id": "music",
    "covers": [
      "music"
    ],
    "models": [
      {
        "id": "acestep-v15-xl-turbo",
        "vramGb": 10,
        "license": "MIT",
        "status": "manifest"
      },
      {
        "id": "acestep-5hz-lm-4b",
        "vramGb": 9,
        "license": "MIT",
        "status": "manifest"
      },
      {
        "id": "acestep-v15-shared",
        "vramGb": 2,
        "license": "MIT",
        "status": "manifest"
      }
    ],
    "reserves": [
      {
        "id": "runtime-headroom",
        "vramGb": 6
      }
    ]
  },
  {
    "id": "studio",
    "covers": [
      "voiceGen"
    ],
    "models": [
      {
        "id": "sonicmaster",
        "vramGb": 8,
        "license": "Apache-2.0",
        "status": "manifest"
      },
      {
        "id": "bs-roformer-sw-6stem",
        "vramGb": 6,
        "license": "UNGEKLAERT (HF license:unknown; Spiegel von enerjazzer/BS-ROFO-SW-Fixed, Urheber-Konto geloescht)",
        "status": "manifest"
      },
      {
        "id": "mvsep-mega-53",
        "vramGb": 32,
        "license": "research",
        "status": "manifest"
      },
      {
        "id": "mel-roformer-bve",
        "vramGb": 3,
        "license": "private-test",
        "status": "manifest"
      }
    ],
    "reserves": [
      {
        "id": "runtime-headroom",
        "vramGb": 12
      }
    ]
  },
  {
    "id": "audio-brain",
    "covers": [
      "brain"
    ],
    "models": [
      {
        "id": "qwen3-4b",
        "vramGb": 11,
        "license": "Apache-2.0",
        "status": "manifest"
      }
    ],
    "reserves": [
      {
        "id": "runtime-headroom",
        "vramGb": 3
      }
    ]
  },
  {
    "id": "song",
    "covers": [
      "music"
    ],
    "models": [
      {
        "id": "yue2-3b",
        "vramGb": 15,
        "license": "CC-BY-NC-4.0",
        "status": "manifest"
      }
    ],
    "reserves": [
      {
        "id": "runtime-headroom",
        "vramGb": 3
      }
    ]
  },
  {
    "id": "vis",
    "covers": [
      "voiceGen"
    ],
    "models": [
      {
        "id": "universr",
        "vramGb": 4,
        "license": "CC-BY-4.0",
        "status": "manifest"
      },
      {
        "id": "mel-roformer-dereverb",
        "vramGb": 3,
        "license": "GPL-3.0",
        "status": "manifest"
      }
    ],
    "reserves": [
      {
        "id": "runtime-headroom",
        "vramGb": 14
      }
    ]
  }
] as const satisfies readonly ResidentInstance[];

/** Summe der residenten Gewichte (+ Reserven) einer Instanz in GB. */
export function residentVramGb(instance: ResidentInstance): number {
  const models = instance.models.reduce((sum, m) => sum + m.vramGb, 0);
  return models + (instance.reserves ?? []).reduce((sum, r) => sum + r.vramGb, 0);
}

/** Kosten der residenten Flotte in EUR/h für eine Abrechnungsart und GPU-Klasse. */
export function estimateResidentFleetEurPerHour(
  billing: ResidentBilling,
  gpu: ResidentGpu,
  instances: number = AI_RESIDENT_FLEET.length,
): number {
  return RUNPOD_48GB_USD_PER_HOUR[billing][gpu as keyof (typeof RUNPOD_48GB_USD_PER_HOUR)[typeof billing]] * USD_TO_EUR * instances;
}

/** Wirft, wenn die residente Flotte den AI-Aufpreis (4 €/h) sprengt. */
export function assertResidentFleetBudget(
  billing: ResidentBilling,
  gpu: ResidentGpu,
  instances: number = AI_RESIDENT_FLEET.length,
): void {
  const total = estimateResidentFleetEurPerHour(billing, gpu, instances);
  if (total > AI_MAX_AI_EUR_PER_HOUR) {
    throw new Error(
      `AI-Flotte ${instances}× ${gpu} (${billing}) kostet ${total.toFixed(2)} €/h und übersteigt ` +
        `das AI-Budget von ${AI_MAX_AI_EUR_PER_HOUR} €/h.`,
    );
  }
}
