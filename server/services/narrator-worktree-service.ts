import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { GitWorkspace } from "@shared/git-workspace";
import type { WorktreeListResult, WorktreePrepareResult } from "@shared/narrator-worktrees";
import { z } from "zod/v4";
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

import type {
	VerifiedWorktreeScope,
	WorktreeResourceRegistry,
} from "./narrator-worktree-resources";

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
/** Listing is not the fail-closed inventory used to authorize mutations. */
export const WORKTREE_LIST_MAX_ENTRIES = 4096;
export const WORKTREE_LIST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const WORKTREE_LIST_CACHE_TTL_MS = 60_000;
export const WORKTREE_LIST_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const WORKTREE_LIST_CACHE_MAX_SNAPSHOTS = 16;

type ListSnapshot = {
	binding: string;
	entries: WorktreeEntry[];
	truncated: boolean;
	expiresAt: number;
	bytes: number;
};

type ResolvedWorktreeRequest = Omit<WorktreeCreateRequest, "branch"> & {
	branch: { kind: "new" | "existing"; name: string };
};

export type { WorktreeListResult, WorktreePrepareResult } from "@shared/narrator-worktrees";

/** safeSpawn may append a truncation explanation; structured porcelain must stay byte bounded. */
export function boundWorktreeGitResult(
	result: SafeSpawnResult,
	maxBytes = WORKTREE_MAX_OUTPUT_BYTES,
): SafeSpawnResult {
	const bound = (text: string) => {
		const bytes = Buffer.from(text);
		return bytes.byteLength <= maxBytes
			? text
			: new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
	};
	return {
		...result,
		stdout: bound(result.stdout),
		stderr: bound(result.stderr),
		stdoutTruncated: result.stdoutTruncated || Buffer.byteLength(result.stdout) > maxBytes,
		stderrTruncated: result.stderrTruncated || Buffer.byteLength(result.stderr) > maxBytes,
	};
}

