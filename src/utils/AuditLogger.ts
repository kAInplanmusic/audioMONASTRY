/**
 * Audit-Logger – VENDOR-/CLOUD-FREI.
 *
 * Frueher wurden Audit-Events in die Firestore-Collection `audit_log` geschrieben.
 * Jetzt werden sie nur noch in der Browser-Konsole (und optional localStorage) geloggt.
 */

import { storageGet, storageSet } from './storage';

const LOCAL_AUDIT_KEY = 'audiomonastry_audit_log';

export const logAuditEvent = async (userId: string, action: string, details: any) => {
  try {
    const entry = { userId, action, details, timestamp: new Date().toISOString() };
    console.info('[audit]', action, 'by', userId, details ?? '');
    // Optional: kurze Historie im Storage behalten
    try {
      const raw = storageGet(LOCAL_AUDIT_KEY);
      const list = raw ? JSON.parse(raw) : [];
      list.push(entry);
      storageSet(LOCAL_AUDIT_KEY, JSON.stringify(list.slice(-100)));
    } catch { /* Storage voll/blockiert – egal */ }
  } catch (e) {
    console.error('Failed to log audit event:', e);
  }
};
