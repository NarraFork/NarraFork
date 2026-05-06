/**
 * Serial queue for fetching Codex credential usage.
 *
 * Processes one credential at a time to avoid QPS spikes when bulk-importing.
 * Queue state is exposed via the codex status API so the admin UI can show progress.
 */

import { generateShortId } from "./id";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageQueueItem {
	id: string;
	credentialId: string;
	status: "pending" | "processing" | "done" | "failed";
	error?: string;
	addedAt: number;
	startedAt?: number;
	finishedAt?: number;
}

export interface UsageQueueSnapshot {
	items: UsageQueueItem[];
	isRunning: boolean;
}

type Executor = (credentialId: string) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Delay between consecutive tasks (ms). */
const INTER_TASK_DELAY = 500;

/** How long to keep completed/failed items before auto-cleanup (ms). */
const COMPLETED_TTL = 60_000;

// ---------------------------------------------------------------------------
// Queue singleton
// ---------------------------------------------------------------------------

const items: UsageQueueItem[] = [];
let running = false;
let executor: Executor | null = null;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

function getSnapshot(): UsageQueueSnapshot {
	return { items: [...items], isRunning: running };
}

function safeProcessNext() {
	processNext().catch((err) => {
		logger.error("codex-usage-queue: unexpected error in processNext", {
			error: err instanceof Error ? err.message : String(err),
		});
		running = false;
	});
}

function scheduleCleanup() {
	if (cleanupTimer) return;
	cleanupTimer = setTimeout(() => {
		cleanupTimer = null;
		const now = Date.now();
		const before = items.length;
		for (let i = items.length - 1; i >= 0; i--) {
			const it = items[i];
			if (
				(it.status === "done" || it.status === "failed") &&
				it.finishedAt &&
				now - it.finishedAt > COMPLETED_TTL
			) {
				items.splice(i, 1);
			}
		}
		if (items.length !== before) {
			// Items were cleaned up — no broadcast needed, next status poll will pick it up
		}
		if (items.some((it) => it.status === "done" || it.status === "failed")) {
			scheduleCleanup();
		}
	}, COMPLETED_TTL);
}

async function processNext() {
	const next = items.find((it) => it.status === "pending");
	if (!next) {
		running = false;
		return;
	}

	if (!executor) {
		logger.warn("codex-usage-queue: no executor registered, skipping");
		running = false;
		return;
	}

	running = true;
	next.status = "processing";
	next.startedAt = Date.now();

	try {
		await executor(next.credentialId);
		next.status = "done";
	} catch (err) {
		next.status = "failed";
		next.error = err instanceof Error ? err.message : String(err);
		logger.warn(`codex-usage-queue: failed for ${next.credentialId}: ${next.error}`);
	}

	next.finishedAt = Date.now();
	scheduleCleanup();

	// Small delay before processing next item to smooth out QPS
	await new Promise((r) => setTimeout(r, INTER_TASK_DELAY));
	safeProcessNext();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const codexUsageQueue = {
	/** Register the function that actually fetches usage for a credential. */
	setExecutor(fn: Executor) {
		executor = fn;
	},

	/** Add a single credential to the queue. */
	enqueue(credentialId: string) {
		// Skip if already queued (pending or processing)
		if (
			items.some(
				(it) =>
					it.credentialId === credentialId &&
					(it.status === "pending" || it.status === "processing"),
			)
		) {
			return;
		}

		items.push({
			id: generateShortId(),
			credentialId,
			status: "pending",
			addedAt: Date.now(),
		});
		if (!running) {
			safeProcessNext();
		}
	},

	/** Add multiple credentials to the queue at once. */
	enqueueMany(credentialIds: string[]) {
		const pendingSet = new Set(
			items
				.filter((it) => it.status === "pending" || it.status === "processing")
				.map((it) => it.credentialId),
		);

		let enqueued = 0;
		for (const cid of credentialIds) {
			if (pendingSet.has(cid)) continue;
			items.push({
				id: generateShortId(),
				credentialId: cid,
				status: "pending",
				addedAt: Date.now(),
			});
			pendingSet.add(cid);
			enqueued++;
		}
		if (enqueued > 0 && !running) {
			safeProcessNext();
		}
	},

	/** Return a snapshot of the current queue state. */
	getSnapshot,

	/** Remove all completed / failed items from the queue. */
	clearCompleted() {
		for (let i = items.length - 1; i >= 0; i--) {
			if (items[i].status === "done" || items[i].status === "failed") {
				items.splice(i, 1);
			}
		}
	},
};
