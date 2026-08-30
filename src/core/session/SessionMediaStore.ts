/**
 * audioMONASTRY · Session-Medien-Datenbank
 * ========================================
 * Gemeinsamer Zwischenspeicher in der Session: Jeder User kann generierte
 * Audio-Medien (TTS/Gesang/Samples) ablegen, damit DJ/Plugins sie aufgreifen.
 */

export type SessionMediaKind = 'tts' | 'singing' | 'sample' | 'recording' | 'song';

export interface SessionMediaItem {
  id: string;
  userId: string;
  kind: SessionMediaKind;
  text: string;
  audioUrl: string;
  mimeType: string;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface ISessionMediaStore {
  add(item: SessionMediaItem): void;
  get(id: string): SessionMediaItem | undefined;
  listByUser(userId: string): SessionMediaItem[];
  listAll(): SessionMediaItem[];
  remove(id: string): boolean;
  clearUser(userId: string): void;
}

export class MemorySessionMediaStore implements ISessionMediaStore {
  private items = new Map<string, SessionMediaItem>();

  add(item: SessionMediaItem): void {
    if (this.items.has(item.id)) throw new Error(`Media existiert bereits: ${item.id}`);
    this.items.set(item.id, { ...item, metadata: { ...item.metadata } });
  }

  get(id: string): SessionMediaItem | undefined {
    const item = this.items.get(id);
    return item ? { ...item, metadata: { ...item.metadata } } : undefined;
  }

  listByUser(userId: string): SessionMediaItem[] {
    return this.listAll().filter((m) => m.userId === userId);
  }

  listAll(): SessionMediaItem[] {
    return [...this.items.values()].map((m) => ({ ...m, metadata: { ...m.metadata } }));
  }

  remove(id: string): boolean {
    return this.items.delete(id);
  }

  clearUser(userId: string): void {
    for (const id of [...this.items.keys()]) {
      if (this.items.get(id)?.userId === userId) this.items.delete(id);
    }
  }
}

/** Default-Instanz für die aktuelle Session (im Browser ggf. persistiert). */
export const sessionMediaStore = new MemorySessionMediaStore();
