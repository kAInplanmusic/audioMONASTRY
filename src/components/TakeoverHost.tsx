import React from 'react';
import type { TakeoverAsk, TakeoverNotice } from '../hooks/usePluginTakeover';

/**
 * R17: the holder decides inside five seconds. The countdown is driven by the server
 * deadline, so a manipulated client clock cannot stretch the window.
 */
export function TakeoverHost({ ask, secondsLeft, notices, onAnswer }: {
  ask: TakeoverAsk | null;
  secondsLeft: number;
  notices: TakeoverNotice[];
  onAnswer: (accept: boolean) => void;
}) {
  return (
    <>
      {ask && (
        <div className="am-modal-backdrop" data-takeover-modal={ask.pluginId} role="dialog" aria-modal="true" aria-label="Übernahme-Anfrage des DJ">
          <div className="am-modal" style={{ maxWidth: 420 }}>
            <h3 style={{ marginTop: 0 }}>DJ möchte {ask.pluginId}MONK übernehmen</h3>
            <p>Ohne Antwort übernimmt der DJ automatisch nach Ablauf des Countdowns.</p>
            <p className="am-big" data-takeover-countdown style={{ margin: '8px 0' }}>{secondsLeft} s</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="am-btn" data-takeover-reject onClick={() => onAnswer(false)}>Ablehnen</button>
              <button type="button" className="am-btn am-primary" data-takeover-accept onClick={() => onAnswer(true)}>Akzeptieren</button>
            </div>
          </div>
        </div>
      )}
      <div className="am-toasts" aria-live="polite" style={{ position: 'fixed', right: 16, bottom: 16, display: 'grid', gap: 6, zIndex: 60 }}>
        {notices.map(notice => (
          <div key={notice.id} className={`am-toast ${notice.tone === 'error' ? 'am-toast-error' : ''}`} data-takeover-notice role="status">
            {notice.text}
          </div>
        ))}
      </div>
    </>
  );
}
