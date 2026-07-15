import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
	narratorFileSnapshots,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	remoteDevices,
} from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { setRemoteBackendResolver } from "../lib/agent/execution/registry";
import { executeTool, freezeToolExecutionTarget } from "../lib/agent/tool-executor";
import {
	confirmTaskReflection,
	createTaskReflectionDecision,
	markTaskReflectionStarted,
} from "../lib/agent/tools/task-reflection";
import type { AgentConfig, AgentToolUse } from "../lib/agent/types";
import { generateId } from "../lib/id";
import { ensureFileSnapshot } from "./file-snapshot-service";
import {
	deviceFileKey,
	getToolCallFileIdentity,
	getToolCallFileIdentityStrict,
	groupByDeviceFileStrict,
	queryOrderedToolCalls,
	rebuildDeviceFileStatesUpToSeq,
} from "./file-state-rebuild";
import { narratorService } from "./narrator-service";
import {
	commitSnapshotRevert,
	revertPatchForToolUse,
	revertPatchForToolUses,
} from "./snapshot-revert";

const createdNarrators: string[] = [];
const createdRemoteDevices: string[] = [];
const createdProjects: string[] = [];
const tempDirs: string[] = [];

async function createMemoryBackend(
	deviceId: string,
	initial: Record<string, string>,
	failWriteOnceFor?: string,
	registration?: { scope: "global" | "project"; projectId?: string },
): Promise<{
	backend: ExecutionBackend;
	readText(path: string): string | null;
	has(path: string): boolean;
	removeCalls: string[];
}> {
	const now = new Date().toISOString();
	await db.insert(remoteDevices).values({
		id: deviceId,
		name: deviceId,
		slug: `${deviceId}-${generateId()}`,
		tokenHash: "test-token-hash",
		tokenPrefix: "test",
		status: "online",
		scope: registration?.scope ?? "global",
		projectId: registration?.projectId ?? null,
		createdBy: "test",
		createdAt: now,
		updatedAt: now,
	});
	createdRemoteDevices.push(deviceId);
	const files = new Map(
		Object.entries(initial).map(([path, content]) => [path, new TextEncoder().encode(content)]),
	);
	let remainingWriteFailures = failWriteOnceFor ? 1 : 0;
	const removeCalls: string[] = [];
	const backend = {
		deviceId,
		kind: "remote",
		platform: { os: "linux", arch: "x64" },
		defaultCwd: "/remote/work",
		async statFile(path: string) {
			const bytes = files.get(path);
			return bytes ? { isDirectory: false, isFile: true, size: bytes.byteLength } : null;
		},
		async readFileBytes(path: string) {
			const bytes = files.get(path);
			if (!bytes) throw new Error(`missing ${path}`);
			return {
				bytes: Uint8Array.from(bytes),
				truncated: false,
				totalSize: bytes.byteLength,
			};
		},
		async writeFileBytes(path: string, bytes: Uint8Array) {
			if (path === failWriteOnceFor && remainingWriteFailures > 0) {
				remainingWriteFailures--;
				throw new Error(`injected write failure for ${path}`);
			}
			files.set(path, Uint8Array.from(bytes));
		},
		async removeFile(path: string) {
			removeCalls.push(path);
			files.delete(path);
		},
		async mkdirp() {},
		async fileExists(path: string) {
			return files.has(path);
		},
		async listDir() {
			return [];
		},
		async glob() {
			return [];
		},
		async grep() {
			throw new Error("not implemented");
		},
		async execCommand() {
			throw new Error("not implemented");
		},
		async gitStatus() {
			return "";
		},
		async gitDiff() {
			return "";
		},
	} as unknown as ExecutionBackend;
	return {
		backend,
		readText(path) {
			const bytes = files.get(path);
			return bytes ? new TextDecoder().decode(bytes) : null;
		},
		has(path) {
			return files.has(path);
		},
		removeCalls,
	};
}

async function createNarrator(cwd: string): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({ id, cwd, createdAt: now, updatedAt: now });
	createdNarrators.push(id);
	return id;
}

async function addToolCall(
	narratorId: string,
	seq: number,
	inputJson: Record<string, unknown>,
	target: { deviceId: string; filePath: string },
	toolName: "Write" | "Edit" = "Write",
): Promise<string> {
	const messageId = generateId();
	const toolUseId = generateId();
	const createdAt = new Date(Date.now() + seq).toISOString();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [],
		createdAt,
	});
	await db.insert(narratorMessageRefs).values({
		id: generateId(),
		narratorId,
		messageId,
		seq,
	});
	await db.insert(narratorToolCalls).values({
		id: generateId(),
		narratorId,
		messageId,
		toolUseId,
		toolName,
		inputJson,
		executionDeviceId: target.deviceId,
		resolvedFilePath: target.filePath,
		status: "success",
		createdAt,
	});
	return toolUseId;
}

