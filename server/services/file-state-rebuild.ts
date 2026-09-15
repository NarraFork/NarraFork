/**
 * Rebuild file contents by replaying successful Write/Edit tool calls from the
 * narrator's first-touch snapshots. File identity is device + target path.
 */
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narratorFileSnapshots,
	narratorMessageRefs,
	narrators,
	narratorToolCalls,
	projects,
} from "../db/schema";
import { LOCAL_DEVICE_ID, type PathFlavor } from "../lib/agent/execution/backend";
import { targetPathSemantics } from "../lib/agent/execution/path-resolve";
import {
	appendAfter,
	deleteRange,
	insertBefore,
	relocateRange,
	replaceRange,
	substituteInRange,
} from "../lib/agent/structural/edit-ops";
import { replace } from "../lib/agent/tools/edit";
import {
	applyLineEnding,
	detectLineEnding,
	normalizeLineEndings,
} from "../lib/agent/tools/encoding";
import { logger } from "../lib/logger";

// Threshold for logging: file state rebuild must be complete for correctness
// (truncation would produce wrong results), so we only warn when queries
// return unusually large result sets to surface potential performance issues.
const TOOL_CALL_WARN_THRESHOLD = 2000;

export interface OrderedToolCall {
	toolUseId: string;
	toolName: string;
	inputJson: unknown;
	status: string;
	messageId: string;
	seq: number;
	createdAt: string;
	executionDeviceId?: string | null;
	executionCwd?: string | null;
	executionPathFlavor?: PathFlavor | null;
	resolvedFilePath?: string | null;
	canonicalFilePath?: string | null;
	runtimeGeneration?: number | null;
	executionTargetsJson?: unknown;
	isFileHistoryCheckpoint?: boolean;
}

export interface DeviceFileIdentity {
	deviceId: string;
	filePath: string;
	pathFlavor?: PathFlavor;
	identityKey?: string;
}

interface NormalizedDeviceFileIdentity extends DeviceFileIdentity {
	pathFlavor: PathFlavor;
	identityKey: string;
}

export interface DeviceFileState extends DeviceFileIdentity {
	content: string | null;
	/**
	 * Charset the baseline snapshot was decoded with. Restoring must re-encode with
	 * it so a legacy-encoded file keeps its charset. Undefined means UTF-8.
	 */
	encoding?: string | null;
}

function inferPathFlavor(filePath: string, cwd: string | null = null): PathFlavor {
	if (filePath.startsWith("spec://")) return "spec";
	if (/^[a-zA-Z]:[\\/]/u.test(filePath) || /^\\\\/u.test(filePath)) return "windows";
	// A backslash in a POSIX absolute path is a literal filename character, not
	// evidence of a Windows separator. Recorded target/alias metadata wins before
	// this fallback is used; never consult the current host OS to interpret history.
	if (filePath.startsWith("/") && !filePath.startsWith("//")) return "posix";
	if (cwd) return inferPathFlavor(cwd);
	if (filePath.includes("\\") || filePath.startsWith("//") || /^[a-zA-Z]:/u.test(filePath)) {
		throw new FileHistoryError(
			"MISSING_EXECUTION_PATH",
			`Ambiguous legacy path ${filePath}: no recorded path flavor, cwd, or canonical alias identifies its target grammar.`,
		);
	}
	return "posix";
}

function pathIdentityKey(filePath: string, pathFlavor: PathFlavor): string {
	const normalized = targetPathSemantics(pathFlavor).normalize(filePath);
	return pathFlavor === "windows" ? normalized.toLowerCase() : normalized;
}

export function normalizeDeviceFileIdentity(
	identity: DeviceFileIdentity,
): NormalizedDeviceFileIdentity {
	const pathFlavor = identity.pathFlavor ?? inferPathFlavor(identity.filePath);
	return {
		deviceId: identity.deviceId,
		filePath: identity.filePath,
		pathFlavor,
		identityKey: identity.identityKey ?? pathIdentityKey(identity.filePath, pathFlavor),
	};
}

export function deviceFileKey(identity: DeviceFileIdentity): string {
	const normalized = normalizeDeviceFileIdentity(identity);
	return JSON.stringify([normalized.deviceId, normalized.pathFlavor, normalized.identityKey]);
}

export type FileHistoryErrorCode =
	| "MISSING_EXECUTION_PATH"
	| "MISSING_LOCAL_CWD"
	| "UNSAFE_LEGACY_REMOTE_TARGET"
	| "REPLAY_DIVERGED";

export class FileHistoryError extends Error {
	constructor(
		public readonly code: FileHistoryErrorCode,
		message: string,
		public readonly toolUseId?: string,
	) {
		super(message);
		this.name = "FileHistoryError";
	}
}

/**
 * Raised when a recorded Write/Edit call can no longer be replayed against the
 * reconstructed baseline (for example its `old_string` is absent because an
 * untracked change happened in between).
 *
 * Replay is only sound while every step applies exactly as recorded. Swallowing
 * a failed step and continuing would silently rebase all later edits onto a
 * wrong baseline and write back a file that matches neither the old nor the new
 * revision, so divergence must abort the rebuild for that file instead.
 */
export class ReplayDivergedError extends FileHistoryError {
	constructor(
		message: string,
		toolUseId: string | undefined,
		public readonly identity: DeviceFileIdentity | null = null,
	) {
		super("REPLAY_DIVERGED", message, toolUseId);
		this.name = "ReplayDivergedError";
	}
}

