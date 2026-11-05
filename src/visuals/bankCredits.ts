/**
 * MEDIA-2026-11-04-005 — Namensnennung fuer die Visual-Bank.
 *
 * Die importierten Clips stehen unter CC-BY/BY-SA (teils CC0/PD). Lizenz,
 * Autor und Quell-URL liegen bereits in `importedBank.generated.ts`; dieses
 * Modul schlaegt sie ueber die `src` nach, die die Show tatsaechlich benutzt
 * (`/api/ai/vision/bank/<id>`), fasst die Session zusammen und baut den
 * Exporttext. Es speichert nichts — der Export laeuft ausschliesslich ueber
 * einen expliziten Klick des Nutzers (Betreiberregel).
 */
import { IMPORTED_CLIPS, type ImportedClip } from './importedBank.generated';

export interface ClipCredit {
  /** Basis-ID des Bank-Clips (Varianten teilen sich die ID). */
  id: string;
  label: string;
  title: string;
  /** Autor/Urheber aus der Bank; kann leer sein (z. B. CC0). */
  attribution: string;
  license: string;
  sourceUrl: string;
  category: string;
  /** In dieser Session gezeigte Varianten (Bearbeitungen), z. B. `fast`. */
  variants: string[];
}

export interface SessionCredits {
  /** Fremdlizenzierte Clips in der Reihenfolge des ersten Auftritts. */
  entries: ClipCredit[];
  /** Anzahl unterschiedlicher Szenen ohne Bank-Lizenz (Vorlagen/KI-Bilder). */
  uncredited: number;
}

interface BankIndexEntry {
  clip: ImportedClip;
  variant: string | null;
}

/**
 * id + alle Varianten-Kennungen auf ihren Basis-Clip abbilden. Die Varianten
 * sind Bearbeitungen (`fast`, `grau`, `mirror`, …) und werden deshalb im
 * Credits-Text als solche gekennzeichnet.
 */
const BANK_INDEX: ReadonlyMap<string, BankIndexEntry> = (() => {
  const index = new Map<string, BankIndexEntry>();
  for (const clip of IMPORTED_CLIPS) {
    index.set(clip.id, { clip, variant: null });
    for (const variant of clip.varianten) {
      index.set(`${clip.id}_${variant}`, { clip, variant });
    }
  }
  return index;
})();

const BANK_ROUTE = '/api/ai/vision/bank/';
const R2_BANK_PATH = /\/visuals\/bank\/([^/]+)$/;

/**
 * Datei-Stamm aus einer Show-`src`: Bank-Route, oeffentliche R2-URL oder
 * Pfad. Query/Hash und Endung werden entfernt. `null` fuer alles, was nicht
 * aus der Bank kommt (data:-URI, KI-Bild, fremde URL).
 */
