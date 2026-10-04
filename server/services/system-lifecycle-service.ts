import { hotSafe } from "../lib/hot-safe";
import { canOperatorShutdown, scheduleOperatorShutdown } from "../lib/server-restart";
import { createSystemLifecycle } from "../lib/system-lifecycle";
import { APP_VERSION } from "../lib/version";
import {
	assertUpdateNotCancelled,
	beginQuiescingTools,
	cancelScheduledUpdate,
	getUpdateCoordinationStatus,
	markUpdateRestarting,
	scheduleUpdate,
	UpdateCancelledError,
	waitForBackgroundBashDrain,
	waitForOrdinaryToolDrain,
	writePlannedUpdateRecoverySnapshot,
} from "./update-coordinator";
import { checkpointPreparedUpdateFence, failPreparedUpdateAttempt } from "./update-service";

export const systemLifecycle = hotSafe("systemLifecycle", () =>
	createSystemLifecycle({
		coordination: getUpdateCoordinationStatus,
		canShutdown: canOperatorShutdown,
		schedule: () => scheduleUpdate(undefined, "system_shutdown"),
		drain: async (epoch) => {
			await waitForBackgroundBashDrain();
			assertUpdateNotCancelled();
			beginQuiescingTools();
			await waitForOrdinaryToolDrain();
			return checkpointPreparedUpdateFence(epoch);
		},
		persist: (snapshot) => {
			writePlannedUpdateRecoverySnapshot(snapshot, { expectedEpoch: snapshot.updateEpoch });
		},
		assertNotCancelled: assertUpdateNotCancelled,
		markClosing: markUpdateRestarting,
		shutdown: () => scheduleOperatorShutdown({ reason: "system_prepared_shutdown" }),
		cancel: () => {
			cancelScheduledUpdate("System preparation cancelled");
		},
		cleanup: (updateEpoch, error, cancelled) =>
			failPreparedUpdateAttempt({ updateEpoch, targetVersion: APP_VERSION, error, cancelled }),
		isCancellation: (error) => error instanceof UpdateCancelledError,
	}),
);