/**
 * Best-effort cwd used only to canonicalize legacy relative paths.
 *
 * Follows the same order as `resolveNarratorSessionCwd` — explicit `narrator.cwd`
 * first, then the chapter worktree, then the project repo — because these records
 * were written relative to whatever directory the session was actually running in.
 * Resolving them against a different directory would silently point history at the
 * wrong files.
 */
async function resolveLegacyLocalCwd(narratorId: string): Promise<string | null> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true, cwd: true, contextProjectId: true },
	});
	if (!narrator) return null;
	if (narrator.cwd) return narrator.cwd;

	if (narrator.chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { worktreePath: true, projectId: true },
		});
		if (chapter?.worktreePath) return chapter.worktreePath;
		if (chapter?.projectId) {
			const project = await db.query.projects.findFirst({
				where: eq(projects.id, chapter.projectId),
				columns: { gitPath: true },
			});
			if (project?.gitPath) return project.gitPath;
		}
		return null;
	}

	if (narrator.contextProjectId) {
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, narrator.contextProjectId),
			columns: { gitPath: true },
		});
		if (project?.gitPath) return project.gitPath;
	}
	return null;
}

function canonicalLocalPath(
	path: string,
	cwd: string | null,
	pathFlavor = inferPathFlavor(path, cwd),
): string | null {
	const paths = targetPathSemantics(pathFlavor);
	if (paths.isAbsolute(path)) return paths.normalize(path);
	return cwd && paths.isAbsolute(cwd) ? paths.resolve(cwd, path) : null;
}

type FileTargetProjection = Pick<
	OrderedToolCall,
	| "executionDeviceId"
	| "executionCwd"
	| "executionPathFlavor"
	| "resolvedFilePath"
	| "canonicalFilePath"
	| "runtimeGeneration"
	| "executionTargetsJson"
>;

type StoredExecutionTarget = {
	deviceId?: unknown;
	cwd?: unknown;
	pathFlavor?: unknown;
	lexicalPath?: unknown;
	canonicalPath?: unknown;
	runtimeGeneration?: unknown;
	resolvedFilePath?: unknown;
};

function primaryStoredExecutionTarget(value: unknown): StoredExecutionTarget | null {
	let candidate: unknown;
	if (Array.isArray(value)) {
		candidate = value[0];
	} else if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Array.isArray((value as { endpoints?: unknown }).endpoints)
	) {
		const plan = value as {
			primaryKey?: unknown;
			endpoints: Array<{ key?: unknown; target?: unknown }>;
		};
		candidate =
			plan.endpoints.find((endpoint) => endpoint.key === plan.primaryKey)?.target ??
			plan.endpoints[0]?.target;
	} else {
		candidate = value;
	}
	return candidate && typeof candidate === "object" && !Array.isArray(candidate)
		? (candidate as StoredExecutionTarget)
		: null;
}

function fileTargetMetadata(toolCall: FileTargetProjection): {
	deviceId: string | null;
	cwd: string | null;
	pathFlavor: PathFlavor | null;
	lexicalPath: string | null;
	canonicalPath: string | null;
	runtimeGeneration: number | null;
} {
	const stored = primaryStoredExecutionTarget(toolCall.executionTargetsJson);
	const storedFlavor = stored?.pathFlavor;
	const pathFlavor =
		storedFlavor === "posix" || storedFlavor === "windows" || storedFlavor === "spec"
			? storedFlavor
			: (toolCall.executionPathFlavor ?? null);
	const storedLexical =
		typeof stored?.lexicalPath === "string"
			? stored.lexicalPath
			: typeof stored?.resolvedFilePath === "string"
				? stored.resolvedFilePath
				: null;
	return {
		deviceId:
			typeof stored?.deviceId === "string" ? stored.deviceId : (toolCall.executionDeviceId ?? null),
		cwd: typeof stored?.cwd === "string" ? stored.cwd : (toolCall.executionCwd ?? null),
		pathFlavor,
		lexicalPath: storedLexical ?? toolCall.resolvedFilePath ?? null,
		canonicalPath:
			typeof stored?.canonicalPath === "string"
				? stored.canonicalPath
				: (toolCall.canonicalFilePath ?? null),
		runtimeGeneration:
			typeof stored?.runtimeGeneration === "number"
				? stored.runtimeGeneration
				: (toolCall.runtimeGeneration ?? null),
	};
}

/**
 * Dynamic Spec (`spec://`) Write/Edit calls are versioned in the database
 * (`specFileRevisions`) and never touch a real device filesystem — they also
 * skip `ensureFileSnapshot`. They must be excluded from filesystem
 * rebuild/revert entirely; otherwise the revert machinery would try to write
 * or delete a literal `spec://…` path on the local disk (creating junk files)
 * while failing to restore the actual virtual-file content.
 */
function isSpecTarget(
	toolCall: Pick<
		OrderedToolCall,
		| "inputJson"
		| "executionCwd"
		| "executionPathFlavor"
		| "resolvedFilePath"
		| "canonicalFilePath"
		| "executionTargetsJson"
	>,
): boolean {
	const target = fileTargetMetadata(toolCall);
	if (target.pathFlavor === "spec") return true;
	if (target.lexicalPath?.startsWith("spec://")) return true;
	if (target.canonicalPath?.startsWith("spec://")) return true;
	if (target.cwd === "spec://") return true;
	const input = toolCall.inputJson as Record<string, unknown> | null;
	return typeof input?.file_path === "string" && input.file_path.startsWith("spec://");
}

