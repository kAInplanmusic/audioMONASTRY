/**
 * Wer ist in der Session – mit fester Nummer und Farbe (Design: Nutzer 1–4)
 * =======================================================================
 * Jedes Gerät muss für denselben Menschen dieselbe Nummer und Farbe zeigen
 * (gleiche Kopie für alle). Deshalb wird nicht nach Beitritt, sondern nach der
 * Kennung sortiert: alle Clients kennen dieselben Kennungen und kommen so ohne
 * Absprache zum selben Ergebnis.
 */
import { useSyncExternalStore } from 'react';

export const USER_COLORS = ['#4cc9f0', '#ffb703', '#e879f9', '#a3e635'] as const;

export interface SessionPerson {
  userId: string;
  /** 1..4 */
  no: number;
  color: string;
  me: boolean;
}

interface PeopleState {
  me: string;
  people: SessionPerson[];
}

let state: PeopleState = { me: '', people: [] };
const listeners = new Set<() => void>();

export function computePeople(me: string, others: readonly string[]): SessionPerson[] {
  const ids = Array.from(new Set([me, ...others].filter(Boolean))).sort();
  return ids.slice(0, 4).map((userId, i) => ({ userId, no: i + 1, color: USER_COLORS[i], me: userId === me }));
}

/** Von der App bei jeder Session-Änderung gesetzt. */
export function setSessionPeople(me: string, others: readonly string[]): void {
  const people = computePeople(me, others);
  const same = state.me === me
    && state.people.length === people.length
    && state.people.every((p, i) => p.userId === people[i].userId);
  if (same) return;
  state = { me, people };
  listeners.forEach((l) => l());
}

export function getSessionPeople(): PeopleState {
  return state;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useSessionPeople(): PeopleState {
  return useSyncExternalStore(subscribe, getSessionPeople, getSessionPeople);
}

/** Anzeige für einen Halter: „du", „Nutzer 2" oder „frei". */
export function personLabel(userId: string | null | undefined, s: PeopleState = state): string {
  if (!userId) return 'frei';
  if (userId === s.me) return 'du';
  const p = s.people.find((x) => x.userId === userId);
  return p ? `Nutzer ${p.no}` : userId.replace(/^user-/, 'u');
}

export function personColor(userId: string | null | undefined, s: PeopleState = state): string {
  if (!userId) return '#ffffff';
  return s.people.find((x) => x.userId === userId)?.color ?? '#9aa6bb';
}
