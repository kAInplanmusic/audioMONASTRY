/**
 * F6 · Öffentliche IPv4 für Mediasoup zur Laufzeit ermitteln
 * =====================================================================
 * `SFU_ANNOUNCED_IP` war auf sfu-1 leer; im Portal-Pfad stand dort sogar die
 * PRIVATE 10.x-Adresse aus `hostname -I`. Mediasoup kündigt damit ICE-Kandidaten
 * an, die kein externer Browser erreichen kann – ohne dass es irgendwo steht.
 *
 * Geprüft wird deshalb: nur öffentliche IPv4 werden akzeptiert, die Quellen
 * werden in der Reihenfolge Umgebung → Hetzner-Metadata → Aussenprobe benutzt,
 * und ohne Ergebnis kommt ein Klartextgrund (niemals ein stiller Default) zurück.
 * `fetch` wird injiziert – kein Test kontaktiert die Metadata oder ipify.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HETZNER_METADATA_URL,
  IPIFY_URL,
  isPublicIpv4,
  parseHetznerMetadataPublicIpv4,
  resolveSfuAnnouncedIp,
} from '../server/sfuNetwork';

const textResponse = (body: string, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
}) as unknown as Response;

const METADATA_BODY = [
  'instance-id: 42',
  'public-ipv4: 49.13.65.150',
  'private-ipv4: 10.0.0.5',
].join('\n');

describe('F6: isPublicIpv4', () => {
  it('akzeptiert nur öffentliche Adressen', () => {
    expect(isPublicIpv4('49.13.65.150')).toBe(true);
    for (const bad of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.2', '172.16.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '999.1.1.1', '', 'sfu.example'] as const) {
      expect(isPublicIpv4(bad)).toBe(false);
    }
  });

  it('liest public-ipv4 aus dem Metadata-Dokument (nicht private-ipv4)', () => {
    expect(parseHetznerMetadataPublicIpv4(METADATA_BODY)).toBe('49.13.65.150');
    expect(parseHetznerMetadataPublicIpv4('private-ipv4: 10.0.0.5')).toBeNull();
    expect(parseHetznerMetadataPublicIpv4('public-ipv4: 10.0.0.5')).toBeNull();
  });
});

describe('F6: resolveSfuAnnouncedIp', () => {
  it('nimmt die Umgebungsvariable zuerst (Betreiberentscheidung, kein Netz)', async () => {
    const fetchImpl = vi.fn();
    const res = await resolveSfuAnnouncedIp({ SFU_ANNOUNCED_IP: '49.13.65.150' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toMatchObject({ announcedIp: '49.13.65.150', source: 'env' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('weist eine explizite PRIVATE Adresse ab (der Portal-Fehler aus F6)', async () => {
    const fetchImpl = vi.fn();
    const res = await resolveSfuAnnouncedIp({ SFU_ANNOUNCED_IP: '10.0.0.5' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.announcedIp).toBeNull();
    expect(res.reason).toMatch(/keine öffentliche IPv4/);
    // Kein stiller Wechsel auf eine andere Quelle: der Wert war ausdruecklich.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fragt die Hetzner-Metadata und nennt die Quelle', async () => {
    const fetchImpl = vi.fn(async (url: string) => textResponse(String(url).includes('169.254.169.254') ? METADATA_BODY : ''));
    const res = await resolveSfuAnnouncedIp({}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toMatchObject({ announcedIp: '49.13.65.150', source: 'hetzner-metadata' });
    expect(fetchImpl).toHaveBeenCalledWith(HETZNER_METADATA_URL, expect.anything());
  });

  it('fällt auf die Aussenprobe zurück, wenn die Metadata nichts liefert', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      textResponse(String(url).includes('169.254.169.254') ? 'instance-id: 1' : '49.13.65.151\n'));
    const res = await resolveSfuAnnouncedIp({}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toMatchObject({ announcedIp: '49.13.65.151', source: 'ipify' });
    expect(fetchImpl).toHaveBeenCalledWith(IPIFY_URL, expect.anything());
  });

  it('meldet Klartext, wenn keine Quelle eine öffentliche IPv4 liefert', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('kein Netz'); });
    const res = await resolveSfuAnnouncedIp({}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.announcedIp).toBeNull();
    expect(res.source).toBe('none');
    expect(res.reason).toMatch(/keine öffentliche IPv4 ermittelbar/);
    // Die versuchten Quellen stehen im Ergebnis (Diagnose statt Stille).
    expect(res.attempts.join(' ')).toMatch(/hetzner-metadata/);
    expect(res.attempts.join(' ')).toMatch(/ipify/);
  });

  it('prüft die Metadata nicht, wenn sie nicht erreichbar ist (Testabdeckung/Offline)', async () => {
    const fetchImpl = vi.fn(async () => textResponse('49.13.65.152'));
    const res = await resolveSfuAnnouncedIp({}, { fetchImpl: fetchImpl as unknown as typeof fetch, skipMetadata: true });
    expect(res).toMatchObject({ announcedIp: '49.13.65.152', source: 'ipify' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
