import { Worker } from "node:worker_threads";
import { hotSafe } from "../lib/hot-safe";
import {
	LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS,
	type LegacySnapshotMembershipInput,
} from "./legacy-retained-snapshot-membership-contract";

type MembershipWorker = Pick<Worker, "once" | "terminate">;
const readers = hotSafe<Set<MembershipWorker>>(
	"narrafork.legacySnapshotMembershipReaders",
	() => new Set(),
);

/** Test seam and lifecycle policy: successful messages are unusable until normal exit.
 * Cancellation/timeout starts termination, but only the actual exit event releases capacity. */
export function createLegacySnapshotMembershipReader(
	options: {
		create?: (input: LegacySnapshotMembershipInput) => MembershipWorker;
		pool?: Set<MembershipWorker>;
		timeoutMs?: number;
	} = {},
) {
	const pool = options.pool ?? readers;
	const create =
		options.create ??
		((input) =>
			new Worker(new URL("./legacy-retained-snapshot-membership-worker.ts", import.meta.url), {
				workerData: input,
			}));
	return async (input: LegacySnapshotMembershipInput, signal?: AbortSignal): Promise<boolean> => {
		if (signal?.aborted || pool.size >= LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.workers) return false;
		let worker: MembershipWorker;
		try {
			worker = create(input);
		} catch {
			return false;
		}
		pool.add(worker);
		return new Promise<boolean>((resolve) => {
			let evidence: boolean | undefined;
			let settled = false;
			let terminationStarted = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", stop);
				resolve(value);
			};
			const stop = () => {
				if (!terminationStarted) {
					terminationStarted = true;
					try {
						void worker.terminate().catch(() => {});
					} catch {
						/* Keep the occupied slot. */
					}
				}
				finish(false);
			};
			const timer = setTimeout(
				stop,
				Math.min(
					options.timeoutMs ?? LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.milliseconds,
					LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.milliseconds,
				),
			);
			worker.once("message", (value: unknown) => {
				if (typeof value !== "boolean") stop();
				else evidence = value;
			});
			worker.once("error", stop);
			worker.once("exit", (code) => {
				pool.delete(worker);
				finish(code === 0 && !terminationStarted && evidence === true && !signal?.aborted);
			});
			signal?.addEventListener("abort", stop, { once: true });
			if (signal?.aborted) stop();
		});
	};
}

export const readLegacySnapshotMembership = createLegacySnapshotMembershipReader();
