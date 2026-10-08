/**
 * audioMONASTRY · Opus für Musik statt Sprache (RT-AUDIT-P1-013)
 * =============================================================
 * Browser verhandeln Opus ohne weitere Angaben als Sprach-Codec: mono und mit
 * niedriger Ziel-Bitrate. Für den Master-Out (fertiger Mix) ist das falsch.
 *
 * Chrome sendet nur dann Stereo, wenn die GEGENSEITE in ihrer Beschreibung
 * `stereo=1` signalisiert; die Bitrate folgt `maxaveragebitrate`. Deshalb wird
 * jede Beschreibung (lokal UND entfernt) über `preferMusicOpus` gezogen, bevor
 * sie gesetzt bzw. verschickt wird. Reine Funktionen, ohne Browser-API.
 */

/** mediasoup-client `codecOptions` für Musik-Spuren (Master-Out). */
export const MUSIC_OPUS_CODEC_OPTIONS = {
  opusStereo: true,
  opusFec: true,
  opusDtx: false,
  opusMaxAverageBitrate: 256_000,
  /** 10-ms-Frames: halbe Paketierungslatenz gegenüber dem Default (20 ms). */
  opusPtime: 10,
} as const;

/** fmtp-Parameter, die für Musik gesetzt (bzw. überschrieben) werden. */
export const MUSIC_OPUS_FMTP: Readonly<Record<string, string>> = {
  stereo: '1',
  'sprop-stereo': '1',
  maxaveragebitrate: String(MUSIC_OPUS_CODEC_OPTIONS.opusMaxAverageBitrate),
  useinbandfec: '1',
  usedtx: '0',
};

/** Payload-Typen aller Opus-Codecs (`a=rtpmap:<pt> opus/48000/2`). */
function opusPayloadTypes(sdp: string): string[] {
  const pts: string[] = [];
  const re = /^a=rtpmap:(\d+) opus\/48000(?:\/\d+)?\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sdp)) !== null) pts.push(m[1]);
  return pts;
}

/** Setzt/überschreibt Parameter in einer fmtp-Parameterliste (`a=b;c=d`). */
function mergeFmtpParams(existing: string, wanted: Readonly<Record<string, string>>): string {
  const order: string[] = [];
  const values = new Map<string, string>();
  for (const part of existing.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const key = (eq >= 0 ? trimmed.slice(0, eq) : trimmed).trim();
    const value = eq >= 0 ? trimmed.slice(eq + 1).trim() : '';
    if (!values.has(key)) order.push(key);
    values.set(key, value);
  }
  for (const [key, value] of Object.entries(wanted)) {
    if (!values.has(key)) order.push(key);
    values.set(key, value);
  }
  return order.map((k) => (values.get(k) === '' ? k : `${k}=${values.get(k)}`)).join(';');
}

/**
 * Liefert die SDP mit Musik-Opus-Parametern für JEDEN Opus-Payload-Typ.
 * Fehlt eine fmtp-Zeile, wird sie direkt hinter der rtpmap-Zeile ergänzt.
 * Idempotent; andere Codecs, Zeilen und Zeilenenden bleiben unverändert.
 */
export function preferMusicOpus(sdp: string, wanted: Readonly<Record<string, string>> = MUSIC_OPUS_FMTP): string {
  if (!sdp) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  let lines = sdp.split(/\r?\n/);
  for (const pt of opusPayloadTypes(sdp)) {
    const fmtpIdx = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
    if (fmtpIdx >= 0) {
      const params = lines[fmtpIdx].slice(`a=fmtp:${pt} `.length);
      lines[fmtpIdx] = `a=fmtp:${pt} ${mergeFmtpParams(params, wanted)}`;
    } else {
      const rtpIdx = lines.findIndex((l) => new RegExp(`^a=rtpmap:${pt} opus/`, 'i').test(l));
      if (rtpIdx >= 0) {
        lines = [...lines.slice(0, rtpIdx + 1), `a=fmtp:${pt} ${mergeFmtpParams('', wanted)}`, ...lines.slice(rtpIdx + 1)];
      }
    }
  }
  return lines.join(eol);
}

/** Gleiche Beschreibung, nur mit Musik-Opus-SDP (für set*Description und Versand). */
export function withMusicOpus<T extends { type?: string; sdp?: string | null }>(desc: T): T {
  if (!desc || typeof desc.sdp !== 'string') return desc;
  return { ...desc, sdp: preferMusicOpus(desc.sdp) };
}
