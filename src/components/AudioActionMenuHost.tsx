// ============================================================================
// audioMONASTRY · AudioActionMenuHost
// ----------------------------------------------------------------------------
// Zentrale, einheitliche Click-/Touch-Kontextaktion für Audioinhalte.
//
// Jedes Audio-Element ruft `openAudioActionMenu(content, anchor)` auf. Der Host
// rendert das Menü (Mouse + Touch via Pointer/Click, Tastatur via Enter/Space
// in den jeweiligen Auslösern) und nutzt ausschließlich vorhandene
// Funktionen/State: audioEngine, ProjectContext, SampleContext, ModuleState.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ClipboardCopy,
  FolderInput,
  Headphones,
  Lock,
  Music2,
  Send,
  Target,
} from 'lucide-react';
import { audioEngine } from '../utils/audioEngine';
import { useProject } from '../context/ProjectContext';
import { useModuleState } from '../context/ModuleStateContext';
import { useSamples } from '../context/SampleContext';
import { ALL_TRACKS, type TrackType } from '../types';
import type { AudioContentRef } from '../core/session/projectState';
import {
  canPreview,
  hasAudioUrl,
  isStreamContent,
  toPluginSample,
} from '../core/audio/audioContent';

// ---------------------------------------------------------------------------
// Imperative Öffnungs-Bus (bewusst minimal; kein eigenes Event-System nötig).
// ---------------------------------------------------------------------------

type AnchorInput = HTMLElement | DOMRect | { x: number; y: number } | null | undefined;

interface OpenRequest {
  content: AudioContentRef;
  x: number;
  y: number;
}

let openHandler: ((req: OpenRequest) => void) | null = null;

export function openAudioActionMenu(content: AudioContentRef, anchor?: AnchorInput): void {
  if (!openHandler) return;
  const rect = toRect(anchor);
  openHandler({ content, x: rect.x, y: rect.y });
}

/**
 * Ein-Klick-Wiedergabe für Audio-Karten: URL vorhanden → abspielen; gleiche
 * URL nochmal → stoppen. Ohne URL wird das Aktionsmenü geöffnet (Fallback).
 */
export function toggleAudioPreview(content: AudioContentRef, anchor?: AnchorInput): void {
  if (hasAudioUrl(content)) {
    const url = content.url as string;
    if (audioEngine.getPreviewUrl() === url) {
      audioEngine.stopPreview();
    } else {
      audioEngine.previewSample('channel5', undefined, url);
    }
    return;
  }
  openAudioActionMenu(content, anchor);
}

function toRect(anchor: AnchorInput): { x: number; y: number } {
  if (!anchor) return { x: 120, y: 120 };
  if ('left' in anchor && 'top' in anchor && 'width' in anchor) {
    const r = anchor as DOMRect;
    return { x: r.left, y: r.bottom + 6 };
  }
  if (anchor instanceof HTMLElement) {
    const r = anchor.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 6 };
  }
  return { x: (anchor as { x: number; y: number }).x, y: (anchor as { x: number; y: number }).y };
}

type Submenu = 'track' | 'plugin' | 'spatial' | null;

const MENU_WIDTH = 264;
const SUBMENU_WIDTH = 264;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const trackNames: Record<TrackType, string> = {
  channel1: 'KICK',
  channel2: 'HAT',
  channel3: 'CLAP',
  channel4: 'SAMPLE',
  channel5: 'SAMPLE',
  channel6: 'SAMPLE',
  channel7: 'BASS',
  channel8: 'LEAD',
};

/** Plugins, die bereits geöffnet sind und einen vorhandenen Audio-Eingang besitzen. */
const SUITABLE_PLUGIN_TARGETS: { id: string; label: string; hint: string }[] = [
  { id: 'sampler', label: 'samplerMONK', hint: 'gewähltes Pad' },
  { id: 'drum', label: 'drumMONK', hint: 'nächster freier Step' },
  { id: 'mcp', label: 'mcpMONK', hint: 'gewähltes Pad' },
];

