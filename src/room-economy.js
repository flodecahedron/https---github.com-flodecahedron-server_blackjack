import crypto from "node:crypto";

/**
 * Records every balance mutation produced by a room while keeping gameplay
 * synchronous. The persistence layer later commits these events atomically.
 */
export class RoomEconomy {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.roomInstanceId = crypto.randomUUID();
    this.pending = [];
  }

  change(profile, delta, reason, roundId = null) {
    if (!Number.isInteger(delta)) throw Error("Chip balance changes must be integer values");
    if (delta === 0) return;
    const nextBalance = profile.balance + delta;
    if (nextBalance < 0) throw Error(`${profile.username} cannot cover this payment`);
    profile.balance = nextBalance;
    this.pending.push({
      id: `${this.roomInstanceId}:${crypto.randomUUID()}`,
      playerId: profile.id,
      delta,
      reason,
      roomCode: this.roomCode,
      roundId,
    });
  }

  pendingEvents() {
    return [...this.pending];
  }

  acknowledge(eventIds) {
    const acknowledged = new Set(eventIds);
    this.pending = this.pending.filter(event => !acknowledged.has(event.id));
  }
}
