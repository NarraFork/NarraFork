import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat } from "node:fs/promises";
import type { GitWorkspace } from "@shared/git-workspace";
import type { WorktreeListResult, WorktreePrepareResult } from "@shared/narrator-worktrees";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { type SafeSpawnResult, safeSpawn } from "../lib/spawn";
import {
	type WorktreeCreateRequest,
	worktreeCreateSchema,
	worktreeListSchema,
	worktreePrepareSchema,
} from "../lib/validators/narrator-worktrees";
import {
	type WorktreeCreateResult,
	type WorktreeEntry,
	type WorktreeJournal,
	type WorktreeJournalRecord,
	worktreeProposalHash,
} from "./narrator-worktree-journal";

import type { WorktreeResourceRegistry } from "./narrator-worktree-resources";

export type { WorktreeCreateResult, WorktreeEntry } from "./narrator-worktree-journal";

/** ASCII filesystem leaf with an exact-ref hash; Git branch names remain unchanged. */
export function worktreeDirectoryName(branchName: string): string {
	const slug =
		branchName
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "worktree";
	return `${slug}-${createHash("sha256").update(branchName).digest("hex").slice(0, 12)}`;
}
export const WORKTREE_MAX_OUTPUT_BYTES = 128 * 1024;
export const WORKTREE_MAX_ENTRIES = 128;
export const WORKTREE_READ_TIMEOUT_MS = 10_000;
export const WORKTREE_CREATE_TIMEOUT_MS = 120_000;
export const WORKTREE_NAME_TIMEOUT_MS = 5000;

type ResolvedWorktreeRequest = Omit<WorktreeCreateRequest, "branch"> & {
	branch: { kind: "new" | "existing"; name: string };
};

export type { WorktreeListResult, WorktreePrepareResult } from "@shared/narrator-worktrees";

/** safeSpawn may append a truncation explanation; structured porcelain must stay byte bounded. */
export function boundWorktreeGitResult(result: SafeSpawnResult): SafeSpawnResult {
	const bound = (text: string) => {
		const bytes = Buffer.from(text);
		return bytes.byteLength <= WORKTREE_MAX_OUTPUT_BYTES
			? text
			: new TextDecoder().decode(bytes.subarray(0, WORKTREE_MAX_OUTPUT_BYTES), { stream: true });
	};
	return {
		...result,
		stdout: bound(result.stdout),
		stderr: bound(result.stderr),
		stdoutTruncated:
			result.stdoutTruncated || Buffer.byteLength(result.stdout) > WORKTREE_MAX_OUTPUT_BYTES,
		stderrTruncated:
			result.stderrTruncated || Buffer.byteLength(result.stderr) > WORKTREE_MAX_OUTPUT_BYTES,
	};
}

export interface WorktreeTarget {
	workspace: GitWorkspace;
	backend?: ExecutionBackend;
	repositoryPath?: string;
}
export interface WorktreeServicePorts<Principal> {
	/** Must be the existing Git ACL/policy authorization, not a client-path resolver. */
	authorize(
		principal: Principal,
		narratorId: string,
		need: "read" | "write",
		signal: AbortSignal,
	): Promise<WorktreeTarget>;
	/** Shared with directory switching; holds revision admission for the entire mutation. */
	withRevision<T>(narratorId: string, expectedRevision: number, fn: () => Promise<T>): Promise<T>;
	/** Shared with ALL existing Git writes, fail-fast rather than an unbounded queue. */
	withRepositoryLock<T>(repositoryKey: string, fn: () => Promise<T>): Promise<T>;
	journal: WorktreeJournal;
	/** Production inventory, independent of narrator lifetime and receipt retention. */
	resources?: WorktreeResourceRegistry;
	/** Stable authenticated actor identifier; production never derives this from request input. */
	principalKey?: (principal: Principal) => string;
	/** Existing summary-model adapter; no model fallback is silently reported as success. */
	generateBranchName?: (
		principal: Principal,
		narratorId: string,
		requirement: string | undefined,
		signal: AbortSignal,
	) => Promise<string>;
	/** Tests may shorten (never increase) the naming deadline. */
	nameTimeoutMs?: number;
	/** Test seam. Production defaults to local-only argv execution with hard bounds. */
	runGit?: (
		target: WorktreeTarget,
		args: string[],
		signal: AbortSignal,
		writing: boolean,
	) => Promise<SafeSpawnResult>;
}