/**
 * Insert a Dynamic Spec (spec://) Write/Edit tool call exactly as the executor
 * persists it: local device, `spec://` cwd, and a `spec://…` resolved path.
 */
async function addSpecToolCall(
	narratorId: string,
	seq: number,
	inputJson: Record<string, unknown>,
	toolName: "Write" | "Edit" = "Write",
): Promise<string> {
	const messageId = generateId();
	const toolUseId = generateId();
	const createdAt = new Date(Date.now() + seq).toISOString();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [],
		createdAt,
	});
	await db.insert(narratorMessageRefs).values({ id: generateId(), narratorId, messageId, seq });
	await db.insert(narratorToolCalls).values({
		id: generateId(),
		narratorId,
		messageId,
		toolUseId,
		toolName,
		inputJson,
		executionDeviceId: "local",
		executionCwd: "spec://",
		resolvedFilePath:
			typeof inputJson.file_path === "string" ? inputJson.file_path : "spec://tasks.json",
		status: "success",
		createdAt,
	});
	return toolUseId;
}

async function getToolCallMessageId(narratorId: string, toolUseId: string): Promise<string> {
	const row = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
		columns: { messageId: true },
	});
	if (!row) throw new Error(`Missing message for tool call ${toolUseId}`);
	return row.messageId;
}

async function addInitializingToolCall(
	narratorId: string,
	toolUseId = generateId(),
): Promise<string> {
	const messageId = generateId();
	const createdAt = new Date().toISOString();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [],
		createdAt,
	});
	await db.insert(narratorMessageRefs).values({
		id: generateId(),
		narratorId,
		messageId,
		seq: 1,
	});
	await db.insert(narratorToolCalls).values({
		id: generateId(),
		narratorId,
		messageId,
		toolUseId,
		toolName: "Write",
		inputJson: { file_path: "draft.md", content: "x" },
		status: "initializing",
		createdAt,
	});
	return toolUseId;
}

