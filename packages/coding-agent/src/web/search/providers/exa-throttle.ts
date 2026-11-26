/**
 * Cross-thread Exa search request slot reservation.
 *
 * Kept dependency-free so `thread/services/exa-throttle.ts` can bridge main and
 * subagent workers at startup without pulling the Exa provider module off its
 * lazy-load boundary.
 */

const MAX_EXA_THROTTLE_BUCKETS = 256;

export interface ExaSlotReservation {
	readonly id: number;
	readonly waitMs: number;
}

export interface ExaThrottleCoordinator {
	reserve(limitKey: string, delayMs: number): ExaSlotReservation | Promise<ExaSlotReservation>;
	release(limitKey: string, id: number): void;
}

interface ExaThrottleBucket {
	lastAt: number;
	nextAt: number;
	latestId: number;
	prevLastAt: number;
	prevNextAt: number;
}

const buckets = new Map<string, ExaThrottleBucket>();
let nextReservationId = 0;
let coordinator: ExaThrottleCoordinator | undefined;

function getOrCreateBucket(limitKey: string): ExaThrottleBucket {
	const existing = buckets.get(limitKey);
	if (existing) {
		// Refresh insertion order so LRU eviction keeps recently used accounts.
		buckets.delete(limitKey);
		buckets.set(limitKey, existing);
		return existing;
	}
	while (buckets.size >= MAX_EXA_THROTTLE_BUCKETS) {
		const oldest = buckets.keys().next().value;
		if (oldest === undefined) break;
		buckets.delete(oldest);
	}
	const created: ExaThrottleBucket = {
		lastAt: -Infinity,
		nextAt: 0,
		latestId: 0,
		prevLastAt: -Infinity,
		prevNextAt: 0,
	};
	buckets.set(limitKey, created);
	return created;
}

/**
 * Reserve the next allowed send time for `limitKey` using `delayMs` as the caller's
 * minimum spacing since the account's last reserved send. Recent send times stay
 * cached up to the LRU cap so another account's traffic cannot erase them.
 */
export function reserveExaSearchSlot(limitKey: string, delayMs: number): ExaSlotReservation {
	const bucket = getOrCreateBucket(limitKey);
	const now = Date.now();
	const sendAt = Math.max(now, bucket.nextAt, bucket.lastAt + delayMs);
	const id = ++nextReservationId;
	bucket.prevLastAt = bucket.lastAt;
	bucket.prevNextAt = bucket.nextAt;
	bucket.latestId = id;
	bucket.lastAt = sendAt;
	bucket.nextAt = Math.max(bucket.nextAt, sendAt + delayMs);
	return { id, waitMs: sendAt - now };
}

/** Undo the latest reservation for `limitKey` when the caller aborts before sending. */
export function releaseExaSearchSlot(limitKey: string, id: number): void {
	const bucket = buckets.get(limitKey);
	if (!bucket || bucket.latestId !== id) return;
	bucket.lastAt = bucket.prevLastAt;
	bucket.nextAt = bucket.prevNextAt;
	bucket.latestId = 0;
}

/** Install a worker-side coordinator that forwards slot reservations to main. */
export function setExaThrottleCoordinator(next: ExaThrottleCoordinator | undefined): void {
	coordinator = next;
}

/** Reserve an Exa request slot via the active coordinator (main over RPC in workers, local on main). */
export async function reserveExaSlot(limitKey: string, delayMs: number): Promise<ExaSlotReservation> {
	if (coordinator) return await coordinator.reserve(limitKey, delayMs);
	return reserveExaSearchSlot(limitKey, delayMs);
}

/** Release an unused Exa request slot via the active coordinator. */
export function releaseExaSlot(limitKey: string, id: number): void {
	if (coordinator) {
		coordinator.release(limitKey, id);
		return;
	}
	releaseExaSearchSlot(limitKey, id);
}

/** Reset Exa request pacing state for isolated provider tests. */
export function resetExaSearchThrottleForTest(): void {
	buckets.clear();
	nextReservationId = 0;
}
