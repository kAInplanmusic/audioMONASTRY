import { useCallback, useEffect, useRef, useState } from 'react';
import { webRTCManager } from '../utils/WebRTCManager';

export interface TakeoverAsk {
  requestId: string;
  pluginId: string;
  fromUserId: string;
  toUserId: string;
  deadline: number;
}

export interface TakeoverNotice {
  id: string;
  text: string;
  tone: 'info' | 'error';
}

/** Countdown value for the UI; never negative, never invented. */
export function remainingSeconds(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export const TAKEOVER_TIMEOUT_MS = 5000;

/**
 * R17 client side. The server owns the deadline and the lock; this hook only sends
 * requests and renders what the server reports. Nothing here transfers a lock locally.
 */
export function usePluginTakeover(input: { userId: string }) {
  const { userId } = input;
  const [ask, setAsk] = useState<TakeoverAsk | null>(null);
  const [outgoing, setOutgoing] = useState<{ pluginId: string; deadline: number } | null>(null);
  const [notices, setNotices] = useState<TakeoverNotice[]>([]);
  const [taken, setTaken] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const askRef = useRef<TakeoverAsk | null>(null);
  useEffect(() => { askRef.current = ask; }, [ask]);

  const notify = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setNotices(prev => [...prev.slice(-3), { id, text, tone }]);
    window.setTimeout(() => setNotices(prev => prev.filter(n => n.id !== id)), 6000);
  }, []);

  useEffect(() => {
    const offAsk = webRTCManager.onTakeoverAsk((msg: TakeoverAsk & { type?: string }) => {
      if (!msg || typeof msg.requestId !== 'string') return;
      const next: TakeoverAsk = { requestId: msg.requestId, pluginId: String(msg.pluginId), fromUserId: String(msg.fromUserId), toUserId: String(msg.toUserId), deadline: Number(msg.deadline) };
      if (next.toUserId === userId) setOutgoing({ pluginId: next.pluginId, deadline: next.deadline });
      if (next.fromUserId === userId) setAsk(next);
    });
    const offResult = webRTCManager.onTakeoverResult((msg: any) => {
      const plugin = String(msg?.pluginId ?? '');
      const outcome = String(msg?.outcome ?? '');
      if (msg?.toUserId === userId) {
        setOutgoing(null);
        if (outcome === 'accepted' || outcome === 'timeout' || outcome === 'holder-offline') {
          setTaken(prev => (prev.includes(plugin) ? prev : [...prev, plugin]));
          notify(`Du hast ${plugin}MONK übernommen (${outcome}).`);
        } else if (outcome === 'denied') notify(`${plugin}MONK: Übernahme abgelehnt.`, 'error');
      }
      if (msg?.fromUserId === userId && (outcome === 'accepted' || outcome === 'timeout' || outcome === 'holder-offline')) {
        setAsk(null);
        notify(`${plugin}MONK wurde vom DJ übernommen.`);
      }
      if (msg?.fromUserId === userId && (outcome === 'returned' || outcome === 'released')) {
        setTaken(prev => prev.filter(id => id !== plugin));
      }
    });
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => { offAsk(); offResult(); window.clearInterval(timer); };
  }, [userId, notify]);

  const request = useCallback(async (pluginId: string) => {
    try {
      const reply = await webRTCManager.requestTakeover(pluginId);
      if (reply?.outcome === 'pending') {
        setOutgoing({ pluginId, deadline: Number(reply.deadline) });
        notify(`Anfrage an den Halter von ${pluginId}MONK gesendet.`);
      } else if (reply?.outcome === 'holder-offline') {
        setTaken(prev => (prev.includes(pluginId) ? prev : [...prev, pluginId]));
        notify(`${pluginId}MONK übernommen (Halter war nicht verbunden).`);
      } else {
        notify(`${pluginId}MONK: ${reply?.reason ?? 'Anfrage abgelehnt'}.`, 'error');
      }
      return reply;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Anfrage fehlgeschlagen', 'error');
      return null;
    }
  }, [notify]);

  const answer = useCallback(async (accept: boolean) => {
    const current = askRef.current;
    if (!current) return null;
    setAsk(null);
    const reply = await webRTCManager.answerTakeover(current.requestId, accept);
    if (!reply?.ok) notify(`Antwort nicht angenommen (${reply?.reason ?? 'Fehler'}).`, 'error');
    return reply;
  }, [notify]);

  const giveBack = useCallback(async (pluginId: string) => {
    const reply = await webRTCManager.returnTakeover(pluginId);
    if (reply?.ok) { setTaken(prev => prev.filter(id => id !== pluginId)); notify(`${pluginId}MONK zurückgegeben.`); }
    else notify(`${pluginId}MONK: Rückgabe fehlgeschlagen (${reply?.reason ?? 'Fehler'}).`, 'error');
    return reply;
  }, [notify]);

  return {
    ask,
    outgoing,
    notices,
    taken,
    secondsLeft: ask ? remainingSeconds(ask.deadline, now) : outgoing ? remainingSeconds(outgoing.deadline, now) : 0,
    request, answer, giveBack,
  };
}