afterEach(async () => {
	setRemoteBackendResolver(null);
	for (const narratorId of createdNarrators.splice(0)) {
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
		await db.delete(narratorFileSnapshots).where(eq(narratorFileSnapshots.narratorId, narratorId));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
		await db.delete(narrators).where(eq(narrators.id, narratorId));
	}
	for (const deviceId of createdRemoteDevices.splice(0)) {
		await db.delete(remoteDevices).where(eq(remoteDevices.id, deviceId));
	}
	for (const projectId of createdProjects.splice(0)) {
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tool execution target persistence", () => {
	test("allows pre-approval path refinement and freezes the complete target afterward", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-target-persistence-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);
		const otherNarratorId = await createNarrator(cwd);
		await addInitializingToolCall(otherNarratorId, toolUseId);
		const initialTarget = {
			deviceId: "remote-a",
			backendKind: "remote" as const,
			cwd: "/remote/work",
			resolvedFilePath: "/remote/work/draft.md",
			selectionSource: "session_default" as const,
		};
		const redirectedTarget = {
			...initialTarget,
			resolvedFilePath: "/remote/work/.narrafork/plan.md",
		};

		await narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, initialTarget);
		await narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, redirectedTarget);
		await db
			.update(narratorToolCalls)
			.set({ status: "pending" })
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);
		await narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, redirectedTarget);

		await expect(
			narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, {
				...redirectedTarget,
				cwd: "/remote/other",
				resolvedFilePath: "/remote/other/plan.md",
			}),
		).rejects.toThrow("cannot change after permission handling has begun");
		await expect(
			narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, {
				...redirectedTarget,
				deviceId: "remote-b",
			}),
		).rejects.toThrow("cannot change");

		const stored = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: {
				executionDeviceId: true,
				executionCwd: true,
				resolvedFilePath: true,
				deviceSelectionSource: true,
			},
		});
		expect(stored).toEqual({
			executionDeviceId: "remote-a",
			executionCwd: "/remote/work",
			resolvedFilePath: "/remote/work/.narrafork/plan.md",
			deviceSelectionSource: "session_default",
		});
		const otherStored = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, otherNarratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: { executionDeviceId: true },
		});
		expect(otherStored?.executionDeviceId).toBeNull();
	});

	test("keeps a spec target frozen across taskReflection permission status", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-task-reflection-target-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);
		const toolUse: AgentToolUse = {
			toolUseId,
			name: "Edit",
			input: {
				file_path: "spec://tasks.json",
				old_string: '"status": "doing"',
				new_string: '"status": "done"',
			},
		};
		const config: AgentConfig = {
			narratorId,
			conversationId: "task-reflection-target-test",
			model: "codex:gpt-5.5",
			provider: "codex",
			cwd,
			signal: new AbortController().signal,
			permissionHandler: async () => ({ behavior: "deny" }),
			onExecutionTargetResolved: (resolvedToolUseId, target) =>
				narratorService.updateToolCallExecutionTarget(narratorId, resolvedToolUseId, target),
		};

		await freezeToolExecutionTarget(toolUse, config);
		const requestId = `task-reflection-target-${generateId()}`;
		const decision = createTaskReflectionDecision(requestId, {
			narratorId,
			broadcastTargetId: narratorId,
			toolUseId,
			toolName: toolUse.name,
			inputJson: toolUse.input,
			mutations: [{ type: "complete", text: "Protected task" }],
		});
		await markTaskReflectionStarted(requestId);
		await confirmTaskReflection(
			requestId,
			"The protected task has concrete completion evidence for this regression test.",
		);
		await decision;

		const result = await executeTool(toolUse, config);
		expect(result.isError).toBe(true);
		expect(result.output).not.toContain("already frozen");
		expect(result.output).not.toContain("Tool routing error");

		const stored = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: {
				executionDeviceId: true,
				executionCwd: true,
				resolvedFilePath: true,
				deviceSelectionSource: true,
			},
		});
		expect(stored).toEqual({
			executionDeviceId: "local",
			executionCwd: "spec://",
			resolvedFilePath: "spec://tasks.json",
			deviceSelectionSource: "local_default",
		});
	});

	test("frozen-target guard rejects a selectionSource-only change after approval", async () => {
		// Last-line-of-defense guard for "Tool routing error: Execution target ... is
		// already frozen and cannot change after permission handling has begun."
		//
		// This reproduces the pre-fix hazard at the persistence layer: once the row
		// leaves "initializing", even a change limited to the audit-only
		// deviceSelectionSource (deviceId/cwd/resolvedFilePath unchanged) is rejected.
		// The actual fix lives upstream — reExecuteDeniedToolCall now passes the frozen
		// target back through executeTool's preFrozenTarget option so the re-run
		// reproduces "local_default" instead of recomputing "session_default", never
		// reaching this guard. The guard itself stays strict on purpose.
		const cwd = mkdtempSync(join(tmpdir(), "nf-rerun-local-target-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);

		// Original live execution: local Bash, no remote session default configured.
		const originalTarget = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd,
			selectionSource: "local_default" as const,
		};
		await narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, originalTarget);

		// User denies → row goes to "fail"; the re-run path resets it to "pending"
		// but leaves the frozen execution columns untouched.
		await db
			.update(narratorToolCalls)
			.set({ status: "pending" })
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);

		// Re-run resolves the same local device, but because defaultDeviceId is now
		// "local" the selectionSource is recomputed as "session_default".
		const rerunTarget = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd,
			selectionSource: "session_default" as const,
		};

		await expect(
			narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, rerunTarget),
		).rejects.toThrow("cannot change after permission handling has begun");
	});

	test("freezes the newest row when the same toolUseId exists from a prior turn", async () => {
		// Regression for loop-internal "Tool routing error" with providers that
		// reuse short sequential toolUseIds across requests (call_0, call_1, ...).
		// Without ORDER BY desc(createdAt), findFirst would hit the stale completed
		// row from the previous turn, rejecting the freeze because it already left
		// "initializing".
		const cwd = mkdtempSync(join(tmpdir(), "nf-duplicate-tooluseid-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const duplicateId = "call_2";

		// Previous turn: same toolUseId, already completed.
		const oldMessageId = generateId();
		const oldCreatedAt = new Date(Date.now() - 5000).toISOString();
		await db.insert(narratorMessages).values({
			id: oldMessageId,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: oldCreatedAt,
		});
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId,
			messageId: oldMessageId,
			seq: 1,
		});
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId,
			messageId: oldMessageId,
			toolUseId: duplicateId,
			toolName: "Bash",
			inputJson: { command: "echo old" },
			status: "success",
			executionDeviceId: "local",
			executionCwd: cwd,
			deviceSelectionSource: "local_default",
			createdAt: oldCreatedAt,
		});

		// Current turn: same toolUseId, just inserted as initializing.
		const newMessageId = generateId();
		const newCreatedAt = new Date().toISOString();
		await db.insert(narratorMessages).values({
			id: newMessageId,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: newCreatedAt,
		});
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId,
			messageId: newMessageId,
			seq: 2,
		});
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId,
			messageId: newMessageId,
			toolUseId: duplicateId,
			toolName: "Bash",
			inputJson: { command: "echo new" },
			status: "initializing",
			createdAt: newCreatedAt,
		});

		// This must succeed — it should target the newest (initializing) row, not
		// the old (success) row. Before the fix, findFirst without orderBy would
		// hit the old row and throw "already frozen ... after permission handling".
		const target = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd,
			selectionSource: "local_default" as const,
		};
		await expect(
			narratorService.updateToolCallExecutionTarget(narratorId, duplicateId, target),
		).resolves.toBeUndefined();
	});
});