export interface WorktreeTarget {
	workspace: GitWorkspace;
	backend?: ExecutionBackend;
	repositoryPath?: string;
	/** Verified server-side evidence; omitted fixture/legacy registrations stay unknown. */
	resourceScope?: VerifiedWorktreeScope;
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
	/** Tests may shorten (never increase) the best-effort listing metadata deadline. */
	metadataTimeoutMs?: number;
	/** Test seam for directory birthtime; production uses asynchronous lstat, never mtime/ctime. */
	statDirectory?: (path: string) => Promise<Pick<Stats, "birthtimeMs" | "isDirectory">>;
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
	maxEntries = WORKTREE_MAX_ENTRIES,
): {
	entries: WorktreeEntry[];
	truncated: boolean;
} {
	const entries: WorktreeEntry[] = [];
	let entry: WorktreeEntry | null = null;
	for (const field of output.split("\0")) {
		if (field === "") {
			if (entry) {
				if (entries.length === maxEntries) return { entries, truncated: true };
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

/** Old Git prints paths verbatim. Grammar alone cannot distinguish embedded fake records.
 * Only an exact match to independently read registration paths can certify completeness. */
export function parseLegacyWorktreePorcelain(
	output: string,
	truncated = false,
	registeredPaths?: readonly string[],
	pathKey: (path: string) => string = (path) => path,
	maxEntries = WORKTREE_MAX_ENTRIES,
): ReturnType<typeof parseWorktreePorcelain> {
	const entries: WorktreeEntry[] = [];
	const incomplete = { entries: [] as WorktreeEntry[], truncated: true };
	let entry: WorktreeEntry | null = null;
	let hasHead = false;
	let bare = false;
	let hasBranch = false;
	const fields = output.split("\n");
	// The final split token is an end-of-line terminator, not a record separator.
	if (fields.at(-1) === "") fields.pop();
	for (const field of fields) {
		if (field === "") {
			if (entry) {
				if ((!hasHead && !bare) || entries.length === maxEntries) return incomplete;
				entries.push(entry);
				entry = null;
			}
			continue;
		}
		if (field.startsWith("worktree ")) {
			const path = field.slice(9);
			if (entry || !path || path.length > 4096 || path.includes("\0") || path.includes("\r"))
				return incomplete;
			entry = { path, head: null, branch: null, detached: false, locked: false, prunable: false };
			hasHead = false;
			bare = false;
			hasBranch = false;
		} else if (!entry || field.includes("\0")) {
			return incomplete;
		} else if (/^HEAD (?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(field) && !hasHead && !bare) {
			entry.head = field.slice(5);
			hasHead = true;
		} else if (
			field.startsWith("branch refs/") &&
			field.length <= 512 &&
			!/\s/.test(field.slice(7)) &&
			!hasControlCharacters(field.slice(7)) &&
			hasHead &&
			!hasBranch &&
			!entry.detached
		) {
			entry.branch = field.slice(7);
			hasBranch = true;
		} else if (field === "detached" && hasHead && !hasBranch && !entry.detached) {
			entry.detached = true;
		} else if (field === "bare" && !hasHead && !bare) {
			bare = true;
		} else if (
			(field === "locked" || field.startsWith("locked ")) &&
			(hasHead || bare) &&
			!entry.locked
		) {
			entry.locked = true;
		} else if (
			(field === "prunable" || field.startsWith("prunable ")) &&
			(hasHead || bare) &&
			!entry.prunable
		) {
			entry.prunable = true;
		} else {
			return incomplete;
		}
	}
	if (truncated || entry !== null || !output.endsWith("\n\n") || !registeredPaths)
		return incomplete;
	// Reject newlines in raw registrations before comparing platform-specific path identities.
	const registered = new Set(registeredPaths.map(pathKey));
	if (
		registered.size !== registeredPaths.length ||
		entries.length !== registered.size ||
		registeredPaths.some((path) => /[\r\n]/.test(path) || path.includes("\0"))
	)
		return incomplete;
	for (const entry of entries) {
		if (!registered.delete(pathKey(entry.path))) return incomplete;
	}
	return { entries, truncated: false };
}

function worktreeListError(result: SafeSpawnResult): never {
	const detail = result.stderr
		.slice(0, 512)
		.replace(/\p{Cc}/gu, " ")
		.trim();
	error("WORKTREE_LIST_FAILED", `Unable to list Git worktrees${detail ? `: ${detail}` : ""}`, 409);
}

/** Read only the already-authorized common Git directory, never the worktrees themselves.
 * Git 2.34's main path is the common directory with a trailing /.git removed; linked
 * paths are recorded verbatim in worktrees/<id>/gitdir (including prunable targets). */
async function readLegacyRegisteredPaths(
	target: WorktreeTarget,
	signal: AbortSignal,
	maxEntries = WORKTREE_MAX_ENTRIES,
	maxBytes = WORKTREE_MAX_OUTPUT_BYTES,
): Promise<string[]> {
	const paths = target.backend?.paths;
	const common = target.repositoryPath;
	if (!paths || !common || /[\r\n]/.test(common) || common.includes("\0"))
		throw new Error("Invalid legacy Git common directory");
	const registered = [paths.basename(common) === ".git" ? paths.dirname(common) : common];
	const directoryPath = paths.resolve(common, "worktrees");
	signal.throwIfAborted();
	const info = await lstat(directoryPath).catch((cause) => {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw cause;
	});
	signal.throwIfAborted();
	if (!info) return registered;
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		!paths.equals(await realpath(directoryPath), directoryPath)
	)
		throw new Error("Unsafe legacy Git registration directory");
	signal.throwIfAborted();
	const directory = await opendir(directoryPath);
	try {
		let count = 0;
		let totalBytes = 0;
		while (true) {
			signal.throwIfAborted();
			const item = await directory.read();
			signal.throwIfAborted();
			if (!item) break;
			if (++count >= maxEntries || !item.isDirectory() || item.isSymbolicLink())
				throw new Error("Incomplete legacy Git registration inventory");
			const adminPath = paths.resolve(directoryPath, item.name);
			if (!paths.equals(await realpath(adminPath), adminPath))
				throw new Error("Unsafe legacy Git registration entry");
			signal.throwIfAborted();
			const pointerPath = paths.resolve(adminPath, "gitdir");
			const pointerInfo = await lstat(pointerPath);
			signal.throwIfAborted();
			if (!pointerInfo.isFile() || pointerInfo.isSymbolicLink())
				throw new Error("Unsafe legacy Git registration file");
			// Bound reads; the lstat check also rejects symlinks on platforms without NOFOLLOW.
			const file = await open(
				pointerPath,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
			);
			try {
				signal.throwIfAborted();
				const stat = await file.stat();
				signal.throwIfAborted();
				if (
					!stat.isFile() ||
					stat.dev !== pointerInfo.dev ||
					stat.ino !== pointerInfo.ino ||
					stat.size <= 0 ||
					stat.size > 16 * 1024 ||
					totalBytes + stat.size > maxBytes
				)
					throw new Error("Oversized or invalid legacy Git registration file");
				const bytes = new Uint8Array(stat.size + 1);
				const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
				signal.throwIfAborted();
				if (bytesRead !== stat.size) throw new Error("Legacy Git registration changed during read");
				totalBytes += bytesRead;
				// Remove only the file terminator, NOT embedded newlines in the pathname.
				const pointer = new TextDecoder("utf-8", { fatal: true })
					.decode(bytes.subarray(0, bytesRead))
					.replace(/\r?\n$/, "");
				if (
					!paths.isAbsolute(pointer) ||
					paths.basename(pointer) !== ".git" ||
					/[\r\n]/.test(pointer) ||
					pointer.includes("\0")
				)
					throw new Error("Ambiguous legacy Git worktree registration path");
				registered.push(paths.dirname(pointer));
			} finally {
				await file.close();
			}
		}
		return registered;
	} finally {
		await directory.close();
	}
}

/** Bound waiting even when an async filesystem/test adapter cannot cancel its pending IO. */
async function abortableRead<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
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

// Receipts are untrusted filesystem data, not typed service responses. Parse into fresh,
// bounded objects before using them for recovery or exposing a stored result.
const receiptIdentity = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => !hasControlCharacters(value));
const receiptPath = z
	.string()
	.min(1)
	.max(4096)
	.refine(
		(value) => isAbsolute(value) && normalize(value) === value && !hasControlCharacters(value),
	);
const receiptHead = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const receiptBranch = z
	.string()
	.min(1)
	.max(256)
	.refine(
		(value) =>
			!value.startsWith("-") &&
			!/[\s\\~^:?*[]/.test(value) &&
			!hasControlCharacters(value) &&
			!value.includes("..") &&
			!value.includes("@{") &&
			value !== "@" &&
			!value.endsWith(".") &&
			value
				.split("/")
				.every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock")),
	);
const receiptResultSchema = z
	.object({
		outcome: z.enum(["created", "failed", "unknown"]),
		worktree: z
			.object({
				path: receiptPath,
				head: receiptHead.nullable(),
				branch: z
					.string()
					.max(267)
					.refine(
						(value) =>
							value.startsWith("refs/heads/") &&
							receiptBranch.safeParse(value.slice("refs/heads/".length)).success,
					)
					.nullable(),
				detached: z.boolean(),
				locked: z.boolean(),
				prunable: z.boolean(),
				createdAt: z.number().finite().nonnegative().nullable().optional(),
				lastCommitAt: z.number().finite().nonnegative().nullable().optional(),
			})
			.strict()
			.nullable(),
		residuals: z
			.object({ destinationExists: z.boolean().nullable(), branchExists: z.boolean().nullable() })
			.strict(),
		error: z
			.object({ code: receiptIdentity, message: z.string().max(1024) })
			.strict()
			.optional(),
	})
	.strict();
const receiptSchema = z
	.object({
		proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
		request: z.unknown(),
		repositoryKey: receiptIdentity,
		actorKey: receiptIdentity,
		deviceId: receiptIdentity,
		destination: z.string().min(1).max(4096),
		// A claimed receipt can fail validation before resolving either HEAD or branch.
		expectedHead: z.union([z.literal(""), receiptHead]),
		branchName: z.string().min(1).max(256).optional(),
		commandSucceeded: z.boolean().optional(),
		result: receiptResultSchema.optional(),
	})
	.strict();
function validateReceipt(input: unknown, requestId: string): WorktreeJournalRecord {
	const parsed = receiptSchema.safeParse(input);
	if (!parsed.success) error("WORKTREE_RECEIPT_INVALID", "Invalid worktree request receipt", 409);
	const request = worktreeCreateSchema.safeParse(parsed.data.request);
	if (!request.success)
		error("WORKTREE_RECEIPT_INVALID", "Invalid original worktree proposal", 409);
	const record = { ...parsed.data, request: request.data };
	const branchName = record.branchName ?? record.request.branch.name;
	// HEAD is persisted only after all Git/path validation succeeds and before dispatch.
	// An empty HEAD therefore proves this terminal validation failure never ran worktree add.
	// Keep its original typed proposal queryable, but never use it as reconciliation evidence.
	const validationFailure =
		record.result?.outcome === "failed" &&
		record.expectedHead === "" &&
		record.commandSucceeded === undefined &&
		record.result.error !== undefined &&
		record.result.residuals.destinationExists === null &&
		record.result.residuals.branchExists === null;
	if (
		record.request.requestId !== requestId ||
		record.proposalHash !== worktreeProposalHash(record.request) ||
		record.destination !== record.request.destinationPath ||
		(record.branchName !== undefined &&
			record.request.branch.name !== undefined &&
			record.branchName !== record.request.branch.name) ||
		(!validationFailure &&
			(!receiptPath.safeParse(record.destination).success ||
				(record.branchName !== undefined && !receiptBranch.safeParse(record.branchName).success) ||
				(record.request.branch.name !== undefined &&
					!receiptBranch.safeParse(record.request.branch.name).success) ||
				(record.request.baseRef !== undefined &&
					(hasControlCharacters(record.request.baseRef) ||
						/\s/.test(record.request.baseRef) ||
						record.request.baseRef.startsWith("-"))))) ||
		(record.commandSucceeded === true && (!branchName || !record.expectedHead))
	)
		error("WORKTREE_RECEIPT_INVALID", "Inconsistent worktree request receipt", 409);
	const result = record.result;
	if (
		result &&
		(result.outcome === "created"
			? !result.worktree ||
				!branchName ||
				!record.expectedHead ||
				result.worktree.path !== record.destination ||
				result.worktree.head !== record.expectedHead ||
				result.worktree.branch !== `refs/heads/${branchName}` ||
				result.worktree.detached ||
				result.worktree.prunable ||
				result.residuals.destinationExists !== true
			: result.worktree !== null)
	)
		error("WORKTREE_RECEIPT_INVALID", "Inconsistent stored worktree result", 409);
	return record;
}

export class NarratorWorktreeService<Principal> {
	private readonly listCursorSecret = randomUUID();
	private readonly listSnapshots = new Map<string, ListSnapshot>();
	private listCacheBytes = 0;

	constructor(private readonly ports: WorktreeServicePorts<Principal>) {}

	private listCursor(id: string, offset: number): string {
		const token = `${id}:${offset}`;
		const signature = createHmac("sha256", this.listCursorSecret)
			.update(token)
			.digest("hex")
			.slice(0, 32);
		return `${token}:${signature}`;
	}

	private pruneListSnapshots(now: number) {
		for (const [id, snapshot] of this.listSnapshots) {
			if (snapshot.expiresAt <= now) {
				this.listSnapshots.delete(id);
				this.listCacheBytes -= snapshot.bytes;
			}
		}
	}

	private rememberListSnapshot(snapshot: ListSnapshot): string {
		this.pruneListSnapshots(Date.now());
		while (
			this.listSnapshots.size >= WORKTREE_LIST_CACHE_MAX_SNAPSHOTS ||
			this.listCacheBytes + snapshot.bytes > WORKTREE_LIST_CACHE_MAX_BYTES
		) {
			const oldest = this.listSnapshots.entries().next().value;
			if (!oldest) error("WORKTREE_LIST_TOO_LARGE", "List snapshot exceeds cache budget", 413);
			this.listSnapshots.delete(oldest[0]);
			this.listCacheBytes -= oldest[1].bytes;
		}
		const id = randomUUID();
		this.listSnapshots.set(id, snapshot);
		this.listCacheBytes += snapshot.bytes;
		return id;
	}

	private actorKey(principal: Principal): string {
		const key =
			this.ports.principalKey?.(principal) ?? (typeof principal === "string" ? principal : "");
		if (!key || key.length > 256 || hasControlCharacters(key))
			error("WORKTREE_ACTOR_REQUIRED", "A stable authenticated actor is required", 403);
		return key;
	}

	private async run(
		target: WorktreeTarget,
		args: string[],
		signal: AbortSignal,
		writing = false,
		maxBytes = WORKTREE_MAX_OUTPUT_BYTES,
	) {
		if (!target.backend || target.backend.kind !== "local")
			error(
				"WORKTREE_UNSUPPORTED",
				"Only the authorized local backend supports worktree argv",
				409,
			);
		signal.throwIfAborted();
		const operation = this.ports.runGit
			? this.ports.runGit(target, args, signal, writing)
			: safeSpawn({
					cmd: ["git", "--no-optional-locks", "-C", target.workspace.rootPath ?? "", ...args],
					timeout: writing ? WORKTREE_CREATE_TIMEOUT_MS : WORKTREE_READ_TIMEOUT_MS,
					maxOutputBytes: maxBytes,
					killProcessTree: true,
					env: {
						...process.env,
						// Keep the unsupported-option diagnostic stable across server locales.
						LC_ALL: "C",
						GIT_DIR: undefined,
						GIT_COMMON_DIR: undefined,
						GIT_WORK_TREE: undefined,
						GIT_INDEX_FILE: undefined,
					},
					signal,
				});
		const result = writing ? await operation : await abortableRead(operation, signal);
		signal.throwIfAborted();
		return boundWorktreeGitResult(result, maxBytes);
	}

	private async legacyEntries(
		target: WorktreeTarget,
		result: SafeSpawnResult,
		signal: AbortSignal,
		listing = false,
	): Promise<ReturnType<typeof parseWorktreePorcelain>> {
		const incomplete = { entries: [] as WorktreeEntry[], truncated: true };
		if (result.stdoutTruncated || result.stderrTruncated) return incomplete;
		const limited = AbortSignal.any([signal, AbortSignal.timeout(WORKTREE_READ_TIMEOUT_MS)]);
		const started = performance.now();
		let abort: (() => void) | undefined;
		try {
			limited.throwIfAborted();
			const cancelled = new Promise<never>((_resolve, reject) => {
				abort = () => reject(limited.reason);
				limited.addEventListener("abort", abort, { once: true });
				if (limited.aborted) abort();
			});
			// Cancellation bounds the caller's wait. Pending async FS calls drain and close their
			// handles in finally; the scan checks limited before launching each subsequent read.
			const registered = await Promise.race([
				readLegacyRegisteredPaths(
					target,
					limited,
					listing ? WORKTREE_LIST_MAX_ENTRIES : WORKTREE_MAX_ENTRIES,
					listing ? WORKTREE_LIST_MAX_OUTPUT_BYTES : WORKTREE_MAX_OUTPUT_BYTES,
				),
				cancelled,
			]);
			limited.throwIfAborted();
			return parseLegacyWorktreePorcelain(
				result.stdout,
				false,
				registered,
				target.backend?.paths.identityKey,
				listing ? WORKTREE_LIST_MAX_ENTRIES : WORKTREE_MAX_ENTRIES,
			);
		} catch (cause) {
			signal.throwIfAborted();
			logger.warn("Unable to verify legacy Git worktree registrations", {
				reason: String(cause).slice(0, 256),
			});
			return incomplete;
		} finally {
			if (abort) limited.removeEventListener("abort", abort);
			const elapsedMs = Math.round(performance.now() - started);
			if (elapsedMs >= 1000)
				logger.warn("Slow legacy Git registration verification", { elapsedMs });
		}
	}
	private async entries(target: WorktreeTarget, signal: AbortSignal, listing = false) {
		const maxBytes = listing ? WORKTREE_LIST_MAX_OUTPUT_BYTES : WORKTREE_MAX_OUTPUT_BYTES;
		let result = await this.run(
			target,
			["worktree", "list", "--porcelain", "-z"],
			signal,
			false,
			maxBytes,
		);
		let legacy = false;
		// Retry only an explicit unsupported -z diagnostic, never an ordinary Git failure.
		// No capability cache: a server can change/upgrade its Git executable while running.
		if (
			result.exitCode !== 0 &&
			!result.stderrTruncated &&
			/^error: unknown (?:switch|option) [`'"]z['"`]\r?$/m.test(result.stderr)
		) {
			legacy = true;
			result = await this.run(target, ["worktree", "list", "--porcelain"], signal, false, maxBytes);
		}
		if (result.exitCode !== 0) worktreeListError(result);
		if (legacy) return this.legacyEntries(target, result, signal, listing);
		return parseWorktreePorcelain(
			result.stdout,
			!!(result.stdoutTruncated || result.stderrTruncated),
			listing ? WORKTREE_LIST_MAX_ENTRIES : WORKTREE_MAX_ENTRIES,
		);
	}

	/** Best-effort list metadata only; raw entries remain unchanged for creation/reconciliation. */
	private async enrichListEntries(
		target: WorktreeTarget,
		entries: WorktreeEntry[],
		signal: AbortSignal,
	): Promise<void> {
		const metadataTimeout = Math.max(
			1,
			Math.min(this.ports.metadataTimeoutMs ?? WORKTREE_READ_TIMEOUT_MS, WORKTREE_READ_TIMEOUT_MS),
		);
		const metadataSignal = AbortSignal.any([signal, AbortSignal.timeout(metadataTimeout)]);
		for (const entry of entries) {
			entry.createdAt = null;
			entry.lastCommitAt = null;
		}
		const heads = [...new Set(entries.map((entry) => entry.head))].filter(
			(head): head is string =>
				!!head && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(head) && !/^0+$/.test(head),
		);
		const started = performance.now();
		const times = new Map<string, number>();
		const commits = async () => {
			// Bound argv size and source output; one Git child at a time, at most 128 heads per batch.
			for (let offset = 0; offset < heads.length && !metadataSignal.aborted; offset += 128) {
				try {
					const result = await this.run(
						target,
						[
							"show",
							"--no-walk",
							"--no-patch",
							"--format=%H %ct",
							...heads.slice(offset, offset + 128),
							"--",
						],
						metadataSignal,
					);
					if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) continue;
					for (const line of result.stdout.split("\n")) {
						const match = /^(\S+) (\d+)$/.exec(line);
						if (!match) continue;
						const time = Number(match[2]) * 1000;
						if (Number.isSafeInteger(time)) times.set(match[1]?.toLowerCase() ?? "", time);
					}
				} catch {
					// Missing objects or deadline leave only this batch's metadata unknown.
				}
			}
			for (const entry of entries)
				entry.lastCommitAt = times.get(entry.head?.toLowerCase() ?? "") ?? null;
		};
		let next = 0;
		const directories = async () => {
			while (next < entries.length && !metadataSignal.aborted) {
				const entry = entries[next++];
				if (!entry) return;
				let onAbort: (() => void) | undefined;
				try {
					const aborted = new Promise<never>((_resolve, reject) => {
						onAbort = () => reject(metadataSignal.reason);
						metadataSignal.addEventListener("abort", onAbort, { once: true });
						if (metadataSignal.aborted) onAbort();
					});
					const stat = await Promise.race([
						(this.ports.statDirectory ?? lstat)(entry.path),
						aborted,
					]);
					// birthtime approximates directory creation, NOT when Git registered the worktree.
					// Unsupported/zero birthtimes and non-directories are unknown; no mtime/ctime fallback.
					if (stat.isDirectory() && Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0)
						entry.createdAt = stat.birthtimeMs;
				} catch {
					// Prunable/missing paths and unsupported filesystem metadata stay usable.
				} finally {
					if (onAbort) metadataSignal.removeEventListener("abort", onAbort);
				}
			}
		};
		// At most four filesystem reads; after cancellation no replacement reads are launched.
		try {
			await Promise.all([commits(), ...Array.from({ length: 4 }, directories)]);
			signal.throwIfAborted();
		} finally {
			const elapsedMs = Math.round(performance.now() - started);
			if (elapsedMs >= 1000)
				logger.warn("Slow worktree list metadata", {
					elapsedMs,
					entries: entries.length,
					incomplete: metadataSignal.aborted,
				});
		}
	}

	async list(
		principal: Principal,
		narratorId: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<WorktreeListResult> {
		const { workspaceKey, limit, cursor, sort, order, search } = worktreeListSchema.parse(input);
		signal.throwIfAborted();
		const target = await this.ports.authorize(principal, narratorId, "read", signal);
		assertReady(target, "read", workspaceKey);
		const binding = JSON.stringify([
			this.actorKey(principal),
			narratorId,
			target.workspace.repositoryKey,
			target.workspace.deviceId,
			target.repositoryPath,
			target.workspace.rootPath,
			workspaceKey,
			sort,
			order,
			search,
		]);
		this.pruneListSnapshots(Date.now());
		let snapshot: ListSnapshot;
		let id: string | undefined;
		let offset = 0;
		if (cursor) {
			const match = /^([a-f0-9-]{36}):([1-9]\d{0,4}):([a-f0-9]{32})$/.exec(cursor);
			if (!match) error("WORKTREE_CURSOR_INVALID", "Invalid worktree cursor");
			id = match[1] ?? "";
			offset = Number(match[2]);
			const cached = this.listSnapshots.get(id);
			if (!cached)
				error("WORKTREE_CURSOR_EXPIRED", "Worktree cursor expired; reload the first page", 410);
			if (cursor !== this.listCursor(id, offset))
				error("WORKTREE_CURSOR_INVALID", "Cursor signature is invalid");
			if (cached.binding !== binding)
				error(
					"WORKTREE_CURSOR_MISMATCH",
					"Cursor does not match actor, workspace or list query",
					409,
				);
			if (offset >= cached.entries.length)
				error("WORKTREE_CURSOR_INVALID", "Cursor offset is invalid");
			snapshot = cached;
		} else {
			const started = performance.now();
			const listSignal = AbortSignal.any([
				signal,
				AbortSignal.timeout(WORKTREE_READ_TIMEOUT_MS * 2),
			]);
			try {
				const result = await this.entries(target, listSignal, true);
				await this.enrichListEntries(target, result.entries, listSignal);
				const needle = search.toLowerCase();
				const name = (entry: WorktreeEntry) =>
					entry.branch?.replace(/^refs\/heads\//, "") ??
					entry.path.split(/[\\/]/).at(-1) ??
					entry.path;
				const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
				const entries = result.entries
					.filter(
						(entry) =>
							!needle ||
							`${name(entry)}\n${entry.branch ?? ""}\n${entry.path}`.toLowerCase().includes(needle),
					)
					.sort((a, b) => {
						const tie = compareText(name(a), name(b)) || compareText(a.path, b.path);
						if (sort === "name")
							return (
								(order === "asc" ? 1 : -1) * compareText(name(a), name(b)) ||
								compareText(a.path, b.path)
							);
						const left = a[sort] ?? null;
						const right = b[sort] ?? null;
						if (left === null || right === null)
							return left === right ? tie : left === null ? 1 : -1;
						return (order === "asc" ? 1 : -1) * (left - right) || tie;
					});
				listSignal.throwIfAborted();
				snapshot = {
					binding,
					entries,
					truncated: result.truncated,
					expiresAt: Date.now() + WORKTREE_LIST_CACHE_TTL_MS,
					bytes: Buffer.byteLength(JSON.stringify(entries)) + Buffer.byteLength(binding) + 256,
				};
				if (entries.length > limit) id = this.rememberListSnapshot(snapshot);
			} finally {
				const elapsedMs = Math.round(performance.now() - started);
				if (elapsedMs >= 1000) logger.warn("Slow worktree listing", { elapsedMs });
			}
		}
		signal.throwIfAborted();
		const entries = snapshot.entries.slice(offset, offset + limit).map((entry) => ({ ...entry }));
		const hasMore = offset + entries.length < snapshot.entries.length;
		return {
			repositoryKey: target.workspace.repositoryKey,
			hasMore,
			nextCursor: hasMore && id ? this.listCursor(id, offset + entries.length) : null,
			truncated: snapshot.truncated,
			entries,
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

	/** Operation lookup accepts only the tool's stable internal request identifier. */
	async getOperation(
		principal: Principal,
		narratorId: string,
		operationId: string,
		signal: AbortSignal,
	): Promise<WorktreeCreateResult> {
		const target = await this.ports.authorize(principal, narratorId, "read", signal);
		assertReady(target, "read", target.workspace.workspaceKey ?? "");
		this.actorKey(principal);
		if (typeof operationId !== "string" || !/^wt1_[a-f0-9]{64}$/.test(operationId))
			error("WORKTREE_INVALID_OPERATION", "Invalid worktree operation identifier");
		signal.throwIfAborted();
		let record: WorktreeJournalRecord | null;
		try {
			record = await this.ports.journal.read(narratorId, operationId);
		} catch {
			error("WORKTREE_RECEIPT_UNAVAILABLE", "Cannot read the original worktree receipt", 409);
		}
		if (!record) error("WORKTREE_REQUEST_NOT_FOUND", "Worktree request receipt not found", 404);
		const receipt = validateReceipt(record, operationId);
		// Reuse recovery authorization, lock and path scope checks, with the frozen old revision.
		// Recovery validates its independent read again: receipt replacement cannot bypass parsing.
		return this.reconcileRequest(principal, narratorId, receipt.request, signal);
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
		record = validateReceipt(record, request.requestId);
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
				!target.backend.paths.isAbsolute(receipt.destination) ||
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
				const record = claim.fresh
					? claim.record
					: validateReceipt(claim.record, request.requestId);
				if (!claim.fresh && record.proposalHash !== worktreeProposalHash(request))
					error(
						"WORKTREE_REQUEST_CONFLICT",
						"Replay must use the exact original creation proposal",
						409,
					);
				if (record.actorKey !== actorKey || record.deviceId !== target.workspace.deviceId)
					error(
						"WORKTREE_RECOVERY_DENIED",
						"Request receipt belongs to another actor or device",
						403,
					);
				if (record.repositoryKey !== target.workspace.repositoryKey)
					error("WORKTREE_REQUEST_CONFLICT", "Request receipt belongs to another repository", 409);
				if (!claim.fresh) {
					if (
						!target.backend ||
						!target.workspace.rootPath ||
						!target.backend.paths.isAbsolute(record.destination) ||
						!target.backend.paths.contains(target.workspace.rootPath, record.destination)
					)
						error(
							"WORKTREE_RECOVERY_DENIED",
							"Receipt replay requires the original authorized directory scope",
							403,
						);
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
						scope: fresh.resourceScope,
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
