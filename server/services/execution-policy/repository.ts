import { db } from "@server/db";
import { type ReadQueryOptions, readDomainTask } from "@server/db/worker-read";
import {
	getSourceClient,
	isPostgresSource,
	type SqlReadSource,
} from "@server/db/worker-read-adapter";
import { DbReadError } from "@server/lib/db-worker/errors";
import {
	type ExecutionPolicyFacts,
	type ExecutionPolicyFactsStore,
	readExecutionPolicyFactsNow,
} from "./facts";
import {
	captureExecutionPolicySettings,
	type LoadedExecutionPolicy as MaterializedLoadedExecutionPolicy,
	materializeExecutionPolicy,
} from "./materializer";

export type LoadedExecutionPolicy = MaterializedLoadedExecutionPolicy & {
	projectIds?: readonly string[];
};

function materializeLoadedPolicy(facts: ExecutionPolicyFacts): LoadedExecutionPolicy {
	const policy = materializeExecutionPolicy(facts, captureExecutionPolicySettings(facts));
	const projectIds = (facts as ExecutionPolicyFacts & { projectIds?: readonly string[] })
		.projectIds;
	return {
		...policy,
		projectIds: projectIds ?? (facts.projectId ? [facts.projectId] : []),
	};
}

export class ExecutionPolicyRepository {
	constructor(private readonly store: ExecutionPolicyFactsStore & SqlReadSource = db) {}

	async load(narratorId: string, signal?: AbortSignal): Promise<LoadedExecutionPolicy>;
	async load(narratorId: string, readOptions?: ReadQueryOptions): Promise<LoadedExecutionPolicy>;
	async load(
		narratorId: string,
		readOptionsOrSignal?: ReadQueryOptions | AbortSignal,
	): Promise<LoadedExecutionPolicy> {
		const readOptions =
			readOptionsOrSignal instanceof AbortSignal
				? { signal: readOptionsOrSignal }
				: readOptionsOrSignal;
		const signal = readOptions?.signal;
		signal?.throwIfAborted();
		// PostgreSQL keeps its native async path; SQLite facts are always isolated in a worker.
		if (isPostgresSource(this.store)) {
			const policy = this.loadNow(narratorId);
			signal?.throwIfAborted();
			return policy;
		}
		const client = getSourceClient(this.store);
		if (!client)
			throw new DbReadError("DB_READ_UNSUPPORTED", "Policy facts require a SQLite worker");
		if (!client.filename || client.filename === ":memory:" || client.inTransaction) {
			throw new DbReadError("DB_READ_UNSUPPORTED", "Policy facts require a committed SQLite file");
		}
		const facts = await readDomainTask(
			client,
			"executionPolicyFacts",
			{ narratorId },
			{
				...(readOptions ?? {}),
				executionPolicy: "worker-required",
				diagnosticSource: "execution-policy-facts",
				timeoutMs: Math.min(readOptions?.timeoutMs ?? 5_000, 5_000),
				signal,
			},
		);
		signal?.throwIfAborted();
		return materializeLoadedPolicy(facts);
	}

	/** Authoritative synchronous reads for final write transactions and no-await fences. */
	loadNow(
		narratorId: string,
		store: ExecutionPolicyFactsStore = this.store,
	): LoadedExecutionPolicy {
		return materializeLoadedPolicy(readExecutionPolicyFactsNow(narratorId, store));
	}
}

export const executionPolicyRepository = new ExecutionPolicyRepository();