describe("device-aware file state rebuild", () => {
	test("does not infer a known device without resolved path as local", () => {
		expect(
			getToolCallFileIdentity({
				toolName: "Write",
				inputJson: { file_path: "relative.txt", content: "x" },
				executionDeviceId: "unknown-remote",
				resolvedFilePath: null,
			}),
		).toBeNull();
		expect(() =>
			getToolCallFileIdentityStrict(
				{
					toolUseId: "missing-path",
					toolName: "Write",
					inputJson: { file_path: "relative.txt", content: "x" },
					executionDeviceId: "unknown-remote",
					resolvedFilePath: null,
				},
				null,
			),
		).toThrow("without a resolved file path");
		expect(
			getToolCallFileIdentity({
				toolName: "Write",
				inputJson: { file_path: "legacy-relative.txt", content: "x" },
				executionDeviceId: null,
				resolvedFilePath: null,
			}),
		).toEqual({ deviceId: "local", filePath: "legacy-relative.txt" });
	});

	test("lightweight history queries preserve and reject unsafe legacy remote targets", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-legacy-remote-query-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const messageId = generateId();
		const toolUseId = generateId();
		const createdAt = new Date().toISOString();
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt,
		});
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId,
			messageId,
			seq: 1,
		});
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId,
			messageId,
			toolUseId,
			toolName: "Write",
			inputJson: {
				file_path: "relative.txt",
				device: "legacy-remote",
				content: "large body deliberately omitted by the lightweight query",
			},
			status: "success",
			createdAt,
		});

		const rows = await queryOrderedToolCalls(narratorId, undefined, { filePathOnly: true });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.inputJson).toEqual({
			file_path: "relative.txt",
			device: "legacy-remote",
		});
		expect(() => groupByDeviceFileStrict(rows, cwd)).toThrow(
			"targeted remote device legacy-remote",
		);
	});

	test("snapshot first-touch identity includes the device", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-snapshot-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const sharedPath = "/workspace/shared.txt";
		let localReads = 0;
		await ensureFileSnapshot(narratorId, "local", sharedPath, async () => {
			localReads++;
			return "local-original";
		});
		await ensureFileSnapshot(narratorId, "local", sharedPath, async () => {
			localReads++;
			return "must-not-replace";
		});
		await ensureFileSnapshot(narratorId, "remote-a", sharedPath, async () => "remote-original");

		const snapshots = await db.query.narratorFileSnapshots.findMany({
			where: eq(narratorFileSnapshots.narratorId, narratorId),
		});
		expect(localReads).toBe(1);
		expect(snapshots).toHaveLength(2);
		expect(snapshots.find((snapshot) => snapshot.deviceId === "local")?.originalContent).toBe(
			"local-original",
		);
		expect(snapshots.find((snapshot) => snapshot.deviceId === "remote-a")?.originalContent).toBe(
			"remote-original",
		);
	});

	test("isolates the same absolute path on local and remote devices", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-rebuild-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const sharedPath = "/workspace/shared.txt";
		await db.insert(narratorFileSnapshots).values([
			{
				id: generateId(),
				narratorId,
				deviceId: "local",
				filePath: sharedPath,
				originalContent: "local-original",
				createdAt: new Date().toISOString(),
			},
			{
				id: generateId(),
				narratorId,
				deviceId: "remote-a",
				filePath: sharedPath,
				originalContent: "remote-original",
				createdAt: new Date().toISOString(),
			},
		]);
		await addToolCall(
			narratorId,
			1,
			{ file_path: "shared.txt", content: "local-final" },
			{ deviceId: "local", filePath: sharedPath },
		);
		await addToolCall(
			narratorId,
			2,
			{ file_path: "shared.txt", content: "remote-final" },
			{ deviceId: "remote-a", filePath: sharedPath },
		);

		const states = await rebuildDeviceFileStatesUpToSeq(narratorId, 2);
		expect(states.get(deviceFileKey({ deviceId: "local", filePath: sharedPath }))?.content).toBe(
			"local-final",
		);
		expect(states.get(deviceFileKey({ deviceId: "remote-a", filePath: sharedPath }))?.content).toBe(
			"remote-final",
		);
	});

	test("canonicalizes legacy relative local history with newer absolute paths", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-legacy-path-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const absolutePath = join(cwd, "shared.txt");
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "local",
			filePath: "shared.txt",
			originalContent: "base",
			createdAt: new Date().toISOString(),
		});
		const legacyToolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: "shared.txt", content: "legacy" },
			{ deviceId: "local", filePath: absolutePath },
		);
		await db
			.update(narratorToolCalls)
			.set({ executionDeviceId: null, executionCwd: null, resolvedFilePath: null })
			.where(eq(narratorToolCalls.toolUseId, legacyToolUseId));
		await addToolCall(
			narratorId,
			2,
			{ file_path: "shared.txt", content: "current" },
			{ deviceId: "local", filePath: absolutePath },
		);

		const states = await rebuildDeviceFileStatesUpToSeq(narratorId, 2);

		expect(states.size).toBe(1);
		expect(states.get(deviceFileKey({ deviceId: "local", filePath: absolutePath }))?.content).toBe(
			"current",
		);
	});

	test("replays multiple operations only within the same device identity", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-replay-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = "/remote/work/replay.txt";
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "remote-b",
			filePath,
			originalContent: "base",
			createdAt: new Date().toISOString(),
		});
		await addToolCall(
			narratorId,
			1,
			{ file_path: "replay.txt", content: "first" },
			{ deviceId: "remote-b", filePath },
		);
		await addToolCall(
			narratorId,
			2,
			{ file_path: "replay.txt", old_string: "first", new_string: "second" },
			{ deviceId: "remote-b", filePath },
			"Edit",
		);

		const states = await rebuildDeviceFileStatesUpToSeq(narratorId, 2);
		expect(states.get(deviceFileKey({ deviceId: "remote-b", filePath }))?.content).toBe("second");
	});

	test("excludes spec:// tool calls from device file identity and rebuild", () => {
		// Dynamic Spec files are versioned in the DB, not on any device filesystem.
		// Both identity resolvers must treat them as non-file-touching so the revert
		// machinery never writes a literal spec:// path to disk.
		const specCall = {
			toolUseId: "spec-1",
			toolName: "Write" as const,
			inputJson: { file_path: "spec://tasks.json", content: "{}" },
			executionDeviceId: "local",
			executionCwd: "spec://",
			resolvedFilePath: "spec://tasks.json",
		};
		expect(getToolCallFileIdentity(specCall, null)).toBeNull();
		expect(getToolCallFileIdentityStrict(specCall, null)).toBeNull();

		// A legacy row that only carries the spec URI in its input is also excluded.
		const legacySpecCall = {
			toolUseId: "spec-legacy",
			toolName: "Edit" as const,
			inputJson: { file_path: "spec://index.md", old_string: "a", new_string: "b" },
			executionDeviceId: null,
			executionCwd: null,
			resolvedFilePath: null,
		};
		expect(getToolCallFileIdentity(legacySpecCall, null)).toBeNull();
		expect(getToolCallFileIdentityStrict(legacySpecCall, null)).toBeNull();
	});

	test("spec:// writes never contribute to the rebuilt device state map", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-spec-rebuild-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		await addSpecToolCall(narratorId, 1, { file_path: "spec://tasks.json", content: "{}" });
		await addSpecToolCall(narratorId, 2, {
			file_path: "spec://tasks.json",
			old_string: "{}",
			new_string: "{ }",
		});

		const states = await rebuildDeviceFileStatesUpToSeq(narratorId, 2);
		expect(states.size).toBe(0);
	});
});

