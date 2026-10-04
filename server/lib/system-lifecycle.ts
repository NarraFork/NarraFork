import type {
	PlannedUpdateRecoverySnapshot,
	UpdateCoordinationStatus,
} from "../services/update-coordinator";

export interface SystemLifecycleStatus {
	phase: "idle" | "preparing" | "prepared" | "shutting_down" | "failed";
	shutdownRequested: boolean;
	error?: string;
	coordination: UpdateCoordinationStatus;
}

export interface SystemLifecycleDependencies {
	coordination(): UpdateCoordinationStatus;
	canShutdown(): boolean;
	schedule(): UpdateCoordinationStatus;
	drain(epoch: string): Promise<PlannedUpdateRecoverySnapshot>;
	persist(snapshot: PlannedUpdateRecoverySnapshot): void;
	assertNotCancelled(): void;
	markClosing(): void;
	shutdown(): boolean;
	cancel(): void;
	cleanup(epoch: string, error: string, cancelled: boolean): Promise<void>;
	isCancellation(error: unknown): boolean;
}

/** The update coordinator remains the single gate; this controller only selects the exit action. */
export function createSystemLifecycle(deps: SystemLifecycleDependencies) {
	let phase: SystemLifecycleStatus["phase"] = "idle";
	let shutdownRequested = false;
	let error: string | undefined;
	let epoch: string | undefined;
	let preparation: Promise<void> | null = null;

	const status = (): SystemLifecycleStatus => ({
		phase,
		shutdownRequested,
		error,
		coordination: deps.coordination(),
	});
	const failure = (message: string) => ({ success: false as const, error: message });
	const success = () => ({ success: true as const, status: status() });

	async function rollback(reason: unknown, ownedEpoch: string) {
		const cancelled = deps.isCancellation(reason) || deps.coordination().cancelRequested;
		error = reason instanceof Error ? reason.message : String(reason);
		try {
			await deps.cleanup(ownedEpoch, error, cancelled);
		} catch (cleanupError) {
			error = `${error}; cleanup failed: ${String(cleanupError)}`;
		}
		shutdownRequested = false;
		phase = cancelled ? "idle" : "failed";
		epoch = undefined;
	}

	function closePrepared() {
		deps.assertNotCancelled();
		if (!deps.shutdown()) throw new Error("Server shutdown is unavailable");
		deps.markClosing();
		phase = "shutting_down";
	}

	function prepare(closeAfterPreparation = false) {
		if (phase === "shutting_down") return success();
		if (!deps.canShutdown()) return failure("Server shutdown is unavailable");
		if (preparation || phase === "preparing") {
			shutdownRequested ||= closeAfterPreparation;
			return success();
		}
		if (phase === "prepared" && !closeAfterPreparation) return success();
		if (phase !== "prepared") {
			if (deps.coordination().scheduled) return failure("An update is already scheduled");
			epoch = deps.schedule().updateEpoch;
		}
		// Prepared state can last indefinitely. Re-converge the same epoch before exiting,
		// because resumable waits may settle or be interrupted while the gate is closed.
		if (!epoch) return failure("Could not acquire the shutdown checkpoint gate");
		const ownedEpoch = epoch;
		phase = "preparing";
		error = undefined;
		shutdownRequested = closeAfterPreparation;
		preparation = (async () => {
			try {
				const snapshot = await deps.drain(ownedEpoch);
				deps.assertNotCancelled();
				deps.persist({ ...snapshot, resumeOnNextStartup: true });
				phase = "prepared";
				if (shutdownRequested) closePrepared();
			} catch (reason) {
				await rollback(reason, ownedEpoch);
			}
		})().finally(() => {
			preparation = null;
		});
		return success();
	}

	function cancel() {
		if (phase === "shutting_down") return failure("Server shutdown has already begun");
		if (phase !== "preparing" && phase !== "prepared") return success();
		deps.cancel();
		shutdownRequested = false;
		if (!preparation && epoch) {
			phase = "preparing";
			preparation = rollback(new Error("System preparation cancelled"), epoch).finally(() => {
				preparation = null;
			});
		}
		return success();
	}

	return {
		status,
		prepare,
		shutdown: () => prepare(true),
		cancel,
		/** Awaitable seam for isolated tests; HTTP requests never wait for drain. */
		settled: async () => {
			await preparation;
		},
	};
}