export const AudioActionMenuHost: React.FC = () => {
  const [req, setReq] = useState<OpenRequest | null>(null);
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** Öffnungszeitpunkt – verhindert, dass ein verspätetes Scroll-Event das
      frisch geöffnete Menü sofort wieder schließt (Browser/Playwright). */
  const openedAtRef = useRef(0);

  const { addClipboardItem, assignTrack, trackAssignments, spatialAssignments, requestSpatialTakeover, notice, dismissNotice } = useProject();
  const { moduleStates } = useModuleState();
  const { requestTakeover, pendingSample, setPendingSample } = useSamples();

  useEffect(() => {
    openHandler = (r: OpenRequest) => {
      openedAtRef.current = performance.now();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setPos({
        x: clamp(r.x, 8, Math.max(8, vw - MENU_WIDTH - 8)),
        y: clamp(r.y, 8, Math.max(8, vh - 360)),
      });
      setSubmenu(null);
      setReq(r);
    };
    return () => { openHandler = null; };
  }, []);

  const close = useCallback(() => {
    setReq(null);
    setSubmenu(null);
  }, []);

  // Außenklick/Scroll/Escape schließen (funktioniert für Mouse + Touch).
  // Scroll/Resize schließen erst nach einer kurzen Gnadenfrist, damit ein
  // verspätetes Scroll-Event (z. B. nach Auto-Scroll beim Klick) das frisch
  // geöffnete Menü nicht sofort wieder schließt.
  useEffect(() => {
    if (!req) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onScrollOrResize = () => {
      if (performance.now() - openedAtRef.current > 350) close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [req, close]);

  const openSub = (s: Submenu) => setSubmenu((prev) => (prev === s ? null : s));

  const content = req?.content ?? null;

  const spatialOpen = (moduleStates['spatial'] || 'OFF') !== 'OFF';
  const openPluginTargets = useMemo(
    () => SUITABLE_PLUGIN_TARGETS.filter((p) => (moduleStates[p.id] || 'OFF') !== 'OFF'),
    [moduleStates],
  );

  const handlePreview = useCallback(() => {
    if (!content) return;
    if (content.url) {
      try { audioEngine.previewSample('channel5', undefined, content.url); } catch { /* Audio nicht bereit */ }
    } else if (content.params) {
      try { audioEngine.previewSynthesizedSample(content.params); } catch { /* Audio nicht bereit */ }
    }
  }, [content]);

  const handleClipboard = useCallback(() => {
    if (!content) return;
    addClipboardItem(content);
    close();
  }, [content, addClipboardItem, close]);

  /** Touch-Fallback: Sample armieren, dann Drop-Zone antippen (bestehender Pfad). */
  const handleArm = useCallback(() => {
    if (!content) return;
    const s = toPluginSample(content);
    setPendingSample(pendingSample?.id === s.id ? null : s);
    close();
  }, [content, pendingSample, setPendingSample, close]);

  const handleTrack = useCallback((track: TrackType) => {
    if (!content) return;
    // Zusätzlich zur geteilten Belegung die LOKALE Audio-Engine prüfen
    // (bestehende Direkt-Ladepfade wie LOAD/ADD setzen ebenfalls Samples).
    if (audioEngine.isTrackLoaded(track)) return;
    const res = assignTrack(track, content);
    if (!res.ok) return;
    if (content.url) {
      void audioEngine.loadTrackSample(track, content.url).catch(() => { /* Track laden optional */ });
    }
    close();
  }, [content, assignTrack, close]);

  const handlePlugin = useCallback((pluginId: string) => {
    if (!content) return;
    requestTakeover(pluginId, toPluginSample(content));
    close();
  }, [content, requestTakeover, close]);

  const handleSpatial = useCallback((channelId: number) => {
    if (!content) return;
    // Shared-Claim + Audio-Routing erfolgen in spatialMONK nach lokaler Prüfung.
    requestSpatialTakeover(channelId, content);
    close();
  }, [content, requestSpatialTakeover, close]);

  if (!req || !content) {
    return notice ? (
      <NoticeToast notice={notice} onDismiss={dismissNotice} />
    ) : null;
  }

  const canSendToTrack = hasAudioUrl(content);
  const canSpatial = spatialOpen && (hasAudioUrl(content) || isStreamContent(content));
  const canPlugin = hasAudioUrl(content) || !!content.sample;

  return (
    <>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Audio-Aktionen"
        className="fixed z-[100] rounded-xl border border-neutral-700 bg-[#111]/95 backdrop-blur-xl text-neutral-200 shadow-[0_20px_60px_rgba(0,0,0,0.7)] font-sans max-h-[75vh] overflow-y-auto overflow-x-hidden"
        style={{ left: pos.x, top: pos.y, width: MENU_WIDTH }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Kopf */}
        <div className="px-3 py-2 border-b border-white/5 bg-white/[0.02]">
          <div className="flex items-center gap-2">
            <Music2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="text-[11px] font-bold truncate">{content.name}</span>
          </div>
          <span className="text-[8px] font-mono tracking-[0.25em] text-neutral-500 uppercase">
            {content.kind} · {content.source}
          </span>
        </div>

        <div className="p-1">
          {canPreview(content) && (
            <MenuItem icon={<Headphones className="w-3.5 h-3.5" />} label="Vorschau" onClick={() => { handlePreview(); close(); }} />
          )}

          <MenuItem
            icon={<ClipboardCopy className="w-3.5 h-3.5 text-fuchsia-400" />}
            label="Copy to Project Clipboard"
            onClick={handleClipboard}
          />

          <MenuItem
            icon={<Target className="w-3.5 h-3.5 text-amber-400" />}
            label={pendingSample ? 'Armierung aufheben' : 'Für Drop-Zone armieren'}
            hint="Touch"
            onClick={handleArm}
          />

          <MenuItem
            icon={<Send className="w-3.5 h-3.5 text-cyan-400" />}
            label="Send to Track"
            disabled={!canSendToTrack}
            hint={canSendToTrack ? undefined : 'kein Audio-URL'}
            arrow={<ArrowRight className="w-3 h-3" />}
            active={submenu === 'track'}
            onClick={() => openSub('track')}
          />

          <MenuItem
            icon={<FolderInput className="w-3.5 h-3.5 text-emerald-400" />}
            label="Take over in Plugin"
            disabled={!canPlugin || openPluginTargets.length === 0}
            hint={openPluginTargets.length === 0 ? 'kein offenes Ziel' : undefined}
            arrow={<ArrowRight className="w-3 h-3" />}
            active={submenu === 'plugin'}
            onClick={() => openSub('plugin')}
          />

          <MenuItem
            icon={<Lock className="w-3.5 h-3.5 text-lime-400" />}
            label="An SpatialMONK übernehmen"
            disabled={!canSpatial}
            hint={!spatialOpen ? 'spatialMONK offen?' : !canSpatial ? 'kein Audioziel' : undefined}
            arrow={<ArrowRight className="w-3 h-3" />}
            active={submenu === 'spatial'}
            onClick={() => openSub('spatial')}
          />
        </div>

        {/* Submenu: Track */}
        {submenu === 'track' && (
          <div className="border-t border-white/5 p-1 max-h-56 overflow-y-auto">
            {ALL_TRACKS.map((t) => {
              const shared = trackAssignments[t];
              const localUrl = audioEngine.isTrackLoaded(t) ? audioEngine.getTrackSampleUrl(t) : null;
              const occName = shared?.name ?? (localUrl ? (localUrl.length > 40 ? localUrl.slice(0, 40) + '…' : localUrl) : null);
              const allowed = audioEngine.canLoadTrack(t);
              return (
                <MenuItem
                  key={t}
                  label={`CH ${t.replace('channel', '')} · ${trackNames[t]}`}
                  sub={occName ? `belegt: ${occName}` : allowed ? 'frei' : 'nur DJ / Freigabe'}
                  disabled={!!occName || !allowed}
                  onClick={() => handleTrack(t)}
                />
              );
            })}
          </div>
        )}

        {/* Submenu: Plugin */}
        {submenu === 'plugin' && (
          <div className="border-t border-white/5 p-1">
            {openPluginTargets.map((p) => (
              <MenuItem
                key={p.id}
                label={p.label}
                sub={p.hint}
                onClick={() => handlePlugin(p.id)}
              />
            ))}
          </div>
        )}

        {/* Submenu: Spatial */}
        {submenu === 'spatial' && (
          <div className="border-t border-white/5 p-1 max-h-56 overflow-y-auto">
            {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => {
              const occ = spatialAssignments[n];
              return (
                <MenuItem
                  key={n}
                  label={`Spatial-Kanal ${n}`}
                  sub={occ ? `belegt: ${occ.name}` : 'frei'}
                  disabled={!!occ}
                  onClick={() => handleSpatial(n)}
                />
              );
            })}
          </div>
        )}
      </div>

      {notice && <NoticeToast notice={notice} onDismiss={dismissNotice} />}
    </>
  );
};

function MenuItem({ icon, label, sub, hint, arrow, active, disabled, onClick }: {
  icon?: React.ReactNode;
  label: string;
  sub?: string;
  hint?: string;
  arrow?: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick?.();
      }}
      className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[11px] font-semibold tracking-wide transition-colors ${
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : active
            ? 'bg-cyan-400/10 text-cyan-200 cursor-pointer'
            : 'hover:bg-white/5 cursor-pointer'
      }`}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {sub && <span className="text-[9px] font-mono text-neutral-500 truncate max-w-[110px]">{sub}</span>}
      {hint && <span className="text-[9px] font-mono text-neutral-600">{hint}</span>}
      {arrow}
    </button>
  );
}

function NoticeToast({ notice, onDismiss }: {
  notice: { id: number; text: string; tone: 'info' | 'warn' | 'error' };
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3200);
    return () => clearTimeout(t);
  }, [notice.id, onDismiss]);
  return (
    <div
      role="status"
      className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[110] px-4 py-2 rounded-full border bg-black/90 backdrop-blur text-[10px] font-mono tracking-widest"
      style={{
        borderColor: notice.tone === 'warn' ? 'rgba(251,191,36,0.5)' : notice.tone === 'error' ? 'rgba(248,113,113,0.5)' : 'rgba(34,211,238,0.5)',
        color: notice.tone === 'warn' ? '#fbbf24' : notice.tone === 'error' ? '#f87171' : '#67e8f9',
      }}
    >
      {notice.text}
      <button type="button" onClick={onDismiss} className="ml-3 text-neutral-400 hover:text-white" aria-label="Hinweis schließen">✕</button>
    </div>
  );
}