/**
 * Resolve the immutable file identity captured by the executor. Rows without an
 * execution device are legacy rows and are inferred as local from old input only.
 * A known non-local device is never reassigned to local, even if its resolved path
 * is missing.
 */
export function getToolCallFileIdentity(
	toolCall: Pick<
		OrderedToolCall,
		| "toolName"
		| "inputJson"
		| "executionDeviceId"
		| "executionCwd"
		| "executionPathFlavor"
		| "resolvedFilePath"
		| "canonicalFilePath"
		| "runtimeGeneration"
		| "executionTargetsJson"
	>,
	legacyLocalCwd: string | null = null,
): DeviceFileIdentity | null {
	if (toolCall.toolName !== "Write" && toolCall.toolName !== "Edit") return null;
	if (isSpecTarget(toolCall)) return null;
	const input = toolCall.inputJson as Record<string, unknown> | null;
	const legacyInputPath = typeof input?.file_path === "string" ? input.file_path : null;
	const target = fileTargetMetadata(toolCall);

	if (target.deviceId != null) {
		const filePath = target.canonicalPath ?? target.lexicalPath;
		if (!filePath) return null;
		return normalizeDeviceFileIdentity({
			deviceId: target.deviceId,
			filePath,
			pathFlavor: target.pathFlavor ?? inferPathFlavor(filePath, target.cwd),
		});
	}

	const legacyDevice = typeof input?.device === "string" ? input.device : LOCAL_DEVICE_ID;
	if (legacyDevice !== LOCAL_DEVICE_ID || !legacyInputPath) return null;
	const cwd = target.cwd ?? legacyLocalCwd;
	const pathFlavor = target.pathFlavor ?? inferPathFlavor(legacyInputPath, cwd);
	const filePath = canonicalLocalPath(legacyInputPath, cwd, pathFlavor) ?? legacyInputPath;
	return normalizeDeviceFileIdentity({ deviceId: LOCAL_DEVICE_ID, filePath, pathFlavor });
}

export function getToolCallFileIdentityStrict(
	toolCall: Pick<
		OrderedToolCall,
		| "toolUseId"
		| "toolName"
		| "inputJson"
		| "executionDeviceId"
		| "executionCwd"
		| "executionPathFlavor"
		| "resolvedFilePath"
		| "canonicalFilePath"
		| "runtimeGeneration"
		| "executionTargetsJson"
	>,
	legacyLocalCwd: string | null,
): DeviceFileIdentity | null {
	if (toolCall.toolName !== "Write" && toolCall.toolName !== "Edit") return null;
	if (isSpecTarget(toolCall)) return null;
	const input = toolCall.inputJson as Record<string, unknown> | null;
	const legacyInputPath = typeof input?.file_path === "string" ? input.file_path : null;
	const target = fileTargetMetadata(toolCall);

	if (target.deviceId != null) {
		const filePath = target.canonicalPath ?? target.lexicalPath;
		if (!filePath) {
			throw new FileHistoryError(
				"MISSING_EXECUTION_PATH",
				`Tool call ${toolCall.toolUseId} recorded device ${target.deviceId} without a canonical or lexical file path.`,
				toolCall.toolUseId,
			);
		}
		return normalizeDeviceFileIdentity({
			deviceId: target.deviceId,
			filePath,
			pathFlavor: target.pathFlavor ?? inferPathFlavor(filePath, target.cwd),
		});
	}

	const legacyDevice = typeof input?.device === "string" ? input.device : LOCAL_DEVICE_ID;
	if (legacyDevice !== LOCAL_DEVICE_ID) {
		throw new FileHistoryError(
			"UNSAFE_LEGACY_REMOTE_TARGET",
			`Legacy tool call ${toolCall.toolUseId} targeted remote device ${legacyDevice} before its resolved path was persisted.`,
			toolCall.toolUseId,
		);
	}
	if (!legacyInputPath) {
		throw new FileHistoryError(
			"MISSING_EXECUTION_PATH",
			`Tool call ${toolCall.toolUseId} has no file path.`,
			toolCall.toolUseId,
		);
	}
	const cwd = target.cwd ?? legacyLocalCwd;
	const pathFlavor = target.pathFlavor ?? inferPathFlavor(legacyInputPath, cwd);
	const filePath = canonicalLocalPath(legacyInputPath, cwd, pathFlavor);
	if (!filePath) {
		throw new FileHistoryError(
			"MISSING_LOCAL_CWD",
			`Legacy local tool call ${toolCall.toolUseId} uses relative path ${legacyInputPath} but has no recoverable cwd.`,
			toolCall.toolUseId,
		);
	}
	return normalizeDeviceFileIdentity({ deviceId: LOCAL_DEVICE_ID, filePath, pathFlavor });
}

