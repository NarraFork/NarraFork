import { db } from "@server/db";
import { readDomainTask } from "@server/db/worker-read";
import {
	getSourceClient,
	isPostgresSource,
	type SqlReadSource,
} from "@server/db/worker-read-adapter";
import { DbReadError } from "@server/lib/db-worker/errors";
import { type ExecutionPolicyFactsStore, readExecutionPolicyFactsNow } from "./facts";
import {
	captureExecutionPolicySettings,
	type LoadedExecutionPolicy,
	materializeExecutionPolicy,
} from "./materializer";

export type { LoadedExecutionPolicy } from "./materializer";

export class ExecutionPolicyRepository {
	constructor(private readonly store: ExecutionPolicyFactsStore & SqlReadSource = db) {}

	async load(narratorId: string): Promise<LoadedExecutionPolicy> {
		// Preserve the existing backend seam; do not send PG work to SQLite workers.
		if (isPostgresSource(this.store)) return this.loadNow(narratorId);
		const client = getSourceClient(this.store);
		if (!client)
			throw new DbReadError("DB_READ_UNSUPPORTED", "Policy facts require a SQLite worker");
		const facts = await readDomainTask(
			client,
			"executionPolicyFacts",
			{ narratorId },
			{ executionPolicy: "worker-required", timeoutMs: 30_000 },
		);
		return materializeExecutionPolicy(facts, captureExecutionPolicySettings(facts));
	}

	/**
	 * Authoritative synchronous reads for final write transactions and no-await fences.
	 * An explicit transaction observes its own uncommitted rules; it is never dispatched.
	 */
	loadNow(
		narratorId: string,
		store: ExecutionPolicyFactsStore = this.store,
	): LoadedExecutionPolicy {
		const facts = readExecutionPolicyFactsNow(narratorId, store);
		return materializeExecutionPolicy(facts, captureExecutionPolicySettings(facts));
	}
}
export const executionPolicyRepository = new ExecutionPolicyRepository();