describe("device-aware snapshot revert", () => {
	test("skipRevert checkpoints preserve deleted file history for a later rollback", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-skip-revert-checkpoint-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = join(cwd, "checkpoint.txt");
		writeFileSync(filePath, "first");
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "local",
			filePath,
			originalContent: "base",
			createdAt: new Date().toISOString(),
		});

		const firstToolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: filePath, content: "first" },
			{ deviceId: "local", filePath },
		);
		const firstMessageId = await getToolCallMessageId(narratorId, firstToolUseId);
		await narratorService.deleteMessage(narratorId, firstMessageId, { skipRevert: true });

		const checkpointCalls = await db.query.narratorToolCalls.findMany({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.isFileHistoryCheckpoint, true),
			),
		});
		expect(checkpointCalls).toHaveLength(1);
		const checkpointRef = await db.query.narratorMessageRefs.findFirst({
			where: eq(narratorMessageRefs.messageId, checkpointCalls[0]?.messageId ?? "missing"),
		});
		expect(checkpointRef?.segmentCompactId).toBeTruthy();

		const secondToolUseId = await addToolCall(
			narratorId,
			2,
			{ file_path: filePath, content: "second" },
			{ deviceId: "local", filePath },
		);
		writeFileSync(filePath, "second");

		const result = await revertPatchForToolUse(narratorId, secondToolUseId);
		expect(result).toMatchObject({ reverted: true, fileCount: 1, failures: [] });
		expect(readFileSync(filePath, "utf8")).toBe("first");
	});

	test("deleteMessageBlock skipRevert preserves the removed tool call as a checkpoint", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-skip-block-checkpoint-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = join(cwd, "block-checkpoint.txt");
		writeFileSync(filePath, "first");
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "local",
			filePath,
			originalContent: "base",
			createdAt: new Date().toISOString(),
		});

		const firstToolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: filePath, content: "first" },
			{ deviceId: "local", filePath },
		);
		const firstMessageId = await getToolCallMessageId(narratorId, firstToolUseId);
		await db
			.update(narratorMessages)
			.set({ contentJson: [{ type: "tool_use", id: firstToolUseId, name: "Write", input: {} }] })
			.where(eq(narratorMessages.id, firstMessageId));

		await narratorService.deleteMessageBlock(narratorId, firstMessageId, 0, { skipRevert: true });
		const checkpointCalls = await db.query.narratorToolCalls.findMany({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.isFileHistoryCheckpoint, true),
			),
		});
		expect(checkpointCalls).toHaveLength(1);

		const secondToolUseId = await addToolCall(
			narratorId,
			2,
			{ file_path: filePath, content: "second" },
			{ deviceId: "local", filePath },
		);
		writeFileSync(filePath, "second");
		const result = await revertPatchForToolUse(narratorId, secondToolUseId);
		expect(result).toMatchObject({ reverted: true, fileCount: 1, failures: [] });
		expect(readFileSync(filePath, "utf8")).toBe("first");
	});

	test("reverting a spec:// tool call is a no-op that never touches the filesystem", async () => {
		// Regression: spec:// Write/Edit calls persist executionDeviceId="local" and
		// resolvedFilePath="spec://…". Before the fix, revert treated them as real local
		// files, writing junk to `<cwd>/spec:/…` (or failing) instead of ignoring them.
		const cwd = mkdtempSync(join(tmpdir(), "nf-spec-revert-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addSpecToolCall(narratorId, 1, {
			file_path: "spec://tasks.json",
			content: '{"tasks":[]}',
		});

		const result = await revertPatchForToolUse(narratorId, toolUseId);

		expect(result.reverted).toBe(false);
		expect(result.fileCount).toBe(0);
		expect(result.failures).toHaveLength(0);
		// No literal spec:// path was ever materialized on disk.
		expect(existsSync(join(cwd, "spec:"))).toBe(false);
		expect(existsSync(join(cwd, "spec://tasks.json"))).toBe(false);
	});

	test("a mixed message still reverts the real local file and ignores the spec:// call", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-spec-mixed-revert-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const localPath = join(cwd, "real.txt");
		writeFileSync(localPath, "current");
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "local",
			filePath: localPath,
			originalContent: "original",
			createdAt: new Date().toISOString(),
		});
		const localToolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: localPath, content: "current" },
			{ deviceId: "local", filePath: localPath },
		);
		const specToolUseId = await addSpecToolCall(narratorId, 2, {
			file_path: "spec://tasks.json",
			content: '{"tasks":[]}',
		});

		const result = await revertPatchForToolUses(narratorId, [localToolUseId, specToolUseId]);

		expect(result.reverted).toBe(true);
		expect(result.failures).toHaveLength(0);
		expect(readFileSync(localPath, "utf8")).toBe("original");
		expect(existsSync(join(cwd, "spec:"))).toBe(false);
	});

	test("refuses legacy remote history whose target path was never persisted", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-legacy-remote-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const localPath = join(cwd, "shared.txt");
		writeFileSync(localPath, "local-untouched");
		const toolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: "shared.txt", content: "remote-new", device: "remote-a" },
			{ deviceId: "remote-a", filePath: "/remote/work/shared.txt" },
		);
		await db
			.update(narratorToolCalls)
			.set({ executionDeviceId: null, executionCwd: null, resolvedFilePath: null })
			.where(eq(narratorToolCalls.toolUseId, toolUseId));

		const result = await revertPatchForToolUse(narratorId, toolUseId);

		expect(result.reverted).toBe(false);
		expect(result.failures[0]).toMatchObject({
			deviceId: "remote-a",
			filePath: "shared.txt",
			code: "UNSAFE_LEGACY_REMOTE_TARGET",
		});
		expect(readFileSync(localPath, "utf8")).toBe("local-untouched");
	});

	test("rejects a project-scoped remote device for standalone narrator history", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-unauthorized-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const projectId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: projectId,
			name: "Other project",
			createdAt: now,
			updatedAt: now,
		});
		createdProjects.push(projectId);
		const filePath = "/remote/work/forbidden.txt";
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "project-remote",
			filePath,
			originalContent: "original",
			createdAt: now,
		});
		const toolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: "forbidden.txt", content: "current" },
			{ deviceId: "project-remote", filePath },
		);
		const memory = await createMemoryBackend(
			"project-remote",
			{ [filePath]: "current" },
			undefined,
			{ scope: "project", projectId },
		);
		setRemoteBackendResolver((deviceId) => (deviceId === "project-remote" ? memory.backend : null));

		const result = await revertPatchForToolUse(narratorId, toolUseId);

		expect(result.reverted).toBeFalse();
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({
			deviceId: "project-remote",
			filePath,
			code: "REMOTE_DEVICE_UNAUTHORIZED",
		});
		expect(memory.readText(filePath)).toBe("current");
	});

	test("offline remote revert reports failure without touching the local same path", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-offline-"));
		tempDirs.push(cwd);
		const localPath = join(cwd, "shared.txt");
		writeFileSync(localPath, "local-untouched");
		const narratorId = await createNarrator(cwd);
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "offline-remote",
			filePath: localPath,
			originalContent: "remote-original",
			createdAt: new Date().toISOString(),
		});
		const toolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: localPath, content: "remote-new" },
			{ deviceId: "offline-remote", filePath: localPath },
		);
		setRemoteBackendResolver(() => null);

		const result = await revertPatchForToolUse(narratorId, toolUseId);

		expect(result.reverted).toBe(false);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({
			deviceId: "offline-remote",
			filePath: localPath,
			code: "REMOTE_DEVICE_UNAVAILABLE",
		});
		expect(readFileSync(localPath, "utf8")).toBe("local-untouched");

		const storedCall = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: { messageId: true },
		});
		expect(storedCall).toBeDefined();
		await db
			.update(narratorMessages)
			.set({ contentJson: [{ type: "tool_use", id: toolUseId }] })
			.where(eq(narratorMessages.id, storedCall?.messageId ?? "missing"));
		await expect(
			narratorService.deleteMessageBlock(narratorId, storedCall?.messageId ?? "missing", 0),
		).rejects.toMatchObject({ code: "SNAPSHOT_REVERT_FAILED", statusCode: 409 });
		const preserved = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: { id: true },
		});
		expect(preserved).toBeDefined();
	});

	test("restores a remote file through its recorded backend", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-remote-revert-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = "/remote/work/file.txt";
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "remote-a",
			filePath,
			originalContent: "remote-original",
			createdAt: new Date().toISOString(),
		});
		const toolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: "file.txt", content: "remote-new" },
			{ deviceId: "remote-a", filePath },
		);
		const memory = await createMemoryBackend("remote-a", { [filePath]: "remote-new" });
		setRemoteBackendResolver((deviceId) => (deviceId === "remote-a" ? memory.backend : null));

		const result = await revertPatchForToolUse(narratorId, toolUseId);

		expect(result).toMatchObject({ reverted: true, fileCount: 1, failures: [] });
		expect(memory.readText(filePath)).toBe("remote-original");
	});

	test("restores pre-rollback bytes when the history transaction fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-history-compensate-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = "/remote/work/file.txt";
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "remote-a",
			filePath,
			originalContent: "remote-original",
			createdAt: new Date().toISOString(),
		});
		const toolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: "file.txt", content: "remote-current" },
			{ deviceId: "remote-a", filePath },
		);
		const memory = await createMemoryBackend("remote-a", { [filePath]: "remote-current" });
		setRemoteBackendResolver((deviceId) => (deviceId === "remote-a" ? memory.backend : null));
		const result = await revertPatchForToolUse(narratorId, toolUseId);
		expect(memory.readText(filePath)).toBe("remote-original");

		await expect(
			commitSnapshotRevert(result, () => {
				throw new Error("injected history transaction failure");
			}),
		).rejects.toThrow("injected history transaction failure");
		expect(memory.readText(filePath)).toBe("remote-current");
	});

	test("removes a newly created remote file without using the shell", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-remote-delete-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = "/remote/work/new.txt";
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "remote-a",
			filePath,
			originalContent: null,
			createdAt: new Date().toISOString(),
		});
		const toolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: "new.txt", content: "created" },
			{ deviceId: "remote-a", filePath },
		);
		const memory = await createMemoryBackend("remote-a", { [filePath]: "created" });
		setRemoteBackendResolver((deviceId) => (deviceId === "remote-a" ? memory.backend : null));

		const result = await revertPatchForToolUse(narratorId, toolUseId);

		expect(result.failures).toEqual([]);
		expect(memory.has(filePath)).toBe(false);
		expect(memory.removeCalls).toEqual([filePath]);
	});

	test("preflights every device before changing any file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-preflight-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const firstPath = "/remote-a/work/file.txt";
		const secondPath = "/remote-b/work/file.txt";
		await db.insert(narratorFileSnapshots).values([
			{
				id: generateId(),
				narratorId,
				deviceId: "remote-a",
				filePath: firstPath,
				originalContent: "a-original",
				createdAt: new Date().toISOString(),
			},
			{
				id: generateId(),
				narratorId,
				deviceId: "remote-b",
				filePath: secondPath,
				originalContent: "b-original",
				createdAt: new Date().toISOString(),
			},
		]);
		const firstToolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: "file.txt", content: "a-current" },
			{ deviceId: "remote-a", filePath: firstPath },
		);
		const secondToolUseId = await addToolCall(
			narratorId,
			2,
			{ file_path: "file.txt", content: "b-current" },
			{ deviceId: "remote-b", filePath: secondPath },
		);
		const memory = await createMemoryBackend("remote-a", { [firstPath]: "a-current" });
		setRemoteBackendResolver((deviceId) => (deviceId === "remote-a" ? memory.backend : null));

		const result = await revertPatchForToolUses(narratorId, [firstToolUseId, secondToolUseId]);

		expect(result.reverted).toBe(false);
		expect(result.failures[0]).toMatchObject({
			deviceId: "remote-b",
			code: "REMOTE_DEVICE_UNAVAILABLE",
		});
		expect(memory.readText(firstPath)).toBe("a-current");
	});

	test("skipRevert deletes subsequent messages without reverting the file", async () => {
		// Third confirm-dialog option: "delete messages only" must leave files untouched.
		const cwd = mkdtempSync(join(tmpdir(), "nf-skiprevert-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const localPath = join(cwd, "keep.txt");
		writeFileSync(localPath, "current");
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "local",
			filePath: localPath,
			originalContent: "original",
			createdAt: new Date().toISOString(),
		});
		// Boundary message at seq 0 (kept), tool-call message at seq 1 (deleted).
		const boundaryId = generateId();
		await db.insert(narratorMessages).values({
			id: boundaryId,
			narratorId,
			role: "user",
			contentJson: [],
			createdAt: new Date().toISOString(),
		});
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId,
			messageId: boundaryId,
			seq: 0,
		});
		await addToolCall(
			narratorId,
			1,
			{ file_path: localPath, content: "current" },
			{ deviceId: "local", filePath: localPath },
		);

		const result = await narratorService.deleteMessagesAfter(narratorId, boundaryId, {
			skipRevert: true,
		});

		expect(result.deletedCount).toBe(1);
		// File stays at its current content — no revert happened.
		expect(readFileSync(localPath, "utf8")).toBe("current");
		// The subsequent message was still deleted.
		const remaining = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.narratorId, narratorId),
		});
		const visibleRemaining = remaining.filter((ref) => ref.segmentCompactId === null);
		expect(visibleRemaining).toHaveLength(1);
		expect(visibleRemaining[0]?.messageId).toBe(boundaryId);
	});

	test("default (no skipRevert) still reverts the file when deleting messages", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-skiprevert-default-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const localPath = join(cwd, "keep.txt");
		writeFileSync(localPath, "current");
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "local",
			filePath: localPath,
			originalContent: "original",
			createdAt: new Date().toISOString(),
		});
		const boundaryId = generateId();
		await db.insert(narratorMessages).values({
			id: boundaryId,
			narratorId,
			role: "user",
			contentJson: [],
			createdAt: new Date().toISOString(),
		});
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId,
			messageId: boundaryId,
			seq: 0,
		});
		await addToolCall(
			narratorId,
			1,
			{ file_path: localPath, content: "current" },
			{ deviceId: "local", filePath: localPath },
		);

		await narratorService.deleteMessagesAfter(narratorId, boundaryId);

		expect(readFileSync(localPath, "utf8")).toBe("original");
	});

	test("compensates earlier files when a later remote write fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-device-compensate-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const firstPath = "/remote/work/a.txt";
		const secondPath = "/remote/work/b.txt";
		await db.insert(narratorFileSnapshots).values([
			{
				id: generateId(),
				narratorId,
				deviceId: "remote-a",
				filePath: firstPath,
				originalContent: "a-original",
				createdAt: new Date().toISOString(),
			},
			{
				id: generateId(),
				narratorId,
				deviceId: "remote-a",
				filePath: secondPath,
				originalContent: "b-original",
				createdAt: new Date().toISOString(),
			},
		]);
		const firstToolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: "a.txt", content: "a-current" },
			{ deviceId: "remote-a", filePath: firstPath },
		);
		const secondToolUseId = await addToolCall(
			narratorId,
			2,
			{ file_path: "b.txt", content: "b-current" },
			{ deviceId: "remote-a", filePath: secondPath },
		);
		const memory = await createMemoryBackend(
			"remote-a",
			{ [firstPath]: "a-current", [secondPath]: "b-current" },
			secondPath,
		);
		setRemoteBackendResolver((deviceId) => (deviceId === "remote-a" ? memory.backend : null));

		const result = await revertPatchForToolUses(narratorId, [firstToolUseId, secondToolUseId]);

		expect(result.reverted).toBe(false);
		expect(result.failures[0]).toMatchObject({
			deviceId: "remote-a",
			filePath: secondPath,
			code: "WRITE_FAILED",
		});
		expect(result.failures.some((item) => item.code === "COMPENSATION_FAILED")).toBe(false);
		expect(memory.readText(firstPath)).toBe("a-current");
		expect(memory.readText(secondPath)).toBe("b-current");
	});
});
