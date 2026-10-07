import { createHash } from "node:crypto";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import type {
	GitWorktreeRequest,
	GitWorktreeResult,
} from "../lib/agent/execution/git-worktree-rpc";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import type { WorktreeCreateRequest } from "../lib/validators/narrator-worktrees";
import {
	type WorktreeCreateResult,
	type WorktreeJournalRecord,
	worktreeProposalHash,
} from "./narrator-worktree-journal";
import type { WorktreeServicePorts, WorktreeTarget } from "./narrator-worktree-service";

/** Structural adapter keeps old executors and the local argv implementation separate. */
export type RemoteWorktreeBackend = ExecutionBackend & {
	supportsGitWorktree?: boolean;
	gitWorktree?: (request: GitWorktreeRequest, signal?: AbortSignal) => Promise<GitWorktreeResult>;
};
export function supportsRemoteWorktree(backend: ExecutionBackend | undefined): boolean {
	const remote = backend as RemoteWorktreeBackend | undefined;
	return remote?.kind === "remote" && remote.supportsGitWorktree === true && !!remote.gitWorktree;
}
export async function remoteWorktreeRequest(
	target: WorktreeTarget,
	request: Omit<GitWorktreeRequest, "cwd" | "expectedRoot" | "expectedRepository">,
	signal: AbortSignal,
): Promise<GitWorktreeResult> {
	const backend = target.backend as RemoteWorktreeBackend | undefined;
	if (
		!backend ||
		!supportsRemoteWorktree(backend) ||
		!backend.gitWorktree ||
		!target.workspace.rootPath ||
		!target.repositoryPath
	)
		throw new AppError(
			"Upgrade the executor for structured worktree management",
			409,
			"WORKTREE_UNSUPPORTED",
		);
	signal.throwIfAborted();
	return backend.gitWorktree(
		{
			...request,
			cwd: target.workspace.cwd,
			expectedRoot: target.workspace.rootPath,
			expectedRepository: target.repositoryPath,
			maxBytes: 128 * 1024,
			timeoutMs: request.operation === "create" ? 120_000 : 10_000,
		},
		signal,
	);
}
function unknown(): WorktreeCreateResult {
	return {
		outcome: "unknown",
		worktree: null,
		residuals: { destinationExists: null, branchExists: null },
		error: {
			code: "WORKTREE_OUTCOME_UNKNOWN",
			message:
				"Keep the original requestId and reconcile its receipt; no automatic retry or cleanup was dispatched",
		},
	};
}
function remoteProposal(narratorId: string, requestId: string, record: WorktreeJournalRecord) {
	return {
		requestId: createHash("sha256")
			.update(JSON.stringify([narratorId, requestId]))
			.digest("hex"),
		requestDigest: record.proposalHash,
		actorKey: record.actorKey,
		branchName: record.branchName,
		branchKind: record.request.branch.kind,
		baseRef: record.request.baseRef,
		destinationPath: record.destination,
	};
}
function bindResult(result: WorktreeCreateResult, record: WorktreeJournalRecord) {
	return {
		...result,
		deviceId: record.deviceId,
		repositoryKey: record.repositoryKey,
		workspaceKey: record.request.workspaceKey,
		workspaceRevision: record.request.expectedRevision,
	};
}
export async function updateRemoteWorktreeResourceState<Principal>(
	ports: WorktreeServicePorts<Principal>,
	narratorId: string,
	requestId: string,
	record: WorktreeJournalRecord,
	result: WorktreeCreateResult,
) {
	await ports.resources
		?.setState(
			{
				ownerNarratorId: narratorId,
				deviceId: record.deviceId ?? "local",
				repositoryKey: record.repositoryKey,
				worktreePath: record.destination,
				createRequestId: requestId,
			},
			result.outcome === "created" ? "ready" : "unknown",
		)
		.catch(() => {
			logger.warn("Remote worktree resource remains protected", {
				narratorId,
				requestId,
				outcome: result.outcome,
			});
		});
}
export async function reconcileRemoteWorktree(
	target: WorktreeTarget,
	narratorId: string,
	requestId: string,
	record: WorktreeJournalRecord,
): Promise<WorktreeCreateResult> {
	try {
		const response = await remoteWorktreeRequest(
			target,
			{ ...remoteProposal(narratorId, requestId, record), operation: "reconcile" },
			AbortSignal.timeout(10_000),
		);
		return bindResult(response.result ?? unknown(), record);
	} catch {
		return bindResult(unknown(), record);
	}
}
export async function createRemoteWorktree<Principal>(
	ports: WorktreeServicePorts<Principal>,
	principal: Principal,
	narratorId: string,
	request: WorktreeCreateRequest,
	target: WorktreeTarget,
	actorKey: string,
	signal: AbortSignal,
	resolveName: () => Promise<string>,
): Promise<WorktreeCreateResult> {
	if (!supportsRemoteWorktree(target.backend))
		throw new AppError(
			"Upgrade the executor for structured worktree management",
			409,
			"WORKTREE_UNSUPPORTED",
		);
	return ports.withRevision(narratorId, request.expectedRevision, () =>
		ports.withRepositoryLock(target.workspace.repositoryKey ?? "", async () => {
			let claim: Awaited<ReturnType<WorktreeServicePorts<Principal>["journal"]["claim"]>>;
			try {
				claim = await ports.journal.claim(narratorId, request.requestId, {
					proposalHash: worktreeProposalHash(request),
					request,
					repositoryKey: target.workspace.repositoryKey ?? "",
					actorKey,
					deviceId: target.workspace.deviceId,
					destination: request.destinationPath,
					expectedHead: "",
				});
			} catch (cause) {
				if (cause instanceof AppError && cause.code === "WORKTREE_REQUEST_CONFLICT") throw cause;
				return unknown();
			}
			const record = claim.record;
			if (
				record.actorKey !== actorKey ||
				record.deviceId !== target.workspace.deviceId ||
				record.repositoryKey !== target.workspace.repositoryKey
			)
				throw new AppError(
					"Receipt actor, device or repository mismatch",
					403,
					"WORKTREE_RECOVERY_DENIED",
				);
			if (!claim.fresh) {
				if (record.result && record.result.outcome !== "unknown")
					return bindResult(record.result, record);
				const result = await reconcileRemoteWorktree(target, narratorId, request.requestId, record);
				await updateRemoteWorktreeResourceState(
					ports,
					narratorId,
					request.requestId,
					record,
					result,
				);
				await ports.journal.save(narratorId, request.requestId, { ...record, result }).catch(() => {
					logger.warn("Remote worktree server receipt could not be persisted", {
						narratorId,
						requestId: request.requestId,
						outcome: result.outcome,
					});
				});
				return result;
			}
			let dispatched = false;
			let result: WorktreeCreateResult;
			try {
				record.branchName = await resolveName();
				await ports.journal.save(narratorId, request.requestId, record);
				const fresh = await ports.authorize(principal, narratorId, "write", signal);
				if (
					fresh.workspace.state !== "ready" ||
					!fresh.workspace.rootPath ||
					fresh.workspace.workspaceKey !== request.workspaceKey ||
					fresh.workspace.repositoryKey !== record.repositoryKey ||
					fresh.workspace.deviceId !== record.deviceId ||
					!fresh.workspace.capabilities.write ||
					fresh.backend?.runtimeGeneration !== target.backend?.runtimeGeneration
				)
					throw new AppError(
						"Workspace changed before worktree dispatch",
						409,
						"GIT_WORKSPACE_CHANGED",
					);
				// Whole-root Git policy cannot be widened to a sibling just by supplying its path.
				if (
					!fresh.backend?.paths.contains(fresh.workspace.rootPath ?? "", record.destination) ||
					fresh.backend.paths.equals(fresh.workspace.rootPath ?? "", record.destination)
				)
					throw new AppError(
						"Destination must be inside the authorized tree",
						403,
						"WORKTREE_DESTINATION_DENIED",
					);
				await ports.resources?.register({
					ownerNarratorId: narratorId,
					deviceId: record.deviceId ?? "local",
					repositoryKey: record.repositoryKey,
					worktreePath: record.destination,
					createRequestId: request.requestId,
					scope: fresh.resourceScope,
				});
				signal.throwIfAborted();
				dispatched = true;
				result =
					(
						await remoteWorktreeRequest(
							fresh,
							{ ...remoteProposal(narratorId, request.requestId, record), operation: "create" },
							signal,
						)
					).result ?? unknown();
			} catch (cause) {
				result = dispatched
					? await reconcileRemoteWorktree(target, narratorId, request.requestId, record)
					: {
							outcome: "failed",
							worktree: null,
							residuals: { destinationExists: null, branchExists: null },
							error: {
								code: cause instanceof AppError ? cause.code : "WORKTREE_VALIDATION_FAILED",
								message:
									cause instanceof AppError
										? cause.message
										: "Remote worktree validation failed before dispatch",
							},
						};
			}
			result = bindResult(result, record);
			if (dispatched)
				await updateRemoteWorktreeResourceState(
					ports,
					narratorId,
					request.requestId,
					record,
					result,
				);
			await ports.journal.save(narratorId, request.requestId, { ...record, result }).catch(() => {
				logger.warn("Remote worktree server receipt could not be persisted", {
					narratorId,
					requestId: request.requestId,
					outcome: result.outcome,
				});
			});
			return result;
		}),
	);
}
