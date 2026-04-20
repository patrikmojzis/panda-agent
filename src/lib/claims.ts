/**
 * Returns true when a record currently holds an active claim lease.
 */
export function hasActiveClaim(
  value: {
    claimedAt?: number;
    claimExpiresAt?: number;
  },
  nowMs: number,
): boolean {
  return value.claimedAt !== undefined
    && value.claimExpiresAt !== undefined
    && value.claimExpiresAt > nowMs;
}
