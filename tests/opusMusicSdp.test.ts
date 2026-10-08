/**
 * RT-AUDIT-P1-013 · Master-Out in Stereo und Musik-Bitrate
 * ========================================================
 * Ohne Angaben verhandeln Browser Opus als Sprach-Codec (mono, niedrige
 * Bitrate). SFU-Producer bekommen deshalb `codecOptions`, P2P-Beschreibungen
 * eine angepasste Opus-fmtp-Zeile.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MUSIC_OPUS_CODEC_OPTIONS, preferMusicOpus, withMusicOpus } from '../src/core/transport/opusMusicSdp';

/** Gekürztes, realistisches Chrome-Offer (Audio + Video, CRLF). */
const CHROME_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
  '',
].join('\r\n');

function fmtpOf(sdp: string, pt: string): Record<string, string> {
  const line = sdp.split(/\r?\n/).find((l) => l.startsWith(`a=fmtp:${pt} `));
  if (!line) return {};
  return Object.fromEntries(line.slice(`a=fmtp:${pt} `.length).split(';').map((p) => p.split('=') as [string, string]));
}

describe('RT-AUDIT-P1-013 · preferMusicOpus', () => {
  it('setzt Stereo, Bitrate, FEC und DTX aus – bestehende Parameter bleiben', () => {
    const out = preferMusicOpus(CHROME_OFFER);
    expect(fmtpOf(out, '111')).toEqual({
      minptime: '10', useinbandfec: '1', stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '256000', usedtx: '0',
    });
  });

  it('ändert andere Codecs (RED, G722, VP8) nicht und behält CRLF-Zeilenenden', () => {
    const out = preferMusicOpus(CHROME_OFFER);
    expect(fmtpOf(out, '63')).toEqual({ '111/111': undefined as unknown as string });
    expect(out).toContain('a=rtpmap:96 VP8/90000');
    expect(out.split('\r\n').length).toBe(CHROME_OFFER.split('\r\n').length);
  });

  it('ergänzt eine fehlende fmtp-Zeile direkt hinter der Opus-rtpmap', () => {
    const sdp = 'm=audio 9 UDP/TLS/RTP/SAVPF 109\na=rtpmap:109 opus/48000/2\na=sendrecv\n';
    const lines = preferMusicOpus(sdp).split('\n');
    expect(lines[1]).toBe('a=rtpmap:109 opus/48000/2');
    expect(lines[2]).toMatch(/^a=fmtp:109 .*stereo=1/);
  });

  it('ist idempotent und überschreibt widersprüchliche Werte (stereo=0 → 1)', () => {
    const once = preferMusicOpus(CHROME_OFFER.replace('useinbandfec=1', 'useinbandfec=1;stereo=0'));
    expect(preferMusicOpus(once)).toBe(once);
    expect(fmtpOf(once, '111').stereo).toBe('1');
  });

  it('withMusicOpus lässt Typ erhalten und ignoriert Beschreibungen ohne SDP', () => {
    expect(withMusicOpus({ type: 'offer', sdp: CHROME_OFFER }).type).toBe('offer');
    const empty = { type: 'rollback' as const };
    expect(withMusicOpus(empty)).toBe(empty);
  });
});

describe('RT-AUDIT-P1-013 · SFU-Producer', () => {
  it('Musik-Spur produziert mit Stereo-/Bitrate-Optionen, Sprach-Spur ohne', async () => {
    const { MediasoupTransport } = await import('../src/core/transport/MediasoupTransport');
    const t = new MediasoupTransport() as unknown as {
      sendTransport: { produce: ReturnType<typeof vi.fn> };
      sendAudioTrack(track: unknown, kind?: 'music' | 'voice'): Promise<void>;
    };
    const produce = vi.fn(async (_opts: unknown) => ({ id: `p${produce.mock.calls.length}` }));
    t.sendTransport = { produce };
    await t.sendAudioTrack({ id: 'main' });
    await t.sendAudioTrack({ id: 'mic' }, 'voice');
    expect(produce.mock.calls[0][0]).toEqual({ track: { id: 'main' }, codecOptions: { ...MUSIC_OPUS_CODEC_OPTIONS } });
    expect(produce.mock.calls[1][0]).toEqual({ track: { id: 'mic' } });
    expect(MUSIC_OPUS_CODEC_OPTIONS).toMatchObject({ opusStereo: true, opusMaxAverageBitrate: 256000, opusDtx: false });
  });

  it('Mikrofon-Spuren im WebRTCManager laufen als "voice", Main-Spuren als "music"', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/utils/WebRTCManager.ts'), 'utf8');
    expect(src.match(/sendAudioTrack\(track, 'voice'\)/g)?.length).toBe(2);
    expect(src.match(/sendAudioTrack\(track, 'music'\)/g)?.length).toBe(2);
    expect(src.match(/withMusicOpus\(/g)?.length).toBe(6);
  });
});
