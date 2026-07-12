/**
 * Rebuild file contents by replaying successful Write/Edit tool calls from the
 * narrator's first-touch snapshots. File identity is device + target path.
 */
import { isAbsolute, resolve } from "node:path";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narratorFileSnapshots,
	narratorMessageRefs,
	narrators,
	narratorToolCalls,
} from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { replace } from "../lib/agent/tools/edit";

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
	resolvedFilePath?: string | null;
}

export interface DeviceFileIdentity {
	deviceId: string;
	filePath: string;
}

export interface DeviceFileState extends DeviceFileIdentity {
	content: string | null;
}

export function deviceFileKey(identity: DeviceFileIdentity): string {
	return JSON.stringify([identity.deviceId, identity.filePath]);
}

export type FileHistoryErrorCode =
	| "MISSING_EXECUTION_PATH"
	| "MISSING_LOCAL_CWD"
	| "UNSAFE_LEGACY_REMOTE_TARGET";

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

async function resolveLegacyLocalCwd(narratorId: string): Promise<string | null> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true, cwd: true },
	});
	if (!narrator) return null;
	if (!narrator.chapterId) return narrator.cwd ?? null;
	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, narrator.chapterId),
		columns: { worktreePath: true },
	});
	return chapter?.worktreePath ?? null;
}

function canonicalLocalPath(path: string, cwd: string | null): string | null {
	if (isAbsolute(path)) return path;
	return cwd ? resolve(cwd, path) : null;
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
		"toolName" | "inputJson" | "executionDeviceId" | "executionCwd" | "resolvedFilePath"
	>,
	legacyLocalCwd: string | null = null,
): DeviceFileIdentity | null {
	if (toolCall.toolName !== "Write" && toolCall.toolName !== "Edit") return null;
	const input = toolCall.inputJson as Record<string, unknown> | null;
	const legacyInputPath = typeof input?.file_path === "string" ? input.file_path : null;

	if (toolCall.executionDeviceId != null) {
		return toolCall.resolvedFilePath
			? { deviceId: toolCall.executionDeviceId, filePath: toolCall.resolvedFilePath }
			: null;
	}

	const legacyDevice = typeof input?.device === "string" ? input.device : LOCAL_DEVICE_ID;
	if (legacyDevice !== LOCAL_DEVICE_ID || !legacyInputPath) return null;
	const filePath =
		canonicalLocalPath(legacyInputPath, toolCall.executionCwd ?? legacyLocalCwd) ?? legacyInputPath;
	return { deviceId: LOCAL_DEVICE_ID, filePath };
}

export function getToolCallFileIdentityStrict(
	toolCall: Pick<
		OrderedToolCall,
		| "toolUseId"
		| "toolName"
		| "inputJson"
		| "executionDeviceId"
		| "executionCwd"
		| "resolvedFilePath"
	>,
	legacyLocalCwd: string | null,
): DeviceFileIdentity | null {
	if (toolCall.toolName !== "Write" && toolCall.toolName !== "Edit") return null;
	const input = toolCall.inputJson as Record<string, unknown> | null;
	const legacyInputPath = typeof input?.file_path === "string" ? input.file_path : null;

	if (toolCall.executionDeviceId != null) {
		if (!toolCall.resolvedFilePath) {
			throw new FileHistoryError(
				"MISSING_EXECUTION_PATH",
				`Tool call ${toolCall.toolUseId} recorded device ${toolCall.executionDeviceId} without a resolved file path.`,
				toolCall.toolUseId,
			);
		}
		return { deviceId: toolCall.executionDeviceId, filePath: toolCall.resolvedFilePath };
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
	const filePath = canonicalLocalPath(legacyInputPath, toolCall.executionCwd ?? legacyLocalCwd);
	if (!filePath) {
		throw new FileHistoryError(
			"MISSING_LOCAL_CWD",
			`Legacy local tool call ${toolCall.toolUseId} uses relative path ${legacyInputPath} but has no recoverable cwd.`,
			toolCall.toolUseId,
		);
	}
	return { deviceId: LOCAL_DEVICE_ID, filePath };
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
		sql`${narratorToolCalls.toolName} IN ('Write', 'Edit')`,
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
				resolvedFilePath: narratorToolCalls.resolvedFilePath,
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

		return rows.map((row) => ({
			...row,
			inputJson:
				row.filePath != null
					? { file_path: row.filePath, ...(row.device != null && { device: row.device }) }
					: null,
		}));
	}

	return db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
			executionDeviceId: narratorToolCalls.executionDeviceId,
			executionCwd: narratorToolCalls.executionCwd,
			resolvedFilePath: narratorToolCalls.resolvedFilePath,
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
		.orderBy(asc(narratorMessageRefs.seq), asc(narratorToolCalls.createdAt)) as Promise<
		OrderedToolCall[]
	>;
}

