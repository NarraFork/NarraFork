/**
 * Server-side storage scan job.
 *
 * The scan is decoupled from the HTTP connection that triggered it: an admin can
 * navigate away (or close the tab) mid-scan and the scan keeps running to
 * completion, writing its result into the shared cache. Clients observe progress
 * by polling `getStorageScanJob()` instead of owning the scan through an SSE
 * stream — the old SSE route aborted the whole scan on client disconnect, which
 * made the scan impossible to background.
 *
 * Dedupe: there is exactly one job slot. `startStorageScan()` while a scan is
 * already running returns the existing job instead of stacking a second scan on
 * the worker pool.
 */

import { logger } from "../lib/logger";
import {
	type StorageCategoryResult,
	StorageScanAbortedError,
	type StorageScanResult,
	scanStorage,
} from "./storage-service";

export type StorageScanJobStatus = "idle" | "running" | "complete" | "error" | "cancelled";

export interface StorageScanJobState {
	status: StorageScanJobStatus;
	progressMessage: string | null;
	progressDetail: { done: number; total: number } | null;
	/** Categories reported so far, so a late-joining poller sees partial results. */
	categories: StorageCategoryResult[];
	result: StorageScanResult | null;
	error: string | null;
	startedAt: number | null;
	finishedAt: number | null;
}

const idleState = (): StorageScanJobState => ({
	status: "idle",
	progressMessage: null,
	progressDetail: null,
	categories: [],
	result: null,
	error: null,
	startedAt: null,
	finishedAt: null,
});

let state: StorageScanJobState = idleState();
let abortController: AbortController | null = null;

export function getStorageScanJob(): StorageScanJobState {
	return state;
}

/**
 * Start a scan, or return the in-flight one. `started` tells the caller whether
 * this call initiated the scan (false means another caller — possibly another
 * admin, possibly this page before a remount — already started it).
 */
export function startStorageScan(): { started: boolean; state: StorageScanJobState } {
	// A job whose abort has already been requested does NOT hold the slot: it is on
	// its way out and will only write a `cancelled` state. Treating it as in-flight
	// made "Cancel, then Rescan" silently no-op — the second call was deduped onto the
	// dying job, so the user had to click Rescan twice. The outgoing scan cannot
	// clobber the new state either: `runScan`'s terminal writes are guarded by
	// `abortController === controller`, which the reassignment below invalidates.
	if (state.status === "running" && abortController && !abortController.signal.aborted) {
		return { started: false, state };
	}

	state = { ...idleState(), status: "running", startedAt: Date.now() };
	const controller = new AbortController();
	abortController = controller;

	void runScan(controller);

	return { started: true, state };
}

async function runScan(controller: AbortController): Promise<void> {
	/**
	 * Does this run still own the job slot?
	 *
	 * A cancelled scan keeps running until its next checkpoint, and `startStorageScan`
	 * deliberately hands the slot to a replacement rather than waiting for it. So an
	 * outgoing run can reach a state write AFTER the new run has published its own —
	 * and without this check it would overwrite the new `running` state with its own
	 * `cancelled`/progress, making a freshly started scan look cancelled while it is
	 * in fact still scanning. The controller identity is the slot's owner token.
	 */
	const ownsSlot = () => abortController === controller;
	try {
		const gen = scanStorage({ signal: controller.signal });
		for (;;) {
			const { value, done } = await gen.next();
			if (!ownsSlot()) return;
			if (done) {
				state = {
					...state,
					status: "complete",
					result: value,
					progressMessage: null,
					progressDetail: null,
					finishedAt: Date.now(),
				};
				return;
			}
			if (value.type === "progress") {
				state = {
					...state,
					progressMessage: value.message,
					progressDetail: value.detail ?? null,
				};
			} else {
				const categories = [...state.categories];
				const idx = categories.findIndex((c) => c.key === value.data.key);
				if (idx >= 0) categories[idx] = value.data;
				else categories.push(value.data);
				state = { ...state, categories };
			}
		}
	} catch (err) {
		const aborted = controller.signal.aborted || err instanceof StorageScanAbortedError;
		if (!aborted) {
			logger.error("Background storage scan failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		// Logged above regardless, but only PUBLISHED while this run owns the slot.
		if (!ownsSlot()) return;
		state = {
			...state,
			status: aborted ? "cancelled" : "error",
			error: aborted ? null : err instanceof Error ? err.message : String(err),
			progressMessage: null,
			progressDetail: null,
			finishedAt: Date.now(),
		};
	} finally {
		if (abortController === controller) {
			abortController = null;
		}
	}
}

/**
 * How long `cancelStorageScan` waits for the abort to actually land.
 *
 * `abort()` only sets a flag; the scan notices it at its next checkpoint (between
 * steps), so the state is still `running` when abort() returns. Returning that
 * state told the client "still running" for a cancel it had just performed, and —
 * worse — an immediate Rescan hit the `running && abortController` dedupe and was
 * refused, so the button appeared to do nothing until the user clicked twice.
 *
 * Short, because it blocks the response: a checkpoint is one scan step away, and if
 * a step is slow the loop below gives up and returns the still-running state rather
 * than holding the request open. `startStorageScan` no longer depends on this
 * anyway (see its `signal.aborted` check), so a timeout costs only a stale status.
 */
const CANCEL_SETTLE_TIMEOUT_MS = 1500;
const CANCEL_SETTLE_POLL_MS = 25;

export async function cancelStorageScan(): Promise<StorageScanJobState> {
	if (state.status !== "running" || !abortController) return state;
	abortController.abort();
	const deadline = Date.now() + CANCEL_SETTLE_TIMEOUT_MS;
	// Wait for the scan loop to observe the abort and write its terminal state, so the
	// client is told what actually happened instead of a status it just invalidated.
	while (state.status === "running" && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_POLL_MS));
	}
	return state;
}