/** Query successful Write/Edit calls ordered by message seq and creation time. */
export async function queryOrderedToolCalls(
	narratorId: string,
	maxSeq?: number,
	opts?: { filePathOnly?: boolean },
): Promise<OrderedToolCall[]> {
	const conditions = [
		eq(narratorToolCalls.narratorId, narratorId),
		eq(narratorToolCalls.status, "success"),
		or(
			sql`${narratorToolCalls.toolName} IN ('Write', 'Edit')`,
			eq(narratorToolCalls.isFileHistoryCheckpoint, true),
		),
	];
	if (maxSeq !== undefined) conditions.push(lte(narratorMessageRefs.seq, maxSeq));

	if (opts?.filePathOnly) {
		const rows = await db
			.select({
				toolUseId: narratorToolCalls.toolUseId,
				toolName: narratorToolCalls.toolName,
				filePath: sql<
					string | null
				>`CASE WHEN json_valid(${narratorToolCalls.inputJson}) THEN json_extract(${narratorToolCalls.inputJson}, '$.file_path') END`,
				device: sql<
					string | null
				>`CASE WHEN json_valid(${narratorToolCalls.inputJson}) THEN json_extract(${narratorToolCalls.inputJson}, '$.device') END`,
				executionDeviceId: narratorToolCalls.executionDeviceId,
				executionCwd: narratorToolCalls.executionCwd,
				executionPathFlavor: narratorToolCalls.executionPathFlavor,
				resolvedFilePath: narratorToolCalls.resolvedFilePath,
				canonicalFilePath: narratorToolCalls.canonicalFilePath,
				runtimeGeneration: narratorToolCalls.runtimeGeneration,
				executionTargetsJson: narratorToolCalls.executionTargetsJson,
				isFileHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
				status: narratorToolCalls.status,
				messageId: narratorToolCalls.messageId,
				seq: narratorMessageRefs.seq,
				createdAt: narratorToolCalls.createdAt,
			})
			.from(narratorToolCalls)
			.innerJoin(
				narratorMessageRefs,
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
				),
			)
			.where(and(...conditions))
			.orderBy(asc(narratorMessageRefs.seq), asc(narratorToolCalls.createdAt));

		if (rows.length >= TOOL_CALL_WARN_THRESHOLD) {
			logger.warn("queryOrderedToolCalls returned large result set", {
				narratorId,
				count: rows.length,
				threshold: TOOL_CALL_WARN_THRESHOLD,
			});
		}

		return rows.map((row) => ({
			...row,
			inputJson:
				row.filePath != null
					? { file_path: row.filePath, ...(row.device != null && { device: row.device }) }
					: null,
		}));
	}

	const rows = (await db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
			executionDeviceId: narratorToolCalls.executionDeviceId,
			executionCwd: narratorToolCalls.executionCwd,
			executionPathFlavor: narratorToolCalls.executionPathFlavor,
			resolvedFilePath: narratorToolCalls.resolvedFilePath,
			canonicalFilePath: narratorToolCalls.canonicalFilePath,
			runtimeGeneration: narratorToolCalls.runtimeGeneration,
			executionTargetsJson: narratorToolCalls.executionTargetsJson,
			isFileHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
			status: narratorToolCalls.status,
			messageId: narratorToolCalls.messageId,
			seq: narratorMessageRefs.seq,
			createdAt: narratorToolCalls.createdAt,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(and(...conditions))
		.orderBy(asc(narratorMessageRefs.seq), asc(narratorToolCalls.createdAt))) as OrderedToolCall[];

	if (rows.length >= TOOL_CALL_WARN_THRESHOLD) {
		logger.warn("queryOrderedToolCalls returned large result set", {
			narratorId,
			count: rows.length,
			threshold: TOOL_CALL_WARN_THRESHOLD,
		});
	}

	return rows;
}

/**
 * Apply a single Write/Edit operation to content.
 *
 * Throws {@link ReplayDivergedError} when the recorded call cannot be applied to
 * `currentContent`. Callers that rebuild file state must treat that as "this
 * file is not reconstructable" rather than falling back to the pre-call
 * content, which would corrupt the result (see the class doc for why).
 *
 * This is legacy_unverified text reconstruction, not byte-exact recovery. EOL
 * parity with today's tools cannot recover a stripped BOM, lossy decoding,
 * historical executor differences, or writes absent from the recorded history.
 */
export function applyToolCall(
	currentContent: string | null,
	toolCall: OrderedToolCall,
): string | null {
	const input = toolCall.inputJson as Record<string, unknown> | null;
	if (!input) return currentContent;

	if (toolCall.toolName === "Write") {
		const content = input.content;
		if (typeof content !== "string") {
			throw new ReplayDivergedError(
				`Write call ${toolCall.toolUseId} has no recorded content to replay.`,
				toolCall.toolUseId,
			);
		}
		return applyLineEnding(
			normalizeLineEndings(content),
			detectLineEnding(currentContent ?? content),
		);
	}

	if (toolCall.toolName === "Edit") {
		const oldString = input.old_string as string | undefined;
		const newString = input.new_string as string | undefined;
		const replaceAll = input.replace_all as boolean | undefined;
		if (typeof newString !== "string") {
			throw new ReplayDivergedError(
				`Edit call ${toolCall.toolUseId} has no recorded new_string to replay.`,
				toolCall.toolUseId,
			);
		}
		// An empty old_string is the tool's create/overwrite mode: the Edit tool
		// writes new_string as the whole file body (edit.ts create-new-file mode).
		if (oldString === undefined || oldString === "") {
			return applyLineEnding(
				normalizeLineEndings(newString),
				detectLineEnding(currentContent ?? newString),
			);
		}
		if (currentContent === null) {
			throw new ReplayDivergedError(
				`Edit call ${toolCall.toolUseId} expects existing content but the baseline is missing.`,
				toolCall.toolUseId,
			);
		}

		try {
			const result = replace(
				normalizeLineEndings(currentContent),
				normalizeLineEndings(oldString),
				normalizeLineEndings(newString),
				replaceAll,
			);
			return applyLineEnding(result.content, detectLineEnding(currentContent));
		} catch (error) {
			throw new ReplayDivergedError(
				`Edit call ${toolCall.toolUseId} no longer applies to the reconstructed content: ` +
					`${error instanceof Error ? error.message : String(error)}`,
				toolCall.toolUseId,
			);
		}
	}

	if (toolCall.toolName === "StructSed") {
		return applyStructSedCall(currentContent, toolCall, input);
	}

	return currentContent;
}

