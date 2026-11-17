/** Derive sender-context evidence from receiver RTP and the CDP user inventory.
 * The production sanitizer exports sample counters, not packet counts. A sender
 * is attributed through its signaling user ID; no outbound counter is invented.
 */
export function attestRtpContexts(rows: Record<string, any>[]) {
  const snapshots = rows.filter(r => r.type === 'raw-snapshot');
  const memberContexts = new Map<string, string>();
  for (const s of snapshots) if (s.mode === 'member') {
    if (memberContexts.has(s.userId) && memberContexts.get(s.userId) !== s.context) throw new Error('Ambiguous user/context inventory');
    memberContexts.set(s.userId, s.context);
  }
  const samples = new Map<string, number>();
  const receiverTimes: number[] = [];
  for (const s of snapshots) if (s.mode === 'master-out') {
    let delivered = false;
    for (const peer of s.peers) for (const r of peer.rows) {
      if (r.type !== 'inbound-rtp' || (r.kind ?? r.mediaType) !== 'audio' || !(r.totalSamplesReceived > 0)) continue;
      const context = memberContexts.get(peer.userId);
      if (!context) throw new Error('RTP sender absent from CDP inventory');
      samples.set(context, Math.max(samples.get(context) ?? 0, r.totalSamplesReceived)); delivered = true;
    }
    if (delivered) receiverTimes.push(Date.parse(s.pageAt));
  }
  return { contextRtpSamples: [...samples].map(([context, maxReceivedSamplesPerSsrc]) => ({ context, maxReceivedSamplesPerSsrc })),
    attribution: 'receiver inbound audio RTP attributed to sender context via signaling user ID and CDP inventory; packet counts not exported',
    packetCounts: null, trafficSeconds: receiverTimes.length > 1 ? (receiverTimes.at(-1)! - receiverTimes[0]) / 1000 : null,
    receiverSnapshotsWithRtp: receiverTimes.length };
}
