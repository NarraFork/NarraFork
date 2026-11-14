import type { FileChangeBlobRef } from "../../shared/file-change-protocol";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
import { hotSafe } from "../lib/hot-safe";
import { WorkerPool } from "../lib/worker-runtime/pool";
import { TaskQueueError } from "../lib/worker-runtime/queue";
import { GitReaderSession } from "./git-current-baseline-session";
import type {
	CurrentBaselineRequest,
	CurrentBaselineResponse,
	CurrentGitBaseline,
} from "./git-current-baseline-worker";

export type {
	CurrentFileBaseline,
	CurrentGitBaseline,
	GitObjectVersion,
} from "./git-current-baseline-worker";

function createPool() {
	return new WorkerPool<CurrentBaselineRequest, CurrentBaselineResponse>({
		concurrency: 2,
		maxQueued: 0,
		reuse: false,
		create: async ({ signal }) => {
			const { worker, handle } = await connectCompiledWorker(
				compiledWorkerSpecifiers(
					"services/git-current-baseline-worker.ts",
					"./git-current-baseline-worker.ts",
					import.meta.url,
				),
				{ signal },
			);
			return new GitReaderSession(worker, handle, (message) => new Error(message));
		},
	});
}

// Real owners and the permanent production latch survive module re-evaluation together.
const owner = hotSafe("narrafork.gitCurrentBaseline.workers.v1", () => ({
	version: 1,
	pool: createPool(),
}));
if (owner.version !== 1)
	throw new Error(
		"Git current baseline ownership predates this runtime; manually restart NarraFork",
	);

export function closeGitCurrentBaselineWorkers(): Promise<void> {
	return owner.pool.close(new Error("Git current baseline workers are closed"));
}

export async function resetGitCurrentBaselineWorkersForTests(): Promise<void> {
	await closeGitCurrentBaselineWorkers();
	owner.pool = createPool();
}

/** No queue of expensive per-panel scans. Domain budgets stay inside the worker. */
async function read<T extends CurrentBaselineResponse>(
	request: CurrentBaselineRequest,
	signal: AbortSignal,
): Promise<T> {
	try {
		return (await owner.pool.run(request, { signal, deadlineAt: Infinity })) as T;
	} catch (error) {
		if (error instanceof TaskQueueError && error.code === "TASK_QUEUE_FULL")
			throw new Error("reader_busy");
		throw error;
	}
}

/** Separately injectable for deterministic races; defaults always use the real worker. */
export const gitCurrentBaselineReader = {
	snapshot(
		workspacePath: string,
		filePaths: string[] | undefined,
		privateRoot: string,
		signal: AbortSignal,
	): Promise<CurrentGitBaseline> {
		return read({ action: "snapshot", workspacePath, filePaths, privateRoot }, signal);
	},
	verifyBlobs(
		refs: FileChangeBlobRef[],
		privateRoot: string,
		signal: AbortSignal,
	): Promise<string[]> {
		return read({ action: "verify_blobs", refs, privateRoot }, signal);
	},
};
