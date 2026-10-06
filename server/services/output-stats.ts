/**
 * Global AI output character rate tracker.
 *
 * Records every streaming chunk size and computes a 3-second sliding-window
 * average (chars/sec). Broadcasts the rate to subscribed WS clients every second.
 */

import { hotSafe } from "../lib/hot-safe";
import { getNarratorConnections } from "../websocket/narrator-ws";

// --- Sliding window ---

interface ChunkRecord {
	chars: number;
	ts: number;
}

const WINDOW_MS = 3000;
const BROADCAST_INTERVAL_MS = 1000;

/** Ring buffer of recent chunk records */
const chunks: ChunkRecord[] = [];

/** Total chars accumulated since server start */
let totalChars = 0;

/** Number of WS clients subscribed to stats */
let subscriberCount = 0;

// Timer key for hotTimer / hotTimerClear.
const TIMER_KEY = "narrafork.outputStatsBroadcastTimer";

// Survive Bun --hot reloads: reuse the existing timer reference holder.
const _timerHolder = hotSafe<{ ref: ReturnType<typeof setInterval> | null }>(TIMER_KEY, () => ({
	ref: null,
}));

/** Record an incoming AI output chunk. */
export function recordOutputChunk(charCount: number): void {
	if (charCount <= 0) return;
	totalChars += charCount;
	chunks.push({ chars: charCount, ts: Date.now() });
	// Prevent unbounded growth when no subscribers are pruning via computeRate().
	// At ~100 chunks/sec streaming, 10 000 entries ≈ 100 seconds of history — well
	// beyond the 3-second window, so we only prune when clearly oversized.
	if (chunks.length > 10_000) {
		const cutoff = Date.now() - WINDOW_MS;
		while (chunks.length > 0 && chunks[0].ts < cutoff) {
			chunks.shift();
		}
	}
}

/** Prune entries older than the window and compute chars/sec. */
function computeRate(): number {
	const cutoff = Date.now() - WINDOW_MS;
	// Remove stale entries from the front
	while (chunks.length > 0 && chunks[0].ts < cutoff) {
		chunks.shift();
	}
	if (chunks.length === 0) return 0;
	let sum = 0;
	for (const c of chunks) sum += c.chars;
	return Math.round((sum / (WINDOW_MS / 1000)) * 10) / 10;
}

/** Broadcast current stats to all subscribed WS clients. */
function broadcastStats(): void {
	if (subscriberCount === 0) return;

	const rate = computeRate();
	const payload = JSON.stringify({
		type: "output_stats",
		charsPerSec: rate,
		totalChars,
	});

	for (const ws of getNarratorConnections()) {
		if (!(ws.data as { subscribedStats?: boolean }).subscribedStats) continue;
		try {
			ws.send(payload);
		} catch {
			// dead connection — will be cleaned up by heartbeat
		}
	}
}

function ensureTimer(): void {
	if (_timerHolder.ref) return;
	_timerHolder.ref = setInterval(broadcastStats, BROADCAST_INTERVAL_MS);
}

function maybeStopTimer(): void {
	if (subscriberCount > 0 || !_timerHolder.ref) return;
	clearInterval(_timerHolder.ref);
	_timerHolder.ref = null;
}

/** Called when a WS client subscribes to output stats. */
export function addStatsSubscriber(): void {
	subscriberCount++;
	ensureTimer();
}

/** Called when a WS client unsubscribes (or disconnects). */
export function removeStatsSubscriber(): void {
	subscriberCount = Math.max(0, subscriberCount - 1);
	maybeStopTimer();
}
