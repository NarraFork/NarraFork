/**
 * Startup readiness gate.
 *
 * The server binds its port before narrator continuation recovery finishes. Recovery reads
 * persisted narrator state and may legitimately fail — for example when a narrator's model
 * points at a provider prefix that no longer exists in settings. Such a failure must stay
 * scoped to the narrators it affects: the HTTP surface (frontend bundle, settings, auth,
 * everything needed to actually fix the broken provider) has to stay reachable, otherwise the
 * user is locked out of the only UI that can repair the state.
 *
 * This module owns the small state machine behind that policy so it can be unit-tested
 * without booting Bun.serve():
 *   - `recovering` → recovery is still mounting continuations
 *   - `ready`      → recovery admitted every continuation
 *   - `failed`     → recovery threw; the reason is surfaced, but requests keep flowing
 */

export type StartupRecoveryStatus = "recovering" | "ready" | "failed";

export type StartupRecoveryState =
	| { status: "recovering" }
	| { status: "ready" }
	| { status: "failed"; error: string };

export type StartupRecoveryResult = { ok: true } | { ok: false; error: string };

/**
 * Whether ordinary (non-health) requests may be served in this state.
 *
 * Always true. A blocked HTTP surface is never the right answer to a recovery failure: the
 * frontend, auth and settings routes are exactly what the user needs to repair the state that
 * made recovery fail. Recovery failures are reported through `/api/health` and per-narrator
 * diagnostics instead.
 */
export function shouldServeRequests(_state: StartupRecoveryState): boolean {
	return true;
}

/**
 * Whether startup-gated background work (scheduled tasks, IM gateway) may start.
 *
 * A failed recovery pass does not imply the scheduler or gateway are unsafe: they operate on
 * their own persisted records and skip narrators they cannot start. Permanently disabling them
 * until the next restart turns one broken narrator into a silently degraded server.
 */
export function shouldStartGatedBackgroundWork(_result: StartupRecoveryResult): boolean {
	return true;
}

/** Merge the recovery state into the `/api/health` payload the app router produced. */
export function buildHealthPayload(
	basePayload: Record<string, unknown>,
	state: StartupRecoveryState,
): Record<string, unknown> {
	return {
		...basePayload,
		status: state.status === "ready" ? basePayload.status : state.status,
		readiness: state.status,
		...(state.status === "failed" ? { recoveryError: state.error } : {}),
	};
}

/**
 * HTTP status for `/api/health`.
 *
 * A failed recovery still reports 503 so external monitors can distinguish "this build came up
 * healthy" from "this build came up with broken narrator state". Only health is degraded; other
 * routes answer normally.
 *
 * This status is NOT a signal to withhold the new build from the user. Update polling reloads on
 * version identity alone and merely reports the reason afterwards (see
 * `isUpdatedServerReadyForReload`), because treating 503 as "do not reload" stranded the user on
 * the old bundle — the one build without the UI that repairs the broken narrator state.
 */
export function healthStatusCode(state: StartupRecoveryState, baseStatus: number): number {
	return state.status === "failed" ? 503 : baseStatus;
}

export interface StartupReadinessGate {
	/** Current recovery state, for the health endpoint. */
	readonly state: StartupRecoveryState;
	/** Resolves once recovery reaches a terminal outcome. Never rejects. */
	readonly barrier: Promise<StartupRecoveryResult>;
	/** Mark recovery as still running (a planned-update pass continues in the background). */
	markRecovering(): void;
	/** Mark recovery as fully admitted. */
	markReady(): void;
	/** Mark recovery as failed, keeping the request surface open. */
	markFailed(error: string): void;
	/** Settle the barrier exactly once. Later calls are ignored. */
	settle(result: StartupRecoveryResult): void;
}

export function createStartupReadinessGate(): StartupReadinessGate {
	let state: StartupRecoveryState = { status: "recovering" };
	let settled = false;
	let resolveBarrier: (result: StartupRecoveryResult) => void = () => {};
	const barrier = new Promise<StartupRecoveryResult>((resolve) => {
		resolveBarrier = resolve;
	});

	return {
		get state() {
			return state;
		},
		barrier,
		markRecovering() {
			state = { status: "recovering" };
		},
		markReady() {
			state = { status: "ready" };
		},
		markFailed(error: string) {
			state = { status: "failed", error };
		},
		settle(result: StartupRecoveryResult) {
			if (settled) return;
			settled = true;
			resolveBarrier(result);
		},
	};
}
