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
 *   - `failed`     → the recovery pass itself threw; the reason is surfaced in the health
 *     payload, but `/api/health` still answers 200 and requests keep flowing. Individual
 *     continuation failures are settled on their own tool calls, not here.
 */

export type StartupRecoveryStatus = "recovering" | "ready" | "failed";

export type StartupRecoveryState =
	| { status: "recovering" }
	| { status: "ready" }
	| { status: "failed"; error: string };

export type StartupRecoveryResult = { ok: true } | { ok: false; error: string };

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