export function bankClipKey(src: string): string | null {
  if (!src) return null;
  const path = src.split(/[?#]/)[0];
  let stem: string;
  const routeAt = path.indexOf(BANK_ROUTE);
  if (routeAt >= 0) {
    stem = path.slice(routeAt + BANK_ROUTE.length);
  } else {
    const match = R2_BANK_PATH.exec(path);
    if (!match) return null;
    stem = match[1];
  }
  stem = stem.replace(/\.(mp4|webm|mov|jpg|jpeg|png)$/i, '');
  if (!stem || stem.includes('/')) return null;
  return stem;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toCredit(clip: ImportedClip, variants: string[] = []): ClipCredit {
  return {
    id: clip.id,
    label: clip.label,
    title: normalizeWhitespace(clip.title),
    attribution: normalizeWhitespace(clip.attribution),
    license: normalizeWhitespace(clip.license),
    sourceUrl: clip.sourceUrl.trim(),
    category: clip.category,
    variants: [...variants],
  };
}

function lookupEntry(src: string): BankIndexEntry | null {
  const key = bankClipKey(src);
  return key ? BANK_INDEX.get(key) ?? null : null;
}

/** Lizenzangaben fuer einen einzelnen Clip (inkl. Variante), sonst `null`. */
export function lookupClipCredit(src: string): ClipCredit | null {
  const hit = lookupEntry(src);
  if (!hit) return null;
  return toCredit(hit.clip, hit.variant ? [hit.variant] : []);
}

/**
 * Szenen einer Session zu einer Credit-Liste zusammenfassen. Reihenfolge =
 * erster Auftritt; Varianten desselben Clips landen in einem Eintrag.
 * Szenen ausserhalb der Import-Bank (eigene Vorlagen, KI-Bilder) werden
 * gezaehlt, aber nicht erfunden.
 */
export function sessionCredits(srcs: readonly string[]): SessionCredits {
  const entries: ClipCredit[] = [];
  const byId = new Map<string, ClipCredit>();
  const uncreditedSrcs = new Set<string>();

  for (const src of srcs) {
    const hit = lookupEntry(src);
    if (!hit) {
      if (src) uncreditedSrcs.add(src);
      continue;
    }
    const existing = byId.get(hit.clip.id);
    if (!existing) {
      const credit = toCredit(hit.clip, hit.variant ? [hit.variant] : []);
      byId.set(credit.id, credit);
      entries.push(credit);
      continue;
    }
    if (hit.variant && !existing.variants.includes(hit.variant)) {
      existing.variants.push(hit.variant);
    }
  }

  return { entries, uncredited: uncreditedSrcs.size };
}

type LicenseKind = 'by-sa' | 'by' | 'public-domain' | 'other';

function licenseKind(license: string): LicenseKind {
  const normalized = license.toUpperCase().replace(/[\s_-]/g, '');
  if (normalized.includes('BYSA')) return 'by-sa';
  if (normalized.includes('BY')) return 'by';
  if (normalized.includes('CC0') || normalized.includes('PUBLICDOMAIN')) return 'public-domain';
  return 'other';
}

function editNotice(variants: readonly string[]): string {
  if (variants.length === 0) return '';
  const names = variants.map((v) => `"${v}"`).join(', ');
  const label = variants.length === 1 ? 'Variante' : 'Varianten';
  return `Bearbeitung: ${label} ${names} – Änderungen gegenüber dem Original (Zuschnitt/Farbe/Tempo).`;
}

function licenseNote(license: string, variants: readonly string[]): string {
  const edit = editNotice(variants);
  const kind = licenseKind(license);
  if (kind === 'by-sa') {
    return [
      edit,
      'Namensnennung erforderlich.',
      'ShareAlike: Weitergabe nur unter derselben Lizenz (CC BY-SA).',
    ].filter(Boolean).join(' ');
  }
  if (kind === 'by') {
    return [edit, 'Namensnennung erforderlich (CC BY).'].filter(Boolean).join(' ');
  }
  if (kind === 'public-domain') {
    return 'Gemeinfrei (CC0/Public Domain) – Namensnennung nicht erforderlich, Quelle wird freiwillig genannt.';
  }
  return [edit, license ? `Lizenz: ${license}` : 'Keine Lizenzangabe in der Bank.']
    .filter(Boolean)
    .join(' ');
}

export interface CreditsTextOptions {
  /** Szenen ohne Fremdlizenz (eigene Vorlagen/KI) — nur als Anzahl. */
  uncredited?: number;
  /** Zeitstempel des Exports; im Test fest setzbar. */
  generatedAt?: Date;
}

/** Vollstaendiger Text fuer den Nutzer-Export (Plaintext, UTF-8). */
export function buildCreditsText(
  credits: readonly ClipCredit[],
  options: CreditsTextOptions = {},
): string {
  const uncredited = options.uncredited ?? 0;
  const generatedAt = options.generatedAt ?? new Date();
  const lines: string[] = [
    'VISUAL · NAMENSNENNUNG (Session)',
    `Stand: ${generatedAt.toISOString()}`,
    `Clips mit Fremdlizenz: ${credits.length}`,
    '',
  ];

  if (credits.length === 0) {
    lines.push('Keine fremdlizenzierten Clips in dieser Session gezeigt.');
    lines.push('');
  } else {
    credits.forEach((credit, i) => {
      const title = credit.title && credit.title !== credit.label ? ` — ${credit.title}` : '';
      lines.push(`${i + 1}. ${credit.label}${title}`);
      lines.push(`   ID: ${credit.id}`);
      lines.push(`   Autor: ${credit.attribution || 'nicht angegeben'}`);
      lines.push(`   Lizenz: ${credit.license || 'keine Angabe'}`);
      if (credit.sourceUrl) lines.push(`   Quell-URL: ${credit.sourceUrl}`);
      lines.push(`   Datei: ${BANK_ROUTE}${credit.id}`);
      if (credit.variants.length > 0) {
        lines.push(`   Variante: ${credit.variants.join(', ')} (Bearbeitung des Originals)`);
      }
      lines.push(`   Hinweis: ${licenseNote(credit.license, credit.variants)}`);
      lines.push('');
    });
  }

  if (uncredited > 0) {
    lines.push(`${uncredited} ${uncredited === 1 ? 'Szene' : 'Szenen'} ohne Fremdlizenz (eigene Vorlagen oder KI-Generierungen).`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Dateiname des Exports, z. B. `visual-credits-2026-11-05.txt`. */
export function creditsFileName(date: Date = new Date()): string {
  return `visual-credits-${date.toISOString().slice(0, 10)}.txt`;
}