/**
 * Replay a StructSed mutation from its recorded input.
 *
 * Replays by the RESOLVED LINE RANGE the tool stored, never by re-running `locate`: the
 * reconstructed content differs from what the tool saw, a same-named symbol may have moved,
 * and the machine doing the rebuild may not even have the grammar installed. The range is
 * the only address that still means the same thing here.
 *
 * Every failure path throws. Returning `currentContent` for something unreplayable is how
 * a rollback silently produces a file in which this edit never happened — the surrounding
 * Write/Edit calls would still replay, so the result looks plausible and is wrong.
 */
function applyStructSedCall(
	currentContent: string | null,
	toolCall: OrderedToolCall,
	input: Record<string, unknown>,
): string | null {
	const command = input.command;
	const startLine = input.resolvedStartLine;
	const endLine = input.resolvedEndLine;
	if (typeof command !== "string") {
		throw new ReplayDivergedError(
			`StructSed call ${toolCall.toolUseId} has no recorded command to replay.`,
			toolCall.toolUseId,
		);
	}
	if (typeof startLine !== "number" || typeof endLine !== "number") {
		throw new ReplayDivergedError(
			`StructSed call ${toolCall.toolUseId} has no recorded line range to replay.`,
			toolCall.toolUseId,
		);
	}
	if (currentContent === null) {
		throw new ReplayDivergedError(
			`StructSed call ${toolCall.toolUseId} expects existing content but the baseline is missing.`,
			toolCall.toolUseId,
		);
	}

	const content = normalizeLineEndings(currentContent);
	const range = { startLine, endLine };
	try {
		switch (command) {
			case "delete":
				return applyLineEnding(deleteRange(content, range), detectLineEnding(currentContent));
			case "copy":
			case "move": {
				// The destination travelled resolved, like the source. Its absence is a real
				// state (append at end of file), not missing data, so it does not diverge.
				const toStart = input.resolvedToStartLine;
				const toEnd = input.resolvedToEndLine;
				const hasAnchor = typeof toStart === "number" && typeof toEnd === "number";
				const next = relocateRange(content, range, {
					...(hasAnchor ? { anchor: { startLine: toStart, endLine: toEnd } } : {}),
					placement: input.placement === "before" ? "before" : "after",
					removeSource: command === "move",
				});
				return applyLineEnding(next, detectLineEnding(currentContent));
			}
			case "replace":
			case "insert":
			case "append": {
				const text = input.content;
				if (typeof text !== "string") {
					throw new ReplayDivergedError(
						`StructSed ${command} call ${toolCall.toolUseId} has no recorded content to replay.`,
						toolCall.toolUseId,
					);
				}
				const normalized = normalizeLineEndings(text);
				const next =
					command === "replace"
						? replaceRange(content, range, normalized)
						: command === "insert"
							? insertBefore(content, range, normalized)
							: appendAfter(content, range, normalized);
				return applyLineEnding(next, detectLineEnding(currentContent));
			}
			case "substitute": {
				const pattern = input.pattern;
				const replacement = input.replacement;
				if (typeof pattern !== "string" || typeof replacement !== "string") {
					throw new ReplayDivergedError(
						`StructSed substitute call ${toolCall.toolUseId} has no recorded pattern/replacement to replay.`,
						toolCall.toolUseId,
					);
				}
				const result = substituteInRange(content, range, pattern, replacement, {
					...(typeof input.flags === "string" ? { flags: input.flags } : {}),
				});
				return applyLineEnding(result.text, detectLineEnding(currentContent));
			}
			default:
				throw new ReplayDivergedError(
					`StructSed call ${toolCall.toolUseId} has an unknown command "${command}".`,
					toolCall.toolUseId,
				);
		}
	} catch (error) {
		if (error instanceof ReplayDivergedError) throw error;
		// An out-of-range line range means the reconstructed content no longer matches
		// what the tool edited, which is divergence, not a recoverable condition.
		throw new ReplayDivergedError(
			`StructSed call ${toolCall.toolUseId} no longer applies to the reconstructed content: ` +
				`${error instanceof Error ? error.message : String(error)}`,
			toolCall.toolUseId,
		);
	}
}