/** -z porcelain uses empty fields as record boundaries, avoiding newline/path quoting ambiguity. */
export function parseWorktreePorcelain(
	output: string,
	truncated = false,
): {
	entries: WorktreeEntry[];
	truncated: boolean;
} {
	const entries: WorktreeEntry[] = [];
	let entry: WorktreeEntry | null = null;
	for (const field of output.split("\0")) {
		if (field === "") {
			if (entry) {
				if (entries.length === WORKTREE_MAX_ENTRIES) return { entries, truncated: true };
				entries.push(entry);
				entry = null;
			}
			continue;
		}
		if (field.startsWith("worktree ")) {
			const path = field.slice(9);
			if (!path || path.length > 4096 || entry) return { entries, truncated: true };
			entry = { path, head: null, branch: null, detached: false, locked: false, prunable: false };
		} else if (entry) {
			if (field.startsWith("HEAD ")) entry.head = field.slice(5, 133);
			else if (field.startsWith("branch ")) {
				if (field.length > 512) return { entries, truncated: true };
				entry.branch = field.slice(7);
			} else if (field === "detached") entry.detached = true;
			else if (field === "locked" || field.startsWith("locked ")) entry.locked = true;
			else if (field === "prunable" || field.startsWith("prunable ")) entry.prunable = true;
		}
	}
	return { entries, truncated: truncated || entry !== null };
}

