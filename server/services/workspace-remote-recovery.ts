import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type { RemoteHistoryReceipt } from "@shared/remote-history-protocol";
import type { RemoteHistoryService } from "./remote-history-service";

export interface RemoteRecoveryAuthority {
	/** Reauthorize the recorded device/root, not the narrator's new directory. */
	authorize(operationId: string, signal: AbortSignal): Promise<void>;
	/** Absence of an in-memory item is NOT not_committed. Must inspect durable history. */
	serverCommit(
		operationId: string,
	): Promise<
		{ state: "committed"; commitId: string } | { state: "not_committed" } | { state: "unknown" }
	>;
	/** Durable original compensation ID/digest; never mint a new ID on a retry. */
	compensationIntent(operationId: string): Promise<{ operationId: string; requestDigest: string }>;
	/** Must persist recovery proof before releasing the server scope quarantine. */
	acknowledge(receipt: RemoteHistoryReceipt): Promise<void>;
}

export interface RemoteRecoveryResult {
	operationId: string;
	state: "finalized" | "compensated" | "recovery_required";
	receipt?: RemoteHistoryReceipt;
	reason?: string;
}

/** Bounded reconnect/startup primitive, deliberately independent of local PID/TTL. */
export async function recoverRemoteWorkspaceOperations(input: {
	history: RemoteHistoryService;
	authority: RemoteRecoveryAuthority;
	operationIds: readonly string[];
	signal: AbortSignal;
}): Promise<RemoteRecoveryResult[]> {
	if (input.operationIds.length > FILE_CHANGE_LIMITS.historyPageItems)
		throw new Error("Remote recovery page budget exceeded");
	const results: RemoteRecoveryResult[] = [];
	for (const operationId of input.operationIds) {
		input.signal.throwIfAborted();
		await input.authority.authorize(operationId, input.signal);
		try {
			const receipt = await input.history.status(operationId, input.signal);
			if (receipt.state === "finalized" || receipt.state === "compensated") {
				await input.authority.acknowledge(receipt);
				results.push({ operationId, state: receipt.state, receipt });
				continue;
			}
			const allEffectsProven =
				receipt.state === "applying" &&
				receipt.effects.length > 0 &&
				receipt.effects.every((effect) => effect.outcome === "applied" && effect.after);
			if (receipt.state !== "settled" && !allEffectsProven) {
				results.push({
					operationId,
					state: "recovery_required",
					receipt,
					reason: "Remote journal is unsettled; observation cannot prove execution",
				});
				continue;
			}
			const commit = await input.authority.serverCommit(operationId);
			let reconciled: RemoteHistoryReceipt;
			if (commit.state === "committed") {
				reconciled = await input.history.finalize(
					operationId,
					receipt.requestDigest,
					commit.commitId,
					input.signal,
				);
			} else if (commit.state === "not_committed" && receipt.kind !== "capture") {
				const compensation = await input.authority.compensationIntent(operationId);
				await input.authority.authorize(operationId, input.signal);
				reconciled = await input.history.dispatch(
					"compensate",
					{
						binding: input.history.binding,
						...compensation,
						originalOperationId: operationId,
					},
					input.signal,
				);
			} else {
				results.push({
					operationId,
					state: "recovery_required",
					receipt,
					reason: "Server commit result is unknown or capture is not committed",
				});
				continue;
			}
			if (reconciled.state !== "finalized" && reconciled.state !== "compensated") {
				results.push({
					operationId,
					state: "recovery_required",
					receipt: reconciled,
					reason: "Conditional compensation conflicted; retain quarantine",
				});
				continue;
			}
			await input.authority.acknowledge(reconciled);
			results.push({ operationId, state: reconciled.state, receipt: reconciled });
		} catch (error) {
			input.signal.throwIfAborted();
			results.push({
				operationId,
				state: "recovery_required",
				reason: error instanceof Error ? error.message.slice(0, 1024) : "Recovery failed",
			});
		}
	}
	return results;
}
