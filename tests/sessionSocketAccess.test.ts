/**
 * DAW-Breaker: regressions for socket session membership, output-only modes,
 * and immediate revocation of edit privileges after leave-session.
 *
 * This intentionally tests the same pure policy functions used by realtime.ts.
 * A separate Socket.IO integration test is still required for full end-to-end proof.
 */
import { describe, expect, it } from 'vitest';
import {
  canJoinSessionSocket,
  canMutateSessionSocket,
  clearSessionSocketIdentity,
} from '../server/realtime';

const member = () => ({
  sessionRoom: 'studio-session',
  sessionUserId: 'alice',
  sessionMode: 'member',
  sessionRole: 'member',
});

describe('session mutator authorization — DAW-Breaker', () => {
  it('rejects mutation before the client has joined', () => {
    expect(canMutateSessionSocket(undefined)).toBe(false);
    expect(canMutateSessionSocket({})).toBe(false);
    expect(canMutateSessionSocket({ sessionUserId: 'alice', sessionMode: 'member' })).toBe(false);
  });

  it('allows a joined member to mutate and rejects another room', () => {
    expect(canMutateSessionSocket(member())).toBe(true);
    expect(canMutateSessionSocket({ ...member(), sessionRoom: 'other' })).toBe(false);
  });

  it.each(['master-out', 'visual-out', '', 'unknown'])(
    'does not allow output device or unknown mode %s to mutate',
    (sessionMode) => {
      expect(canMutateSessionSocket({ ...member(), sessionMode })).toBe(false);
    },
  );

  it('rejects a missing or blank identity', () => {
    expect(canMutateSessionSocket({ ...member(), sessionUserId: '' })).toBe(false);
    expect(canMutateSessionSocket({ ...member(), sessionUserId: '   ' })).toBe(false);
  });

  it('revokes ALL edit authority after leave and permits a new join', () => {
    const socketData = member();
    expect(canJoinSessionSocket(socketData)).toBe(false);
    expect(canMutateSessionSocket(socketData)).toBe(true);

    clearSessionSocketIdentity(socketData);

    expect(canMutateSessionSocket(socketData)).toBe(false);
    expect(canJoinSessionSocket(socketData)).toBe(true);
    expect(socketData).not.toHaveProperty('sessionRoom');
    expect(socketData).not.toHaveProperty('sessionUserId');
    expect(socketData).not.toHaveProperty('sessionMode');
    expect(socketData).not.toHaveProperty('sessionRole');
  });

  it('rejects repeated join while still in the session, including identity switch', () => {
    const socketData = member();
    expect(canJoinSessionSocket(socketData)).toBe(false);
    socketData.sessionUserId = 'mallory';
    expect(canJoinSessionSocket(socketData)).toBe(false);
  });
});