/** Apply a single Write/Edit operation to content. */
export function applyToolCall(
	currentContent: string | null,
	toolCall: OrderedToolCall,
): string | null {
	const input = toolCall.inputJson as Record<string, unknown> | null;
	if (!input) return currentContent;

	if (toolCall.toolName === "Write") return (input.content as string) ?? currentContent;

	if (toolCall.toolName === "Edit") {
		const oldString = input.old_string as string | undefined;
		const newString = input.new_string as string | undefined;
		const replaceAll = input.replace_all as boolean | undefined;
		if (newString === undefined) return currentContent;
		if (!oldString) return newString;
		if (currentContent === null) return currentContent;

		try {
			const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n");
			return replace(
				normalizeLineEndings(currentContent),
				normalizeLineEndings(oldString),
				normalizeLineEndings(newString),
				replaceAll,
			).content;
		} catch {
			return currentContent;
		}
	}

	return currentContent;
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

async function loadSnapshotMap(
	narratorId: string,
	legacyLocalCwd: string | null,
): Promise<Map<string, { identity: DeviceFileIdentity; content: string | null }>> {
	const snapshots = await db.query.narratorFileSnapshots.findMany({
		where: eq(narratorFileSnapshots.narratorId, narratorId),
		columns: { deviceId: true, filePath: true, originalContent: true },
	});
	const result = new Map<string, { identity: DeviceFileIdentity; content: string | null }>();
	for (const snapshot of snapshots) {
		let filePath = snapshot.filePath;
		if (snapshot.deviceId === LOCAL_DEVICE_ID && !isAbsolute(filePath)) {
			const canonical = canonicalLocalPath(filePath, legacyLocalCwd);
			if (!canonical) {
				throw new FileHistoryError(
					"MISSING_LOCAL_CWD",
					`Legacy local snapshot ${filePath} has no recoverable cwd.`,
				);
			}
			filePath = canonical;
		}
		const identity = { deviceId: snapshot.deviceId, filePath };
		result.set(deviceFileKey(identity), { identity, content: snapshot.originalContent });
	}
	return result;
}

async function rebuildDeviceStates(
	narratorId: string,
	maxSeq: number | undefined,
	excludeToolUseIds: Set<string>,
	requested?: DeviceFileIdentity[],
): Promise<Map<string, DeviceFileState>> {
	const requestedMap = requested
		? new Map(requested.map((identity) => [deviceFileKey(identity), identity]))
		: null;
	const legacyLocalCwd = await resolveLegacyLocalCwd(narratorId);
	const toolCalls = (await queryOrderedToolCalls(narratorId, maxSeq)).filter(
		(toolCall) => !excludeToolUseIds.has(toolCall.toolUseId),
	);
	const grouped = groupByDeviceFileStrict(toolCalls, legacyLocalCwd);
	const snapshots = await loadSnapshotMap(narratorId, legacyLocalCwd);
	const keys = requestedMap
		? requestedMap.keys()
		: new Set([...snapshots.keys(), ...grouped.keys()]);
	const result = new Map<string, DeviceFileState>();

	for (const key of keys) {
		const identity =
			requestedMap?.get(key) ?? grouped.get(key)?.identity ?? snapshots.get(key)?.identity;
		if (!identity) continue;
		let content = snapshots.get(key)?.content ?? null;
		for (const toolCall of grouped.get(key)?.calls ?? [])
			content = applyToolCall(content, toolCall);
		result.set(key, { ...identity, content });
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