/** Device-aware grouping used by all rebuild operations. */
export function groupByDeviceFile(
	toolCalls: OrderedToolCall[],
	legacyLocalCwd: string | null = null,
): Map<string, { identity: DeviceFileIdentity; calls: OrderedToolCall[] }> {
	const groups = new Map<string, { identity: DeviceFileIdentity; calls: OrderedToolCall[] }>();
	for (const toolCall of toolCalls) {
		const identity = getToolCallFileIdentity(toolCall, legacyLocalCwd);
		if (!identity) continue;
		const key = deviceFileKey(identity);
		const group = groups.get(key) ?? { identity, calls: [] };
		group.calls.push(toolCall);
		groups.set(key, group);
	}
	return groups;
}

export function groupByDeviceFileStrict(
	toolCalls: OrderedToolCall[],
	legacyLocalCwd: string | null,
): Map<string, { identity: DeviceFileIdentity; calls: OrderedToolCall[] }> {
	const groups = new Map<string, { identity: DeviceFileIdentity; calls: OrderedToolCall[] }>();
	for (const toolCall of toolCalls) {
		const identity = getToolCallFileIdentityStrict(toolCall, legacyLocalCwd);
		if (!identity) continue;
		const key = deviceFileKey(identity);
		const group = groups.get(key) ?? { identity, calls: [] };
		group.calls.push(toolCall);
		groups.set(key, group);
	}
	return groups;
}

/** Legacy/local projection retained for the existing Git UI. */
export function groupByFile(toolCalls: OrderedToolCall[]): Map<string, OrderedToolCall[]> {
	const groups = new Map<string, OrderedToolCall[]>();
	for (const group of groupByDeviceFile(toolCalls).values()) {
		if (group.identity.deviceId === LOCAL_DEVICE_ID) {
			groups.set(group.identity.filePath, group.calls);
		}
	}
	return groups;
}

interface SnapshotBaseline {
	identity: DeviceFileIdentity;
	content: string | null;
	encoding: string | null;
	isBinary: boolean;
}

/**
 * Build the lexical/canonical → canonical identity alias map for a tool-call set.
 *
 * This is a full pass over `toolCalls`, so callers that need to canonicalize more
 * than one identity against the same set must build the map ONCE and reuse it via
 * {@link canonicalizeDeviceFileIdentityWith}. Calling
 * {@link canonicalizeDeviceFileIdentity} inside a loop rebuilds this map per
 * iteration and turns the caller into O(identities × toolCalls) of synchronous
 * work on the JS main thread — measured at 4.3s of event-loop freeze for a
 * 1436-snapshot × 7213-tool-call narrator versus 3.8ms when hoisted.
 */
export function buildCanonicalIdentityAliases(
	toolCalls: OrderedToolCall[],
	legacyLocalCwd: string | null,
): Map<string, DeviceFileIdentity> {
	const aliases = new Map<string, DeviceFileIdentity>();
	const canonicalEvidence = new Set<string>();
	for (const toolCall of toolCalls) {
		const identity = getToolCallFileIdentity(toolCall, legacyLocalCwd);
		if (!identity) continue;
		const normalizedIdentity = normalizeDeviceFileIdentity(identity);
		const target = fileTargetMetadata(toolCall);
		const aliasPaths = [
			target.lexicalPath,
			target.canonicalPath,
			normalizedIdentity.filePath,
		].filter((path): path is string => !!path);
		for (const aliasPath of aliasPaths) {
			const alias = normalizeDeviceFileIdentity({
				deviceId: normalizedIdentity.deviceId,
				filePath: aliasPath,
				pathFlavor: normalizedIdentity.pathFlavor,
			});
			const key = deviceFileKey(alias);
			const previous = aliases.get(key);
			if (previous && deviceFileKey(previous) !== deviceFileKey(normalizedIdentity)) {
				// Lexical-only legacy rows are not evidence that a path is canonical.
				// They must not contradict or overwrite a recorded canonical mapping,
				// regardless of which kind of row was seen first.
				if (canonicalEvidence.has(key) && !target.canonicalPath) continue;
				if (canonicalEvidence.has(key) || !target.canonicalPath) {
					throw new FileHistoryError(
						"MISSING_EXECUTION_PATH",
						`Ambiguous legacy path ${aliasPath} on device ${identity.deviceId}: recorded canonical aliases disagree.`,
						toolCall.toolUseId,
					);
				}
			}
			aliases.set(key, normalizedIdentity);
			if (target.canonicalPath) canonicalEvidence.add(key);
		}
	}
	return aliases;
}

/** Resolve recorded evidence before guessing the grammar of a legacy snapshot. */
function findCanonicalIdentityAlias(
	identity: DeviceFileIdentity,
	canonicalAliases: Map<string, DeviceFileIdentity>,
): DeviceFileIdentity | undefined {
	const flavors: PathFlavor[] = identity.pathFlavor
		? [identity.pathFlavor]
		: identity.filePath.startsWith("spec://")
			? ["spec"]
			: ["posix", "windows"];
	let match: DeviceFileIdentity | undefined;
	for (const pathFlavor of flavors) {
		const candidate = canonicalAliases.get(deviceFileKey({ ...identity, pathFlavor }));
		if (!candidate) continue;
		if (match && deviceFileKey(match) !== deviceFileKey(candidate)) {
			throw new FileHistoryError(
				"MISSING_EXECUTION_PATH",
				`Ambiguous legacy path ${identity.filePath} on device ${identity.deviceId}: recorded path flavors disagree.`,
			);
		}
		match = candidate;
	}
	return match;
}

