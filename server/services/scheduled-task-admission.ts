import { AsyncMutex } from "../lib/async-mutex";
import { hotSafe } from "../lib/hot-safe";

/** Lock order: task, then target. Neither lock may await a cancelled runtime's terminal. */
export const scheduledTaskMutationLocks = hotSafe(
	"scheduled-tasks:mutation-locks",
	() => new AsyncMutex(),
);
export const scheduledTaskTargetLocks = hotSafe(
	"scheduled-tasks:target-locks",
	() => new AsyncMutex(),
);