function error(code: string, message: string, status = 400): never {
	throw new AppError(message, status, code);
}
function hasControlCharacters(value: string): boolean {
	return [...value].some(
		(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
	);
}
function validateRef(ref: string) {
	if (ref.startsWith("-") || /\s/.test(ref) || hasControlCharacters(ref))
		error("WORKTREE_INVALID_REF", "Ref must be a bounded non-option Git revision");
}
function assertReady(target: WorktreeTarget, need: "read" | "write", workspaceKey: string) {
	const { workspace, backend } = target;
	if (workspace.workspaceKey !== workspaceKey)
		error("GIT_WORKSPACE_CHANGED", "Git workspace changed; refresh before retrying", 409);
	if (workspace.state !== "ready" || !workspace.capabilities[need])
		error("GIT_WORKSPACE_UNAVAILABLE", "Git workspace unavailable or access denied", 403);
	if (!backend || backend.kind !== "local" || workspace.deviceId !== "local")
		error("WORKTREE_UNSUPPORTED", "Remote worktree operations are not supported", 409);
	if (!workspace.rootPath || !workspace.repositoryKey || !target.repositoryPath)
		error("GIT_WORKSPACE_UNAVAILABLE", "Canonical Git identity unavailable", 409);
}

export class NarratorWorktreeService<Principal> {
	constructor(private readonly ports: WorktreeServicePorts<Principal>) {}

	private actorKey(principal: Principal): string {
		const key =
			this.ports.principalKey?.(principal) ?? (typeof principal === "string" ? principal : "");
		if (!key || key.length > 256)
			error("WORKTREE_ACTOR_REQUIRED", "A stable authenticated actor is required", 403);
		return key;
	}

	private async run(target: WorktreeTarget, args: string[], signal: AbortSignal, writing = false) {
		if (!target.backend || target.backend.kind !== "local")
			error(
				"WORKTREE_UNSUPPORTED",
				"Only the authorized local backend supports worktree argv",
				409,
			);
		signal.throwIfAborted();
		const result = await (this.ports.runGit
			? this.ports.runGit(target, args, signal, writing)
			: safeSpawn({
					cmd: ["git", "--no-optional-locks", "-C", target.workspace.rootPath ?? "", ...args],
					timeout: writing ? WORKTREE_CREATE_TIMEOUT_MS : WORKTREE_READ_TIMEOUT_MS,
					maxOutputBytes: WORKTREE_MAX_OUTPUT_BYTES,
					killProcessTree: true,
					env: {
						...process.env,
						GIT_DIR: undefined,
						GIT_COMMON_DIR: undefined,
						GIT_WORK_TREE: undefined,
						GIT_INDEX_FILE: undefined,
					},
					signal,
				}));
		return boundWorktreeGitResult(result);
	}

	private async entries(target: WorktreeTarget, signal: AbortSignal) {
		const result = await this.run(target, ["worktree", "list", "--porcelain", "-z"], signal);
		if (result.exitCode !== 0) error("WORKTREE_LIST_FAILED", "Unable to list Git worktrees", 409);
		return parseWorktreePorcelain(
			result.stdout,
			!!(result.stdoutTruncated || result.stderrTruncated),
		);
	}

	async list(
		principal: Principal,
		narratorId: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<WorktreeListResult> {
		const { workspaceKey } = worktreeListSchema.parse(input);
		const target = await this.ports.authorize(principal, narratorId, "read", signal);
		assertReady(target, "read", workspaceKey);
		const result = await this.entries(target, signal);
		return {
			repositoryKey: target.workspace.repositoryKey,
			...result,
			capabilities: {
				list: true,
				create: target.workspace.capabilities.write,
				switch: false,
				delete: false,
				prune: false,
				remote: false,
				reason:
					"Create supports only existing, non-symlink parents inside the authorized repository root; switching and cleanup are separate operations",
			},
		};
	}

	private async resolveBranchName(
		principal: Principal,
		narratorId: string,
		explicit: string | undefined,
		requirement: string | undefined,
		seed: string,
		signal: AbortSignal,
	): Promise<string> {
		if (explicit !== undefined) return explicit;
		const generate = this.ports.generateBranchName;
		if (!generate)
			error(
				"WORKTREE_NAME_GENERATION_FAILED",
				"Summary-model naming is unavailable; retry preparation or supply a name",
				503,
			);
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, controller.signal]);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		try {
			signal.throwIfAborted();
			const cancelled = new Promise<never>((_resolve, reject) => {
				abort = () => reject(combined.reason);
				combined.addEventListener("abort", abort, { once: true });
				timer = setTimeout(
					() => controller.abort(new Error("Worktree naming deadline exceeded")),
					Math.max(
						1,
						Math.min(
							this.ports.nameTimeoutMs ?? WORKTREE_NAME_TIMEOUT_MS,
							WORKTREE_NAME_TIMEOUT_MS,
						),
					),
				);
			});
			const suggestion = await Promise.race([
				generate(principal, narratorId, requirement, combined),
				cancelled,
			]);
			const slug = suggestion.trim().toLowerCase();
			if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)) throw new Error("Invalid generated branch slug");
			return `nf/${slug}-${seed}`;
		} catch {
			signal.throwIfAborted();
			throw new AppError(
				"Summary-model naming failed or timed out; retry preparation or supply a name",
				503,
				"WORKTREE_NAME_GENERATION_FAILED",
			);
		} finally {
			if (timer) clearTimeout(timer);
			if (abort) combined.removeEventListener("abort", abort);
			controller.abort();
		}
	}

	async prepare(
		principal: Principal,
		narratorId: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<WorktreePrepareResult> {
		const request = worktreePrepareSchema.parse(input);
		const target = await this.ports.authorize(principal, narratorId, "read", signal);
		assertReady(target, "read", request.workspaceKey);
		return this.ports.withRevision(narratorId, request.expectedRevision, async () => {
			const branchName = await this.resolveBranchName(
				principal,
				narratorId,
				request.branchName ?? (request.name?.trim() ? request.name : undefined),
				request.requirement,
				randomUUID().replaceAll("-", "").slice(0, 10),
				signal,
			);
			validateRef(branchName);
			const valid = await this.run(
				target,
				["check-ref-format", `refs/heads/${branchName}`],
				signal,
			);
			if (valid.exitCode !== 0) error("WORKTREE_INVALID_BRANCH", "Invalid Git branch name");
			const exists = await this.run(
				target,
				["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
				signal,
			);
			if (exists.exitCode === 0) error("WORKTREE_BRANCH_EXISTS", "New branch already exists", 409);
			if (exists.exitCode !== 1) error("WORKTREE_REF_FAILED", "Cannot determine branch state", 409);
			const backend = target.backend;
			const root = target.workspace.rootPath;
			if (!backend || !root)
				error("GIT_WORKSPACE_UNAVAILABLE", "Workspace identity unavailable", 409);
			let worktreeName: string;
			let destinationPath: string;
			if (request.destinationPath !== undefined) {
				destinationPath = request.destinationPath;
				worktreeName = backend.paths.basename(destinationPath);
			} else {
				worktreeName = worktreeDirectoryName(branchName);
				const parent = backend.paths.resolve(root, ".worktrees");
				const parentStat = await lstat(parent).catch((cause) => {
					if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw cause;
				});
				if (parentStat?.isSymbolicLink())
					error("WORKTREE_SYMLINK_PATH", "Default worktree parent is a symlink");
				destinationPath = backend.paths.resolve(
					parentStat?.isDirectory() ? parent : root,
					parentStat?.isDirectory() ? worktreeName : `nf-worktree-${worktreeName}`,
				);
			}
			await this.requireDestination(target, destinationPath, signal);
			return { branchName, worktreeName, destinationPath };
		});
	}

	private async requireDestination(
		target: WorktreeTarget,
		destination: string,
		signal: AbortSignal,
	) {
		const backend = target.backend;
		const root = target.workspace.rootPath;
		if (!backend || !root)
			error("GIT_WORKSPACE_UNAVAILABLE", "Workspace identity unavailable", 409);
		const paths = backend.paths;
		if (
			!paths.isAbsolute(destination) ||
			hasControlCharacters(destination) ||
			paths.normalize(destination) !== destination
		)
			error("WORKTREE_INVALID_PATH", "Destination must be an absolute normalized path");
		// Existing Git authorization checks the WHOLE root for nested blacklist/ACL restrictions.
		// Do not widen that grant to a sibling path just because the client supplies one.
		if (
			!paths.contains(root, destination) ||
			paths.equals(root, destination) ||
			(target.repositoryPath && paths.contains(target.repositoryPath, destination))
		)
			error(
				"WORKTREE_DESTINATION_DENIED",
				"Destination must be inside the authorized repository root",
				403,
			);
		const identity = await backend.resolvePathIdentity(destination, {
			signal,
			timeoutMs: WORKTREE_READ_TIMEOUT_MS,
		});
		if (
			!paths.equals(identity.canonicalPath, destination) ||
			identity.runtimeGeneration !== backend.runtimeGeneration
		)
			error("WORKTREE_SYMLINK_PATH", "Symlink/junction destination identities are not supported");
		let cursor = destination;
		let first = true;
		while (!paths.equals(cursor, root)) {
			signal.throwIfAborted();
			let entry: Stats | undefined;
			try {
				entry = await lstat(cursor);
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
				if (!first) error("WORKTREE_MISSING_PARENT", "Destination parent must already exist");
			}
			if (entry?.isSymbolicLink())
				error("WORKTREE_SYMLINK_PATH", "Symlink destinations are not supported");
			if (first && entry) error("WORKTREE_DESTINATION_EXISTS", "Destination already exists", 409);
			if (!first && !entry?.isDirectory())
				error("WORKTREE_INVALID_PATH", "Destination parent is not a directory");
			first = false;
			cursor = paths.dirname(cursor);
		}
		await access(paths.dirname(destination), constants.W_OK | constants.X_OK);
		return identity.canonicalPath;
	}

	private async verifyIdentity(target: WorktreeTarget, signal: AbortSignal) {
		const result = await this.run(
			target,
			["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
			signal,
		);
		if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated)
			error("GIT_WORKSPACE_CHANGED", "Cannot verify the source repository identity", 409);
		const [root, repository] = result.stdout.trim().split("\n");
		const backend = target.backend;
		if (!backend || !root || !repository)
			error("GIT_WORKSPACE_CHANGED", "Invalid repository identity", 409);
		const [rootIdentity, repoIdentity] = await Promise.all([
			backend.resolvePathIdentity(root, { signal, timeoutMs: WORKTREE_READ_TIMEOUT_MS }),
			backend.resolvePathIdentity(repository, { signal, timeoutMs: WORKTREE_READ_TIMEOUT_MS }),
		]);
		if (
			!backend.paths.equals(rootIdentity.canonicalPath, target.workspace.rootPath ?? "") ||
			!backend.paths.equals(repoIdentity.canonicalPath, target.repositoryPath ?? "")
		)
			error("GIT_WORKSPACE_CHANGED", "Source repository identity changed", 409);
	}

	private async verifyBranch(
		target: WorktreeTarget,
		request: ResolvedWorktreeRequest,
		signal: AbortSignal,
	) {
		validateRef(request.branch.name);
		const branch = `refs/heads/${request.branch.name}`;
		const valid = await this.run(target, ["check-ref-format", branch], signal);
		if (valid.exitCode !== 0) error("WORKTREE_INVALID_BRANCH", "Invalid Git branch name");
		const exists = await this.run(target, ["show-ref", "--verify", "--quiet", branch], signal);
		if (exists.exitCode !== 0 && exists.exitCode !== 1)
			error("WORKTREE_REF_FAILED", "Cannot determine branch state", 409);
		if (request.branch.kind === "new" && exists.exitCode === 0)
			error("WORKTREE_BRANCH_EXISTS", "New branch already exists", 409);
		if (request.branch.kind === "existing" && exists.exitCode !== 0)
			error("WORKTREE_BRANCH_MISSING", "Existing branch does not exist", 409);
		const list = await this.entries(target, signal);
		if (list.truncated)
			error(
				"WORKTREE_LIST_TRUNCATED",
				"Cannot safely create with an incomplete worktree list",
				409,
			);
		if (list.entries.some((entry) => entry.branch === branch))
			error("WORKTREE_BRANCH_CHECKED_OUT", "Branch is already checked out", 409);
		const base = request.branch.kind === "existing" ? branch : (request.baseRef ?? "HEAD");
		validateRef(base);
		const commit = await this.run(
			target,
			["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
			signal,
		);
		const head = commit.stdout.trim();
		if (commit.exitCode !== 0 || commit.stdoutTruncated || !/^[a-f0-9]{40,64}$/.test(head))
			error("WORKTREE_INVALID_BASE", "Base ref must resolve to a commit");
		return head;
	}

	private async reconcile(
		target: WorktreeTarget,
		record: WorktreeJournalRecord,
	): Promise<WorktreeCreateResult> {
		// Verification has its own bounded deadline, independent of the disconnected request.
		const signal = AbortSignal.timeout(WORKTREE_READ_TIMEOUT_MS);
		let destinationExists: boolean | null = null;
		let branchExists: boolean | null = null;
		try {
			const branchName = record.branchName ?? record.request.branch.name;
			if (!branchName) throw new Error("Pending receipt has no frozen branch name");
			destinationExists = await lstat(record.destination).then(
				() => true,
				(cause) => {
					if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
					throw cause;
				},
			);
			await this.verifyIdentity(target, signal);
			const branch = await this.run(
				target,
				["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
				signal,
			);
			if (branch.exitCode === 0 || branch.exitCode === 1) branchExists = branch.exitCode === 0;
			const list = await this.entries(target, signal);
			const found = list.entries.find((entry) =>
				target.backend?.paths.equals(entry.path, record.destination),
			);
			if (
				found &&
				!found.prunable &&
				found.branch === `refs/heads/${branchName}` &&
				found.head === record.expectedHead &&
				destinationExists
			) {
				const backend = target.backend;
				if (!backend) throw new Error("Backend unavailable");
				const identity = await backend.resolvePathIdentity(record.destination, {
					signal,
					timeoutMs: WORKTREE_READ_TIMEOUT_MS,
				});
				if (!backend.paths.equals(identity.canonicalPath, record.destination))
					throw new Error("Destination identity changed");
				const probe = await this.run(
					{ ...target, workspace: { ...target.workspace, rootPath: record.destination } },
					["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
					signal,
				);
				const [root, common] = probe.stdout.trim().split("\n");
				if (
					probe.exitCode !== 0 ||
					probe.stdoutTruncated ||
					probe.stderrTruncated ||
					!root ||
					!common ||
					!backend.paths.equals(
						(await backend.resolvePathIdentity(root, { signal })).canonicalPath,
						record.destination,
					) ||
					!backend.paths.equals(
						(await backend.resolvePathIdentity(common, { signal })).canonicalPath,
						target.repositoryPath ?? "",
					)
				)
					throw new Error("Created worktree repository identity unavailable");
				if (!record.commandSucceeded) {
					// Registration and HEAD alone can precede a checkout interrupted midway.
					const status = await this.run(
						{ ...target, workspace: { ...target.workspace, rootPath: record.destination } },
						["status", "--porcelain=v1", "-z", "--untracked-files=no"],
						signal,
					);
					if (
						status.exitCode !== 0 ||
						status.stdoutTruncated ||
						status.stderrTruncated ||
						status.stdout !== ""
					)
						throw new Error("Cannot prove that interrupted checkout completed");
				}
				return {
					outcome: "created",
					worktree: found,
					residuals: { destinationExists, branchExists },
				};
			}
			if (!list.truncated && !found && branchExists !== null)
				return {
					outcome: "failed",
					worktree: null,
					residuals: { destinationExists, branchExists },
					error: {
						code: "WORKTREE_CREATE_FAILED",
						message: "No matching registered worktree; residual files or branch are left untouched",
					},
				};
		} catch {
			// An inaccessible repository, truncated evidence or lost runtime is not proof of failure.
		}
		return {
			outcome: "unknown",
			worktree: null,
			residuals: { destinationExists, branchExists },
			error: {
				code: "WORKTREE_OUTCOME_UNKNOWN",
				message:
					"Creation outcome could not be verified; reuse this requestId, do not blindly retry or clean up",
			},
		};
	}

	/** Read-only receipt recovery: old revisions/roots never admit another worktree add. */
	async reconcileRequest(
		principal: Principal,
		narratorId: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<WorktreeCreateResult> {
		const request = worktreeCreateSchema.parse(input);
		const initial = await this.ports.authorize(principal, narratorId, "read", signal);
		assertReady(initial, "read", initial.workspace.workspaceKey ?? "");
		const actorKey = this.actorKey(principal);
		let record: WorktreeJournalRecord | null;
		try {
			record = await this.ports.journal.read(narratorId, request.requestId);
		} catch {
			return {
				outcome: "unknown",
				worktree: null,
				residuals: { destinationExists: null, branchExists: null },
				error: {
					code: "WORKTREE_RECEIPT_UNAVAILABLE",
					message: "Cannot read the original receipt; no creation or cleanup was dispatched",
				},
			};
		}
		if (!record)
			throw new AppError("Worktree request receipt not found", 404, "WORKTREE_REQUEST_NOT_FOUND");
		if (
			record.actorKey !== actorKey ||
			record.deviceId !== initial.workspace.deviceId ||
			record.repositoryKey !== initial.workspace.repositoryKey
		)
			error(
				"WORKTREE_RECOVERY_DENIED",
				"Receipt recovery requires its original actor, device and repository",
				403,
			);
		if (record.proposalHash !== worktreeProposalHash(request))
			error(
				"WORKTREE_REQUEST_CONFLICT",
				"Recovery must use the exact original creation proposal",
				409,
			);
		const receipt = record;
		return this.ports.withRepositoryLock(receipt.repositoryKey, async () => {
			const target = await this.ports.authorize(principal, narratorId, "read", signal);
			assertReady(target, "read", target.workspace.workspaceKey ?? "");
			if (
				target.workspace.repositoryKey !== receipt.repositoryKey ||
				target.workspace.deviceId !== receipt.deviceId ||
				target.backend?.runtimeGeneration !== initial.backend?.runtimeGeneration
			)
				error("WORKTREE_RECOVERY_DENIED", "Recovery repository or execution device changed", 403);
			// The old request cannot turn a narrow current-tree grant into a sibling-directory grant.
			if (
				!target.backend ||
				!target.workspace.rootPath ||
				!target.backend.paths.contains(target.workspace.rootPath, receipt.destination)
			)
				error(
					"WORKTREE_RECOVERY_DENIED",
					"Return to the original or created authorized worktree to recover this receipt",
					403,
				);
			signal.throwIfAborted();
			if (receipt.result && receipt.result.outcome !== "unknown") return receipt.result;
			return this.reconcile(target, receipt);
		});
	}

	async create(
		principal: Principal,
		narratorId: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<WorktreeCreateResult> {
		const request = worktreeCreateSchema.parse(input);
		// Authorize before revision resolution: that runtime path may probe private filesystem state.
		const target = await this.ports.authorize(principal, narratorId, "write", signal);
		assertReady(target, "write", request.workspaceKey);
		const actorKey = this.actorKey(principal);
		return this.ports.withRevision(narratorId, request.expectedRevision, async () => {
			return this.ports.withRepositoryLock(target.workspace.repositoryKey ?? "", async () => {
				let claim: Awaited<ReturnType<WorktreeJournal["claim"]>>;
				try {
					claim = await this.ports.journal.claim(narratorId, request.requestId, {
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
					return {
						outcome: "unknown",
						worktree: null,
						residuals: { destinationExists: null, branchExists: null },
						error: {
							code: "WORKTREE_RECEIPT_UNAVAILABLE",
							message:
								"Cannot establish a durable request receipt; no new creation was dispatched. Keep the same requestId",
						},
					};
				}
				const record = claim.record;
				if (record.actorKey !== actorKey || record.deviceId !== target.workspace.deviceId)
					error(
						"WORKTREE_RECOVERY_DENIED",
						"Request receipt belongs to another actor or device",
						403,
					);
				if (record.repositoryKey !== target.workspace.repositoryKey)
					error("WORKTREE_REQUEST_CONFLICT", "Request receipt belongs to another repository", 409);
				if (!claim.fresh) {
					if (record.result && record.result.outcome !== "unknown") return record.result;
					const result = await this.reconcile(target, record);
					await this.ports.journal
						.save(narratorId, request.requestId, { ...record, result })
						.catch(() => {
							logger.warn("Unable to persist reconciled worktree receipt", {
								narratorId,
								requestId: request.requestId,
								outcome: result.outcome,
							});
						});
					return result;
				}
				let dispatched = false;
				const started = performance.now();
				let result: WorktreeCreateResult;
				try {
					record.destination = await this.requireDestination(
						target,
						request.destinationPath,
						signal,
					);
					const branchName = await this.resolveBranchName(
						principal,
						narratorId,
						request.branch.name,
						undefined,
						createHash("sha256")
							.update(JSON.stringify([narratorId, request.requestId]))
							.digest("hex")
							.slice(0, 10),
						signal,
					);
					record.branchName = branchName;
					const resolved: ResolvedWorktreeRequest = {
						...request,
						branch: { ...request.branch, name: branchName },
					};
					record.expectedHead = await this.verifyBranch(target, resolved, signal);
					await this.ports.journal.save(narratorId, request.requestId, record);
					const fresh = await this.ports.authorize(principal, narratorId, "write", signal);
					assertReady(fresh, "write", request.workspaceKey);
					if (
						fresh.workspace.repositoryKey !== record.repositoryKey ||
						fresh.backend?.runtimeGeneration !== target.backend?.runtimeGeneration
					)
						error("GIT_WORKSPACE_CHANGED", "Repository or backend changed before write", 409);
					await this.verifyIdentity(fresh, signal);
					await this.requireDestination(fresh, record.destination, signal);
					// Durable protection is admitted under the same lock used by storage cleanup.
					// Failure to register means no Git dispatch; uncertain/failed adds stay protected.
					await this.ports.resources?.register({
						ownerNarratorId: narratorId,
						deviceId: record.deviceId ?? "local",
						repositoryKey: record.repositoryKey,
						worktreePath: record.destination,
						createRequestId: request.requestId,
					});
					signal.throwIfAborted();
					const args =
						request.branch.kind === "new"
							? ["worktree", "add", "-b", branchName, "--", record.destination, record.expectedHead]
							: ["worktree", "add", "--", record.destination, branchName];
					dispatched = true;
					const execution = await this.run(fresh, args, signal, true);
					record.commandSucceeded = execution.exitCode === 0;
					result = await this.reconcile(fresh, record);
				} catch (cause) {
					result = dispatched
						? await this.reconcile(target, record)
						: {
								outcome: "failed",
								worktree: null,
								residuals: { destinationExists: null, branchExists: null },
								error: {
									code: cause instanceof AppError ? cause.code : "WORKTREE_VALIDATION_FAILED",
									message:
										cause instanceof AppError
											? cause.message.slice(0, 1024)
											: "Worktree validation failed before Git execution",
								},
							};
				}
				if (dispatched) {
					await this.ports.resources
						?.setState(
							{
								ownerNarratorId: narratorId,
								deviceId: record.deviceId ?? "local",
								repositoryKey: record.repositoryKey,
								worktreePath: record.destination,
								createRequestId: request.requestId,
							},
							result.outcome === "created" ? "ready" : "unknown",
						)
						.catch(() => {
							logger.warn("Worktree inventory state remains protected as preparing", {
								narratorId,
							});
						});
				}
				// A save failure must not turn an already-created worktree into a claimed failure.
				await this.ports.journal
					.save(narratorId, request.requestId, { ...record, result })
					.catch(() => {
						logger.warn("Unable to persist final worktree receipt", {
							narratorId,
							requestId: request.requestId,
							outcome: result.outcome,
						});
					});
				logger.info("Narrator worktree create", {
					narratorId,
					requestId: request.requestId,
					outcome: result.outcome,
					elapsedMs: Math.round(performance.now() - started),
				});
				return result;
			});
		});
	}
}