/**
 * Canonicalize one identity against a pre-built alias map.
 *
 * Prefer this over {@link canonicalizeDeviceFileIdentity} whenever more than one
 * identity is resolved against the same tool-call set: the caller pays for the
 * alias map once instead of once per identity.
 */
export function canonicalizeDeviceFileIdentityWith(
	identity: DeviceFileIdentity,
	canonicalAliases: Map<string, DeviceFileIdentity>,
): DeviceFileIdentity {
	return (
		findCanonicalIdentityAlias(identity, canonicalAliases) ?? normalizeDeviceFileIdentity(identity)
	);
}

/**
 * Canonicalize a single identity, building the alias map on the fly.
 *
 * Only use this for genuinely one-shot resolutions. In a loop, hoist
 * {@link buildCanonicalIdentityAliases} out and call
 * {@link canonicalizeDeviceFileIdentityWith} instead.
 */
export function canonicalizeDeviceFileIdentity(
	identity: DeviceFileIdentity,
	toolCalls: OrderedToolCall[],
	legacyLocalCwd: string | null = null,
): DeviceFileIdentity {
	return canonicalizeDeviceFileIdentityWith(
		identity,
		buildCanonicalIdentityAliases(toolCalls, legacyLocalCwd),
	);
}

async function loadSnapshotMap(
	narratorId: string,
	legacyLocalCwd: string | null,
	canonicalAliases: Map<string, DeviceFileIdentity>,
): Promise<Map<string, SnapshotBaseline>> {
	const snapshots = await db.query.narratorFileSnapshots.findMany({
		where: eq(narratorFileSnapshots.narratorId, narratorId),
		orderBy: narratorFileSnapshots.createdAt,
		columns: {
			deviceId: true,
			filePath: true,
			originalContent: true,
			originalEncoding: true,
			isBinary: true,
		},
	});
	if (snapshots.length >= TOOL_CALL_WARN_THRESHOLD) {
		logger.warn("loadSnapshotMap returned large result set", {
			narratorId,
			count: snapshots.length,
			threshold: TOOL_CALL_WARN_THRESHOLD,
		});
	}
	const result = new Map<string, SnapshotBaseline>();
	for (const snapshot of snapshots) {
		// Snapshot rows predate pathFlavor. Probe both grammars against durable
		// execution metadata first, including calls excluded from this replay.
		let identity = findCanonicalIdentityAlias(snapshot, canonicalAliases);
		if (!identity) {
			const cwd = snapshot.deviceId === LOCAL_DEVICE_ID ? legacyLocalCwd : null;
			const pathFlavor = inferPathFlavor(snapshot.filePath, cwd);
			const filePath =
				snapshot.deviceId === LOCAL_DEVICE_ID
					? canonicalLocalPath(snapshot.filePath, cwd, pathFlavor)
					: snapshot.filePath;
			if (!filePath) {
				throw new FileHistoryError(
					"MISSING_LOCAL_CWD",
					`Legacy local snapshot ${snapshot.filePath} has no recoverable cwd.`,
				);
			}
			identity = canonicalizeDeviceFileIdentityWith(
				{ deviceId: snapshot.deviceId, filePath, pathFlavor },
				canonicalAliases,
			);
		}
		const key = deviceFileKey(identity);
		if (!result.has(key)) {
			result.set(key, {
				identity,
				content: snapshot.originalContent,
				encoding: snapshot.originalEncoding,
				isBinary: snapshot.isBinary,
			});
		}
	}
	return result;
}

async function rebuildDeviceStates(
	narratorId: string,
	maxSeq: number | undefined,
	excludeToolUseIds: Set<string>,
	requested?: DeviceFileIdentity[],
): Promise<Map<string, DeviceFileState>> {
	const legacyLocalCwd = await resolveLegacyLocalCwd(narratorId);
	const orderedToolCalls = await queryOrderedToolCalls(narratorId, maxSeq);
	// Alias resolution must include excluded calls: when reverting the first mutation of a
	// symlink/junction path, that call may be the only durable lexical → canonical mapping
	// that connects the legacy snapshot row to the requested canonical identity.
	const canonicalAliases = buildCanonicalIdentityAliases(orderedToolCalls, legacyLocalCwd);
	const toolCalls = orderedToolCalls.filter(
		(toolCall) => !excludeToolUseIds.has(toolCall.toolUseId),
	);
	const requestedMap = requested
		? new Map(
				requested.map((requestedIdentity) => {
					const identity = canonicalizeDeviceFileIdentityWith(requestedIdentity, canonicalAliases);
					return [deviceFileKey(identity), identity] as const;
				}),
			)
		: null;
	const grouped = groupByDeviceFileStrict(toolCalls, legacyLocalCwd);
	const result = new Map<string, DeviceFileState>();
	if ((requestedMap ?? grouped).size === 0) return result;
	const snapshots = await loadSnapshotMap(narratorId, legacyLocalCwd, canonicalAliases);
	// First-touch capture precedes Edit matching, so a snapshot alone does not
	// prove any successful mutation. Default "all" includes only successful calls;
	// explicit requests may still retrieve the baseline after excluding first Write.
	const keys = requestedMap ? requestedMap.keys() : grouped.keys();

	for (const key of keys) {
		const baseline = snapshots.get(key);
		const identity = requestedMap?.get(key) ?? grouped.get(key)?.identity ?? baseline?.identity;
		if (!identity) continue;
		// A binary baseline cannot be reproduced from stored text: the decode/encode
		// round trip is lossy, so replaying onto it would write corrupted bytes.
		if (baseline?.isBinary) {
			throw new ReplayDivergedError(
				`File ${identity.filePath} was recorded as binary and cannot be rebuilt from a text snapshot.`,
				undefined,
				identity,
			);
		}
		let content = baseline?.content ?? null;
		for (const toolCall of grouped.get(key)?.calls ?? []) {
			try {
				content = applyToolCall(content, toolCall);
			} catch (error) {
				// Re-raise with the file identity attached so callers can report which
				// file is unreconstructable instead of only naming the tool call.
				if (error instanceof ReplayDivergedError) {
					throw new ReplayDivergedError(error.message, error.toolUseId, identity);
				}
				throw error;
			}
		}
		result.set(key, { ...identity, content, encoding: baseline?.encoding ?? null });
	}
	return result;
}

/** Rebuild one device/path state. */
export async function rebuildDeviceFileState(
	narratorId: string,
	identity: DeviceFileIdentity,
	maxSeq?: number,
): Promise<string | null> {
	return (
		(await rebuildDeviceStates(narratorId, maxSeq, new Set(), [identity])).get(
			deviceFileKey(identity),
		)?.content ?? null
	);
}

/** Legacy local helper retained for API compatibility. */
export async function rebuildFileState(
	narratorId: string,
	filePath: string,
	maxSeq?: number,
): Promise<string | null> {
	return rebuildDeviceFileState(narratorId, { deviceId: LOCAL_DEVICE_ID, filePath }, maxSeq);
}

export async function rebuildFileStatesAtMessage(
	narratorId: string,
	messageId: string,
): Promise<Map<string, string | null>> {
	const ref = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
		columns: { seq: true },
	});
	return ref ? rebuildFileStatesUpToSeq(narratorId, ref.seq) : new Map();
}

/** Device-aware state at a sequence boundary. */
export async function rebuildDeviceFileStatesUpToSeq(
	narratorId: string,
	maxSeq: number,
): Promise<Map<string, DeviceFileState>> {
	return rebuildDeviceStates(narratorId, maxSeq, new Set());
}

/** Legacy/local projection retained for chapter fork and Git UI callers. */
export async function rebuildFileStatesUpToSeq(
	narratorId: string,
	maxSeq: number,
): Promise<Map<string, string | null>> {
	const states = await rebuildDeviceFileStatesUpToSeq(narratorId, maxSeq);
	return new Map(
		[...states.values()]
			.filter((state) => state.deviceId === LOCAL_DEVICE_ID)
			.map((state) => [state.filePath, state.content]),
	);
}

/** Rebuild selected device/path states while excluding tool calls. */
export async function rebuildDeviceFileStatesExcluding(
	narratorId: string,
	files: DeviceFileIdentity[],
	excludeToolUseIds: Set<string>,
): Promise<Map<string, DeviceFileState>> {
	if (files.length === 0) return new Map();
	return rebuildDeviceStates(narratorId, undefined, excludeToolUseIds, files);
}

/** Legacy/local projection retained for current local-only routes. */
export async function rebuildFileStatesExcluding(
	narratorId: string,
	filePaths: string[],
	excludeToolUseIds: Set<string>,
): Promise<Map<string, string | null>> {
	const states = await rebuildDeviceFileStatesExcluding(
		narratorId,
		filePaths.map((filePath) => ({ deviceId: LOCAL_DEVICE_ID, filePath })),
		excludeToolUseIds,
	);
	return new Map([...states.values()].map((state) => [state.filePath, state.content]));
}

/** Device-aware affected file list, preserving same-path isolation between devices. */
export function getAffectedDeviceFiles(
	toolCalls: Array<{
		toolUseId?: string;
		toolName: string;
		inputJson: unknown;
		executionDeviceId?: string | null;
		executionCwd?: string | null;
		resolvedFilePath?: string | null;
	}>,
	legacyLocalCwd: string | null = null,
): DeviceFileIdentity[] {
	const files = new Map<string, DeviceFileIdentity>();
	for (const toolCall of toolCalls) {
		const identity = getToolCallFileIdentity(toolCall, legacyLocalCwd);
		if (identity) files.set(deviceFileKey(identity), identity);
	}
	return [...files.values()];
}

export function getAffectedDeviceFilesStrict(
	toolCalls: Array<{
		toolUseId: string;
		toolName: string;
		inputJson: unknown;
		executionDeviceId?: string | null;
		executionCwd?: string | null;
		resolvedFilePath?: string | null;
	}>,
	legacyLocalCwd: string | null,
): DeviceFileIdentity[] {
	const files = new Map<string, DeviceFileIdentity>();
	for (const toolCall of toolCalls) {
		const identity = getToolCallFileIdentityStrict(toolCall, legacyLocalCwd);
		if (identity) files.set(deviceFileKey(identity), identity);
	}
	return [...files.values()];
}

/** Legacy local affected path list. */
export function getAffectedFiles(
	toolCalls: Array<{
		toolName: string;
		inputJson: unknown;
		executionDeviceId?: string | null;
		executionCwd?: string | null;
		resolvedFilePath?: string | null;
	}>,
): string[] {
	return getAffectedDeviceFiles(toolCalls)
		.filter((identity) => identity.deviceId === LOCAL_DEVICE_ID)
		.map((identity) => identity.filePath);
}
