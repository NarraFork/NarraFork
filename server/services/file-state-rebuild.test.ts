import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import iconv from "iconv-lite";
import { db, sqlite } from "../db";
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
import { targetPathSemantics } from "../lib/agent/execution/path-resolve";
import { setRemoteBackendResolver } from "../lib/agent/execution/registry";
import { executeTool, freezeToolExecutionTarget } from "../lib/agent/tool-executor";
import {
	confirmTaskReflection,
	createTaskReflectionDecision,
	grantTaskReflection,
	markTaskReflectionStarted,
} from "../lib/agent/tools/task-reflection";
import type { AgentConfig, AgentToolUse } from "../lib/agent/types";
import { generateId } from "../lib/id";
import { settings } from "../lib/settings";
import { ensureFileSnapshot } from "./file-snapshot-service";
import {
	buildCanonicalIdentityAliases,
	canonicalizeDeviceFileIdentity,
	canonicalizeDeviceFileIdentityWith,
	deviceFileKey,
	getToolCallFileIdentity,
	getToolCallFileIdentityStrict,
	groupByDeviceFileStrict,
	queryOrderedToolCalls,
	ReplayDivergedError,
	rebuildDeviceFileStatesUpToSeq,
} from "./file-state-rebuild";
import { reconstructToolExecutionTarget } from "./narrator-persistence";
import { narratorService } from "./narrator-service";
import { TOOL_CALL_RERUN_RESET_FIELDS } from "./narrator-session";
import {
	commitSnapshotRevert,
	discardSnapshotRevert,
	finalizeSnapshotRevert,
	revertPatchForToolUse,
	revertPatchForToolUses,
} from "./snapshot-revert";
import { readSpecFile, writeSpecFile } from "./spec-vfs-service";

for (const statement of [
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_path_flavor TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN canonical_file_path TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN runtime_generation INTEGER",
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_targets_json TEXT",
]) {
	try {
		sqlite.run(statement);
	} catch (err) {
		if (!String(err).includes("duplicate column name")) throw err;
	}
}

const createdNarrators: string[] = [];
const createdRemoteDevices: string[] = [];
const createdProjects: string[] = [];
const tempDirs: string[] = [];

async function createMemoryBackend(
	deviceId: string,
	initial: Record<string, string>,
	failWriteOnceFor?: string,
	registration?: {
		scope: "global" | "project";
		projectId?: string;
		/** Overrides the reported handshake platform (drift/Windows path-grammar tests). */
		platform?: { os: string; arch: string } | undefined;
		/** Overrides the reported default cwd (drift tests). */
		defaultCwd?: string | null;
		/** Reuse an already-registered device row instead of inserting a new one. */
		skipDeviceRow?: boolean;
	},
): Promise<{
	backend: ExecutionBackend;
	readText(path: string): string | null;
	has(path: string): boolean;
	removeCalls: string[];
}> {
	const now = new Date().toISOString();
	if (!registration?.skipDeviceRow) {
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
	}
	const files = new Map(
		Object.entries(initial).map(([path, content]) => [path, new TextEncoder().encode(content)]),
	);
	let remainingWriteFailures = failWriteOnceFor ? 1 : 0;
	const removeCalls: string[] = [];
	const backend = {
		deviceId,
		kind: "remote",
		platform:
			registration && "platform" in registration
				? registration.platform
				: { os: "linux", arch: "x64" },
		defaultCwd:
			registration && "defaultCwd" in registration ? registration.defaultCwd : "/remote/work",
		paths: targetPathSemantics("posix"),
		pathFlavor: "posix",
		runtimeGeneration: 1,
		// The in-memory store has no symlinks, so lexical and canonical paths coincide.
		async resolvePathIdentity(path: string) {
			return {
				lexicalPath: path,
				canonicalPath: path,
				exists: files.has(path),
				runtimeGeneration: 1,
			};
		},
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
	target: {
		deviceId: string;
		filePath: string;
		pathFlavor?: "posix" | "windows" | "spec";
		lexicalPath?: string;
		canonicalPath?: string;
		runtimeGeneration?: number;
	},
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
		executionPathFlavor: target.pathFlavor ?? null,
		resolvedFilePath: target.lexicalPath ?? target.filePath,
		canonicalFilePath: target.canonicalPath ?? null,
		runtimeGeneration: target.runtimeGeneration ?? null,
		executionTargetsJson:
			target.pathFlavor ||
			target.lexicalPath ||
			target.canonicalPath ||
			target.runtimeGeneration != null
				? [
						{
							deviceId: target.deviceId,
							backendKind: target.deviceId === "local" ? "local" : "remote",
							cwd: target.pathFlavor === "windows" ? "C:\\Work" : "/workspace",
							...(target.pathFlavor && { pathFlavor: target.pathFlavor }),
							lexicalPath: target.lexicalPath ?? target.filePath,
							resolvedFilePath: target.lexicalPath ?? target.filePath,
							...(target.canonicalPath && { canonicalPath: target.canonicalPath }),
							...(target.runtimeGeneration != null && {
								runtimeGeneration: target.runtimeGeneration,
							}),
							selectionSource: "session_default",
						},
					]
				: null,
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
	test("reconstructs legacy lexical-only rows", () => {
		expect(
			reconstructToolExecutionTarget({
				executionDeviceId: "remote-legacy",
				executionCwd: "/legacy/work",
				executionPathFlavor: null,
				resolvedFilePath: "/legacy/work/file.txt",
				canonicalFilePath: null,
				runtimeGeneration: null,
				executionTargetsJson: null,
				deviceSelectionSource: "explicit",
			}),
		).toEqual({
			deviceId: "remote-legacy",
			backendKind: "remote",
			cwd: "/legacy/work",
			lexicalPath: "/legacy/work/file.txt",
			resolvedFilePath: "/legacy/work/file.txt",
			selectionSource: "explicit",
		});
	});

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
			pathFlavor: "posix" as const,
			lexicalPath: "/remote/work/link/draft.md",
			canonicalPath: "/remote/work/real/draft.md",
			runtimeGeneration: 7,
			resolvedFilePath: "/remote/work/link/draft.md",
			selectionSource: "session_default" as const,
		};
		const redirectedTarget = {
			...initialTarget,
			lexicalPath: "/remote/work/.narrafork/plan.md",
			canonicalPath: "/remote/work/.narrafork/plan.md",
			resolvedFilePath: "/remote/work/.narrafork/plan.md",
		};
		const secondaryTarget = {
			deviceId: "remote-b",
			backendKind: "remote" as const,
			cwd: "/secondary/work",
			pathFlavor: "posix" as const,
			lexicalPath: "/secondary/work/output.log",
			canonicalPath: "/secondary/work/output.log",
			runtimeGeneration: 2,
			resolvedFilePath: "/secondary/work/output.log",
			selectionSource: "explicit" as const,
		};

		await narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, initialTarget);
		await db
			.update(narratorToolCalls)
			.set({ executionTargetsJson: [initialTarget, secondaryTarget] })
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);
		// cwd is refinable while the row is still initializing: a re-run against a device that
		// reconnected with a different defaultCwd must be able to re-freeze the new identity.
		await narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, {
			...initialTarget,
			cwd: "/remote/other",
		});
		await expect(
			narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, {
				...initialTarget,
				pathFlavor: "windows",
			}),
		).rejects.toThrow("path flavor");
		await expect(
			narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, {
				...initialTarget,
				runtimeGeneration: 8,
			}),
		).rejects.toThrow("runtime generation");
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
		).rejects.toThrow("after permission handling has begun");
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
				executionPathFlavor: true,
				resolvedFilePath: true,
				canonicalFilePath: true,
				runtimeGeneration: true,
				executionTargetsJson: true,
				deviceSelectionSource: true,
			},
		});
		if (!stored) throw new Error("Persisted execution target was not found");
		expect(stored).toEqual({
			executionDeviceId: "remote-a",
			executionCwd: "/remote/work",
			executionPathFlavor: "posix",
			resolvedFilePath: "/remote/work/.narrafork/plan.md",
			canonicalFilePath: "/remote/work/.narrafork/plan.md",
			runtimeGeneration: 7,
			executionTargetsJson: [redirectedTarget, secondaryTarget],
			deviceSelectionSource: "session_default",
		});
		expect(reconstructToolExecutionTarget(stored)).toEqual(redirectedTarget);
		const detail = await narratorService.getToolCallDetail(narratorId, toolUseId);
		expect(detail.executionTarget).toEqual(redirectedTarget);
		expect(detail.executionTargets).toEqual([redirectedTarget, secondaryTarget]);
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
			deviceSelectionSource: "explicit",
		});
	});

	test("re-writing the SAME execution plan after approval is not a change", async () => {
		// Regression for "Tool routing error: Execution plan for tool call ... is already
		// frozen and cannot change after permission handling has begun.", hit repeatedly
		// when writing spec://tasks.json (Read worked; every Write/Edit failed).
		//
		// The two writers disagree on the SHAPE of executionTargetsJson:
		//   - updateToolCallExecutionTarget stores an ARRAY of targets
		//   - updateToolCallExecutionPlan stores the PLAN object {kind, primaryKey, endpoints}
		// and updateToolCallExecutionPlan calls the target writer first. So by the time it
		// compares, the column holds the array form its own JSON.stringify comparison can
		// never match — the guard fires even though the plan is byte-identical to the one
		// already approved, which is the definition of "not a change".
		const cwd = mkdtempSync(join(tmpdir(), "nf-plan-refreeze-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);

		const plan = {
			kind: "single" as const,
			primaryKey: "primary",
			endpoints: [
				{
					key: "primary",
					operation: "write" as const,
					target: {
						deviceId: "local",
						backendKind: "local" as const,
						cwd: "spec://",
						resolvedFilePath: "spec://tasks.json",
						selectionSource: "explicit" as const,
					},
				},
			],
		};

		// Freeze it once, exactly as the executor does before permission handling.
		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, plan);
		// Approval has begun → the row leaves "initializing".
		await db
			.update(narratorToolCalls)
			.set({ status: "pending" })
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);

		// Re-writing the IDENTICAL plan must be accepted: nothing about the routing
		// changed, so there is nothing for the freeze guard to protect.
		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, plan);
	});

	test("a plan freeze leaves executionTargetsJson in PLAN shape, not the target array", async () => {
		// The root cause of the "already frozen" false positive was two writers storing
		// two shapes in one column: updateToolCallExecutionTarget writes an ARRAY of
		// targets, updateToolCallExecutionPlan writes the PLAN object — and the plan writer
		// calls the target writer first, so the array landed last and won.
		//
		// That silent disagreement is what made the freeze comparison degrade to
		// targets-only (losing each endpoint's `operation`). Pinning the post-freeze shape
		// is therefore the durable guard: if the ordering regresses, this fails here rather
		// than as a permission check that quietly stops noticing an escalation.
		const cwd = mkdtempSync(join(tmpdir(), "nf-plan-shape-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);

		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, {
			kind: "single",
			primaryKey: "primary",
			endpoints: [
				{
					key: "primary",
					operation: "read",
					target: {
						deviceId: "local",
						backendKind: "local",
						cwd,
						resolvedFilePath: join(cwd, "note.md"),
						selectionSource: "explicit",
					},
				},
			],
		});

		const row = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: { executionTargetsJson: true },
		});
		const stored = row?.executionTargetsJson as { endpoints?: unknown[] } | unknown[] | null;
		// Plan shape: an object carrying `endpoints`, each with its `operation`.
		expect(Array.isArray(stored)).toBe(false);
		expect(Array.isArray((stored as { endpoints?: unknown[] })?.endpoints)).toBe(true);
		expect(
			((stored as { endpoints: { operation?: string }[] }).endpoints ?? []).map(
				(endpoint) => endpoint.operation,
			),
		).toEqual(["read"]);
	});

	test("a spec Edit survives the real freeze → taskReflection → execute PLAN sequence", async () => {
		// The closest existing test wires only `onExecutionTargetResolved`, so it never
		// exercises the PLAN writer — which is precisely where "Execution plan ... is
		// already frozen" comes from. A live session registers BOTH callbacks, so the
		// plan is written once by the pre-reflection freeze and again at execution time,
		// with the row no longer "initializing" in between. That two-pass sequence, not a
		// synthetic identical-plan rewrite, is what the production failure actually is.
		const cwd = mkdtempSync(join(tmpdir(), "nf-plan-reflection-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);
		// Seed the real spec file so the edit has something to match, and so the assertion
		// at the end can compare actual stored bytes rather than only the tool's message.
		// Formatted with a space after the colon so `old_string` matches exactly, mirroring
		// how the spec writer actually stores tasks.json.
		await writeSpecFile(
			narratorId,
			"spec://tasks.json",
			JSON.stringify(
				{ tasks: [{ text: "Protected task", status: "doing", protected: true }] },
				null,
				"\t",
			),
		);
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
			conversationId: "plan-reflection-test",
			model: "codex:gpt-5.5",
			provider: "codex",
			cwd,
			signal: new AbortController().signal,
			// ALLOW the write. A denying handler would prove only "no routing error" while
			// the edit never ran — it could not tell a working write channel apart from a
			// broken one, which is the entire point of this regression.
			permissionHandler: async () => ({ behavior: "allow" }),
			onExecutionTargetResolved: (resolvedToolUseId, target) =>
				narratorService.updateToolCallExecutionTarget(narratorId, resolvedToolUseId, target),
			onExecutionPlanResolved: (resolvedToolUseId, plan) =>
				narratorService.updateToolCallExecutionPlan(narratorId, resolvedToolUseId, plan),
		};

		// Pass 1: the pre-reflection freeze (loop.ts calls this before reflection so the
		// reflection can persist permission-like status on the row).
		await freezeToolExecutionTarget(toolUse, config);

		const requestId = `plan-reflection-${generateId()}`;
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

		// The guard only engages once the row leaves "initializing", and production is what
		// moves it (task-reflection.ts writes status "running" on confirm). Assert that here
		// so this test cannot silently become vacuous: if the row were still "initializing",
		// the comparison would be skipped and the expectations below would pass for the
		// wrong reason.
		const reflectedRow = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: { status: true, executionTargetsJson: true },
		});
		expect(reflectedRow?.status).not.toBe("initializing");
		// And pass 1 must have left a PLAN in the column, since that is the value the
		// second pass compares against.
		expect(reflectedRow?.executionTargetsJson).toMatchObject({ kind: "single" });

		// Production grants the reflection before executing (loop.ts:1904). Without this the
		// spec writer refuses the protected-task change on its own, which would mask whether
		// the freeze guard let the write through.
		grantTaskReflection(narratorId, toolUseId);

		// Pass 2: execution re-resolves and re-persists the plan. The freeze guard must
		// recognise the identical routing instead of reporting a frozen-plan violation.
		const result = await executeTool(toolUse, config);
		expect(result.output).not.toContain("already frozen");
		expect(result.output).not.toContain("Tool routing error");
		// `isError` is only set on failure, so a successful run leaves it undefined. Assert on
		// the output too, so a regression surfaces the actual message instead of a bare bool.
		expect({ isError: result.isError ?? false, output: result.output }).toMatchObject({
			isError: false,
		});
		// The decisive assertion: the bytes actually changed. This is what the production
		// failure prevented, and what a message-only check cannot detect.
		const written = await readSpecFile(narratorId, "spec://tasks.json");
		expect(written.content).toContain('"status": "done"');
		expect(written.content).not.toContain('"status": "doing"');
	});

	test("an operation flip driven by permission-time input refinement is REJECTED", async () => {
		// Adding `operation` to the freeze comparison has a real blast radius: three tools
		// derive it from their INPUT, not just their device —
		//   bash:          command present ? "execute" : "control"
		//   plan-mode:     path present    ? "read"    : "control"
		//   transfer-file: direction upload/download flips read/write per endpoint
		// and permission handling can re-resolve with a DIFFERENT input via onInputResolved
		// (tool-executor.ts:756) after the row has left "initializing".
		//
		// So this is the deliberate semantics, pinned here: on an unchanged target, an
		// operation flip is still a routing change and must be refused. It is a permission
		// decision — "run this command" is not the same grant as "control this task" — so
		// failing closed is correct even though it is stricter than before this change.
		const cwd = mkdtempSync(join(tmpdir(), "nf-plan-op-flip-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);

		const target = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd,
			selectionSource: "explicit" as const,
		};
		// Frozen while the input carried a command → "execute".
		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, {
			kind: "single",
			primaryKey: "primary",
			endpoints: [{ key: "primary", operation: "execute", target }],
		});
		await db
			.update(narratorToolCalls)
			.set({ status: "pending" })
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);

		// Permission-time refinement drops `command` → "control" on the SAME device/cwd.
		await expect(
			narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, {
				kind: "single",
				primaryKey: "primary",
				endpoints: [{ key: "primary", operation: "control", target }],
			}),
		).rejects.toThrow("cannot change after permission handling has begun");
	});

	test("frozen-plan guard survives a MALFORMED stored plan without crashing", async () => {
		// executionTargetsJson is untrusted stored JSON: older builds and hand-edited rows can
		// hold a plan whose endpoints array contains null/incomplete entries. The freeze
		// comparison now parses that column on every plan write, so a null element there used
		// to throw "null is not an object" out of the parser — turning a recoverable data
		// oddity into a failed tool call. Malformed entries must simply be ignored.
		const cwd = mkdtempSync(join(tmpdir(), "nf-plan-malformed-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);

		const target = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd,
			resolvedFilePath: join(cwd, "note.md"),
			selectionSource: "explicit" as const,
		};
		// A plan whose primary sits AFTER a null element, so the primary-first reorder branch
		// (primaryIndex > 0) is the one exercised.
		await db
			.update(narratorToolCalls)
			.set({
				status: "pending",
				executionTargetsJson: {
					kind: "single",
					primaryKey: "primary",
					endpoints: [null, { key: "primary", operation: "write", target }],
					// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed stored JSON
				} as any,
			})
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);

		// Must not throw a TypeError out of the parser. The surviving endpoint describes the
		// same routing, so this is a legitimate no-op re-write.
		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, {
			kind: "single",
			primaryKey: "primary",
			endpoints: [{ key: "primary", operation: "write", target }],
		});
	});

	test("frozen-plan guard accepts a row whose targets column is still NULL", async () => {
		// Rows created before the execution-targets column was populated (or any row whose
		// first plan write happens after it left "initializing") carry NULL there. The guard
		// dropped its explicit `!= null` check when the comparison moved into
		// frozenRoutingSignature, so this asserts the null path stays a clean accept rather
		// than throwing or being treated as a routing change with nothing to compare.
		const cwd = mkdtempSync(join(tmpdir(), "nf-plan-null-col-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);

		// Leave executionTargetsJson NULL and move the row past "initializing".
		await db
			.update(narratorToolCalls)
			.set({ status: "pending", executionTargetsJson: null })
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);

		const target = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd,
			resolvedFilePath: join(cwd, "first.md"),
			selectionSource: "explicit" as const,
		};
		// Nothing is pinned yet, so the first plan must be accepted and stored.
		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, {
			kind: "single",
			primaryKey: "primary",
			endpoints: [{ key: "primary", operation: "write", target }],
		});

		const stored = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: { executionTargetsJson: true },
		});
		expect(stored?.executionTargetsJson).toMatchObject({ kind: "single" });
	});

	test("a REJECTED plan write leaves the row's frozen identity untouched", async () => {
		// The guard now runs BEFORE delegating to the target writer. That ordering is what
		// makes the operation check possible, but it also changes failure semantics for the
		// better: a refused plan must not have already half-written the row. Previously the
		// target writer ran first, so by the time the plan guard threw, executionTargetsJson
		// (and the audit columns) had been overwritten by the rejected routing. Lock the
		// capture-then-refuse behaviour in so a future reorder cannot silently regress it.
		const cwd = mkdtempSync(join(tmpdir(), "nf-plan-reject-atomic-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);

		const approvedTarget = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd,
			resolvedFilePath: join(cwd, "approved.md"),
			selectionSource: "explicit" as const,
		};
		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, {
			kind: "single",
			primaryKey: "primary",
			endpoints: [{ key: "primary", operation: "read", target: approvedTarget }],
		});
		await db
			.update(narratorToolCalls)
			.set({ status: "pending" })
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);
		const before = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: {
				executionTargetsJson: true,
				executionDeviceId: true,
				executionCwd: true,
				resolvedFilePath: true,
			},
		});

		// Escalate the operation on a different path — must be refused.
		await expect(
			narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, {
				kind: "single",
				primaryKey: "primary",
				endpoints: [
					{
						key: "primary",
						operation: "write",
						target: { ...approvedTarget, resolvedFilePath: join(cwd, "escalated.md") },
					},
				],
			}),
		).rejects.toThrow("cannot change after permission handling has begun");

		const after = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: {
				executionTargetsJson: true,
				executionDeviceId: true,
				executionCwd: true,
				resolvedFilePath: true,
			},
		});
		expect(after).toEqual(before);
		// Specifically: the refused path never reached the audit column.
		expect(after?.resolvedFilePath).toBe(join(cwd, "approved.md"));
	});

	test("frozen-plan guard handles the LEGACY target-array column", async () => {
		// Rows frozen by an older build (or by the target writer alone) hold an ARRAY of
		// targets, not a plan. Reading the column BEFORE the target writer runs — which is
		// what makes the operation check possible at all — also made this legacy branch
		// reachable for the first time, so it needs its own coverage: it must still reject
		// a genuine target change, and must not reject on the missing `operation` data it
		// never stored.
		const cwd = mkdtempSync(join(tmpdir(), "nf-plan-legacy-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);

		const target = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd,
			resolvedFilePath: join(cwd, "note.md"),
			selectionSource: "explicit" as const,
		};
		// Freeze through the TARGET writer only → the column ends up in the array shape.
		await narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, target);
		await db
			.update(narratorToolCalls)
			.set({ status: "pending" })
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);
		const legacyRow = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: { executionTargetsJson: true },
		});
		expect(Array.isArray(legacyRow?.executionTargetsJson)).toBe(true);

		// A plan describing the SAME target is accepted: the legacy column holds no
		// operation, so there is nothing more to compare and nothing changed.
		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, {
			kind: "single",
			primaryKey: "primary",
			endpoints: [{ key: "primary", operation: "write", target }],
		});
	});

	test("re-freezes a multi-endpoint plan whose primary is not endpoints[0]", async () => {
		// Regression for "Execution target device ... is already frozen to X and cannot
		// change to Y" on the SECOND freeze of an unchanged TransferFile plan.
		//
		// Callers read index 0 of the stored targets as "the identity this row is frozen
		// to" (reconstructToolExecutionTarget, and the target writer's array merge). A
		// multi-endpoint plan does not put its primary there: TransferFile lists the host
		// endpoint first while primaryKey is the remote one. Unpacking in array order
		// therefore pinned the LOCAL device, and the next identical freeze — which
		// legitimately writes the REMOTE primary — looked like a device change.
		const cwd = mkdtempSync(join(tmpdir(), "nf-plan-multi-primary-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);

		const localTarget = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd,
			resolvedFilePath: join(cwd, "source.txt"),
			selectionSource: "local_default" as const,
		};
		const remoteTarget = {
			deviceId: "remote-a",
			backendKind: "remote" as const,
			cwd: "/remote/work",
			resolvedFilePath: "/remote/work/dest.txt",
			selectionSource: "explicit" as const,
		};
		// Mirrors transferFileTool's upload routing: primaryKey "remote", host endpoint first.
		const plan = {
			kind: "multi" as const,
			primaryKey: "remote",
			endpoints: [
				{ key: "local", operation: "read" as const, target: localTarget },
				{ key: "remote", operation: "write" as const, target: remoteTarget },
			],
		};

		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, plan);
		// Permission-time onInputResolved re-freezes the identical plan; this threw before.
		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, plan);
		await db
			.update(narratorToolCalls)
			.set({ status: "pending" })
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);
		// And once approval has begun, the unchanged plan is still not a change.
		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, plan);

		const stored = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: {
				executionDeviceId: true,
				executionCwd: true,
				resolvedFilePath: true,
				executionTargetsJson: true,
			},
		});
		// The row is pinned to the PRIMARY (remote) endpoint, not the host one.
		expect(stored?.executionDeviceId).toBe("remote-a");
		expect(stored?.executionCwd).toBe("/remote/work");
		expect(stored?.resolvedFilePath).toBe("/remote/work/dest.txt");
		expect(reconstructToolExecutionTarget(stored as never)?.deviceId).toBe("remote-a");

		// A genuine change to the non-primary endpoint must still be rejected.
		await expect(
			narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, {
				...plan,
				endpoints: [
					{ key: "local", operation: "write" as const, target: localTarget },
					{ key: "remote", operation: "write" as const, target: remoteTarget },
				],
			}),
		).rejects.toThrow("cannot change after permission handling has begun");
	});

	test("frozen-plan guard still rejects an operation or endpoint-set change", async () => {
		// The shape-agnostic comparison that fixed the false positive above must not have
		// widened the hole it guards. `parseStoredExecutionTargets` maps endpoints to their
		// `.target`, so comparing ONLY targets would silently accept:
		//   - the same target with a different `operation` (read → write is a different
		//     permission decision, which is exactly what the freeze exists to pin), and
		//   - a multi-endpoint plan losing or gaining an endpoint that shares a target.
		const cwd = mkdtempSync(join(tmpdir(), "nf-plan-operation-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);

		const target = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd,
			resolvedFilePath: join(cwd, "note.md"),
			selectionSource: "explicit" as const,
		};
		const readPlan = {
			kind: "single" as const,
			primaryKey: "primary",
			endpoints: [{ key: "primary", operation: "read" as const, target }],
		};
		await narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, readPlan);
		await db
			.update(narratorToolCalls)
			.set({ status: "pending" })
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);

		// Same device, same cwd, same path — only the OPERATION escalates.
		const writePlan = {
			...readPlan,
			endpoints: [{ key: "primary", operation: "write" as const, target }],
		};
		await expect(
			narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, writePlan),
		).rejects.toThrow("cannot change after permission handling has begun");

		// And an added endpoint reusing the approved target must not slip through either.
		const widenedPlan = {
			kind: "multi" as const,
			primaryKey: "primary",
			endpoints: [
				{ key: "primary", operation: "read" as const, target },
				{ key: "secondary", operation: "write" as const, target },
			],
		};
		await expect(
			narratorService.updateToolCallExecutionPlan(narratorId, toolUseId, widenedPlan),
		).rejects.toThrow("cannot change after permission handling has begun");
	});

	test("frozen-target guard rejects a selectionSource-only change after approval", async () => {
		// Last-line-of-defense guard for "Tool routing error: Execution target ... is
		// already frozen and cannot change after permission handling has begun."
		//
		// This reproduces the pre-fix hazard at the persistence layer: once the row
		// leaves "initializing", even a change limited to the audit-only
		// deviceSelectionSource (deviceId/cwd/resolvedFilePath unchanged) is rejected.
		// The actual fix lives upstream: reExecuteDeniedToolCall resets the row to
		// "initializing" (a re-run is a fresh permission cycle), so the executor may
		// legitimately re-freeze the identity it is really going to use, and passes the
		// previously frozen target through executeTool's preFrozenTarget option so the
		// audit-only selectionSource is pinned instead of recomputed. A pre-granted re-run
		// additionally refuses when the resolved identity drifted from the approved one.
		// The guard itself stays strict on purpose.
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

		// Simulate a row that has already entered permission handling with a frozen
		// identity (the state this guard protects), leaving the execution columns intact.
		await db
			.update(narratorToolCalls)
			.set({ status: "pending" })
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);

		// A recomputed target whose only difference is the audit-only selectionSource
		// (as would happen if defaultDeviceId were seeded with the frozen device id).
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

	test("re-freezes a remote row after the device reports a different defaultCwd", async () => {
		// Regression for the planned-update restart failure:
		// "Execution target for tool call ... is already frozen and cannot change after
		// permission handling has begun."
		//
		// A remote RemoteBackend is rebuilt from the live handshake on every resolve
		// (defaultCwd: hello?.defaultCwd ?? null), so a device that reconnects with a
		// different default cwd makes the re-run resolve a different cwd/resolvedFilePath
		// than the frozen ones. The row must therefore be back at "initializing" so this
		// legitimate re-freeze is allowed and the audit columns end up describing the
		// identity the file tools actually use.
		const cwd = mkdtempSync(join(tmpdir(), "nf-remote-cwd-drift-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);
		const deviceId = `remote-drift-${generateId()}`;

		const frozenTarget = {
			deviceId,
			backendKind: "remote" as const,
			cwd: "/remote/work",
			resolvedFilePath: "/remote/work/draft.md",
			selectionSource: "session_default" as const,
		};
		await narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, frozenTarget);

		// Re-arm the row exactly as the production re-run path does, so this test fails if
		// that reset ever stops leaving the freeze window open.
		await db
			.update(narratorToolCalls)
			.set(TOOL_CALL_RERUN_RESET_FIELDS)
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);

		// The reconnected device now reports a different default cwd.
		const drifted = await createMemoryBackend(
			deviceId,
			{ "/remote/relocated/draft.md": "hello" },
			undefined,
			{ scope: "global", defaultCwd: "/remote/relocated" },
		);
		setRemoteBackendResolver((id) => (id === deviceId ? drifted.backend : null));

		const config: AgentConfig = {
			narratorId,
			conversationId: "remote-cwd-drift-test",
			model: "codex:gpt-5.5",
			provider: "codex",
			cwd,
			signal: new AbortController().signal,
			defaultDeviceId: deviceId,
			availableDevices: [
				{ id: deviceId, name: deviceId, slug: deviceId, online: true, scope: "global" as const },
			],
			permissionHandler: async () => ({ behavior: "allow" }),
			onExecutionTargetResolved: (resolvedToolUseId, target) =>
				narratorService.updateToolCallExecutionTarget(narratorId, resolvedToolUseId, target),
		};

		const result = await executeTool(
			{
				toolUseId,
				name: "Edit",
				input: { file_path: "draft.md", old_string: "hello", new_string: "world" },
			},
			config,
			{ preFrozenTarget: frozenTarget },
		);

		expect(result.output).not.toContain("already frozen");
		expect(result.output).not.toContain("Tool routing error");
		expect(result.isError).toBeFalsy();
		expect(drifted.readText("/remote/relocated/draft.md")).toBe("world");

		// The audit columns describe the path that was really written, and the audit-only
		// selectionSource stays pinned to the original freeze.
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
			executionDeviceId: deviceId,
			executionCwd: "/remote/relocated",
			resolvedFilePath: "/remote/relocated/draft.md",
			deviceSelectionSource: "session_default",
		});
	});

	test("refuses a pre-granted re-run whose approved execution identity drifted", async () => {
		// The counterpart of the test above: when the tool call was already approved for
		// one specific identity (a restored deferred tool with permissionGranted, or the
		// user pressing retry), silently retargeting would execute something the approval
		// never covered. Refuse with the concrete diff and leave the audit columns alone.
		const cwd = mkdtempSync(join(tmpdir(), "nf-pregranted-drift-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);
		const deviceId = `remote-pregrant-${generateId()}`;

		const approvedTarget = {
			deviceId,
			backendKind: "remote" as const,
			cwd: "/remote/work",
			resolvedFilePath: "/remote/work/draft.md",
			selectionSource: "session_default" as const,
		};
		await narratorService.updateToolCallExecutionTarget(narratorId, toolUseId, approvedTarget);
		await db
			.update(narratorToolCalls)
			.set(TOOL_CALL_RERUN_RESET_FIELDS)
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);

		const drifted = await createMemoryBackend(
			deviceId,
			{ "/remote/relocated/draft.md": "hello" },
			undefined,
			{ scope: "global", defaultCwd: "/remote/relocated" },
		);
		setRemoteBackendResolver((id) => (id === deviceId ? drifted.backend : null));

		const config: AgentConfig = {
			narratorId,
			conversationId: "pregranted-drift-test",
			model: "codex:gpt-5.5",
			provider: "codex",
			cwd,
			signal: new AbortController().signal,
			defaultDeviceId: deviceId,
			availableDevices: [
				{ id: deviceId, name: deviceId, slug: deviceId, online: true, scope: "global" as const },
			],
			permissionHandler: async () => ({ behavior: "allow" }),
			onExecutionTargetResolved: (resolvedToolUseId, target) =>
				narratorService.updateToolCallExecutionTarget(narratorId, resolvedToolUseId, target),
		};

		const result = await executeTool(
			{
				toolUseId,
				name: "Edit",
				input: { file_path: "draft.md", old_string: "hello", new_string: "world" },
			},
			config,
			{ preGrantedPermission: { behavior: "allow" }, preFrozenTarget: approvedTarget },
		);

		expect(result.isError).toBe(true);
		expect(result.output).toContain("Execution target drift");
		expect(result.output).toContain("/remote/relocated");
		// Nothing executed, and the approved identity is still the persisted one.
		expect(drifted.readText("/remote/relocated/draft.md")).toBe("hello");
		const stored = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: { executionCwd: true, resolvedFilePath: true },
		});
		expect(stored).toEqual({
			executionCwd: "/remote/work",
			resolvedFilePath: "/remote/work/draft.md",
		});
	});

	test("freezes a restored tool call that never had an execution identity", async () => {
		// A tool call interrupted at "initializing" by a planned update has all three
		// execution columns NULL — it was checkpointed before the freeze ever ran. The
		// restored run must be able to perform that first freeze instead of being
		// rejected for "changing" a target that was never set.
		const cwd = mkdtempSync(join(tmpdir(), "nf-unfrozen-restore-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);
		writeFileSync(join(cwd, "draft.md"), "hello");

		const before = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: {
				executionDeviceId: true,
				executionCwd: true,
				deviceSelectionSource: true,
			},
		});
		expect(before).toEqual({
			executionDeviceId: null,
			executionCwd: null,
			deviceSelectionSource: null,
		});

		const config: AgentConfig = {
			narratorId,
			conversationId: "unfrozen-restore-test",
			model: "codex:gpt-5.5",
			provider: "codex",
			cwd,
			signal: new AbortController().signal,
			permissionHandler: async () => ({ behavior: "allow" }),
			onExecutionTargetResolved: (resolvedToolUseId, target) =>
				narratorService.updateToolCallExecutionTarget(narratorId, resolvedToolUseId, target),
		};

		// No preFrozenTarget: there was no identity to reproduce.
		const result = await executeTool(
			{
				toolUseId,
				name: "Edit",
				input: { file_path: "draft.md", old_string: "hello", new_string: "world" },
			},
			config,
		);

		expect(result.output).not.toContain("Tool routing error");
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(cwd, "draft.md"), "utf8")).toBe("world");

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
			executionCwd: cwd,
			resolvedFilePath: join(cwd, "draft.md"),
			deviceSelectionSource: "local_default",
		});
	});

	test("reuses a frozen device whose deviceSelectionSource column is missing", async () => {
		// deviceSelectionSource was added after executionDeviceId/executionCwd, so older
		// rows can carry a frozen device with a NULL selection source. reExecuteDeniedToolCall
		// must still reuse that identity (deriving the selection source from the device kind)
		// instead of dropping the whole preFrozenTarget through an && short-circuit.
		const cwd = mkdtempSync(join(tmpdir(), "nf-legacy-selection-source-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const toolUseId = await addInitializingToolCall(narratorId);
		writeFileSync(join(cwd, "draft.md"), "hello");

		await db
			.update(narratorToolCalls)
			.set({
				...TOOL_CALL_RERUN_RESET_FIELDS,
				executionDeviceId: "local",
				executionCwd: cwd,
				resolvedFilePath: join(cwd, "draft.md"),
				deviceSelectionSource: null,
			})
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);

		const row = await db.query.narratorToolCalls.findFirst({
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
		// Mirrors the preFrozenTarget reExecuteDeniedToolCall builds for such a row:
		// the device/cwd are reused and the selection source is derived, not dropped.
		expect(row?.deviceSelectionSource).toBeNull();
		const preFrozenTarget = {
			deviceId: row?.executionDeviceId as string,
			backendKind: "local" as const,
			cwd: row?.executionCwd as string,
			resolvedFilePath: row?.resolvedFilePath as string,
			selectionSource: "local_default" as const,
		};

		const config: AgentConfig = {
			narratorId,
			conversationId: "legacy-selection-source-test",
			model: "codex:gpt-5.5",
			provider: "codex",
			cwd,
			signal: new AbortController().signal,
			// The re-run seeds defaultDeviceId with the frozen device id, which is exactly
			// what would recompute selectionSource as "session_default" without the pin.
			defaultDeviceId: "local",
			permissionHandler: async () => ({ behavior: "allow" }),
			onExecutionTargetResolved: (resolvedToolUseId, target) =>
				narratorService.updateToolCallExecutionTarget(narratorId, resolvedToolUseId, target),
		};

		const result = await executeTool(
			{
				toolUseId,
				name: "Edit",
				input: { file_path: "draft.md", old_string: "hello", new_string: "world" },
			},
			config,
			{ preGrantedPermission: { behavior: "allow" }, preFrozenTarget },
		);

		expect(result.output).not.toContain("already frozen");
		expect(result.output).not.toContain("Execution target drift");
		expect(result.isError).toBeFalsy();

		const stored = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: { deviceSelectionSource: true },
		});
		expect(stored?.deviceSelectionSource).toBe("local_default");
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
		).toThrow("without a canonical or lexical file path");
		expect(
			getToolCallFileIdentity({
				toolName: "Write",
				inputJson: { file_path: "legacy-relative.txt", content: "x" },
				executionDeviceId: null,
				resolvedFilePath: null,
			}),
		).toEqual({
			deviceId: "local",
			filePath: "legacy-relative.txt",
			pathFlavor: "posix",
			identityKey: "legacy-relative.txt",
		});
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

	/**
	 * `/file-modifications` canonicalizes one identity per snapshot. Rebuilding the
	 * alias map inside that loop is O(snapshots × toolCalls) of synchronous work and
	 * froze the event loop for ~4.3s on a 1436 × 7213 narrator. The hoisted form must
	 * resolve every alias — lexical, canonical and case-folded — identically, or the
	 * speedup would come at the cost of files silently splitting into two entries.
	 */
	test("a hoisted alias map resolves identities exactly like the per-identity call", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-alias-hoist-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);

		await addToolCall(
			narratorId,
			1,
			{ file_path: "C:\\Work\\Link\\a.txt", content: "a" },
			{
				deviceId: "windows-device",
				filePath: "C:\\Work\\Real\\a.txt",
				pathFlavor: "windows",
				lexicalPath: "C:\\Work\\Link\\a.txt",
				canonicalPath: "C:\\Work\\Real\\a.txt",
			},
		);
		await addToolCall(
			narratorId,
			2,
			{ file_path: "/workspace/b.txt", content: "b" },
			{ deviceId: "local", filePath: "/workspace/b.txt" },
		);

		const toolCalls = await queryOrderedToolCalls(narratorId, undefined, {
			filePathOnly: true,
		});
		const aliases = buildCanonicalIdentityAliases(toolCalls, cwd);

		// Includes the lexical alias, its case-folded variant and an unknown path that
		// must fall through to the normalized input unchanged.
		const probes = [
			{ deviceId: "windows-device", filePath: "C:\\Work\\Link\\a.txt" },
			{ deviceId: "windows-device", filePath: "c:\\work\\link\\A.TXT" },
			{ deviceId: "windows-device", filePath: "C:\\Work\\Real\\a.txt" },
			{ deviceId: "local", filePath: "/workspace/b.txt" },
			{ deviceId: "local", filePath: "/workspace/never-touched.txt" },
		];

		for (const probe of probes) {
			expect(canonicalizeDeviceFileIdentityWith(probe, aliases)).toEqual(
				canonicalizeDeviceFileIdentity(probe, toolCalls, cwd),
			);
		}

		// The alias really is doing work: the lexical path resolves to the canonical one.
		expect(canonicalizeDeviceFileIdentityWith(probes[0], aliases).filePath).toBe(
			"C:\\Work\\Real\\a.txt",
		);
		// An unknown path is preserved rather than mapped onto an unrelated entry.
		expect(canonicalizeDeviceFileIdentityWith(probes[4], aliases).filePath).toBe(
			"/workspace/never-touched.txt",
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

	test("groups Windows aliases by canonical device/path identity", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-windows-canonical-rebuild-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "windows-device",
			filePath: "C:\\Work\\Link\\File.txt",
			originalContent: "base",
			createdAt: new Date().toISOString(),
		});
		await addToolCall(
			narratorId,
			1,
			{ file_path: "C:\\Work\\Link\\File.txt", content: "first" },
			{
				deviceId: "windows-device",
				filePath: "C:\\Work\\Real\\File.txt",
				pathFlavor: "windows",
				lexicalPath: "C:\\Work\\Link\\File.txt",
				canonicalPath: "C:\\Work\\Real\\File.txt",
				runtimeGeneration: 3,
			},
		);
		await addToolCall(
			narratorId,
			2,
			{
				file_path: "c:\\work\\LINK\\FILE.TXT",
				old_string: "first",
				new_string: "second",
			},
			{
				deviceId: "windows-device",
				filePath: "c:\\work\\real\\FILE.TXT",
				pathFlavor: "windows",
				lexicalPath: "c:\\work\\LINK\\FILE.TXT",
				canonicalPath: "c:\\work\\real\\FILE.TXT",
				runtimeGeneration: 3,
			},
			"Edit",
		);

		const states = await rebuildDeviceFileStatesUpToSeq(narratorId, 2);
		const key = deviceFileKey({
			deviceId: "windows-device",
			filePath: "C:\\WORK\\REAL\\file.txt",
			pathFlavor: "windows",
		});
		expect(states).toHaveLength(1);
		expect(states.get(key)?.content).toBe("second");
		expect(states.get(key)?.identityKey).toBe("c:\\work\\real\\file.txt");
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

	test("reverts a lexical snapshot through its canonical target identity", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-canonical-remote-revert-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const lexicalPath = "/remote/work/link/file.txt";
		const canonicalPath = "/remote/work/real/file.txt";
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId,
			deviceId: "remote-a",
			filePath: lexicalPath,
			originalContent: "remote-original",
			createdAt: new Date().toISOString(),
		});
		const toolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: lexicalPath, content: "remote-new" },
			{
				deviceId: "remote-a",
				filePath: canonicalPath,
				pathFlavor: "posix",
				lexicalPath,
				canonicalPath,
				runtimeGeneration: 4,
			},
		);
		const memory = await createMemoryBackend("remote-a", { [canonicalPath]: "remote-new" });
		setRemoteBackendResolver((deviceId) => (deviceId === "remote-a" ? memory.backend : null));

		const result = await revertPatchForToolUse(narratorId, toolUseId);

		expect(result).toMatchObject({ reverted: true, fileCount: 1, failures: [] });
		expect(memory.readText(canonicalPath)).toBe("remote-original");
		expect(memory.has(lexicalPath)).toBe(false);
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

/**
 * Replay is only sound while every recorded step still applies. When it does not,
 * the rebuild must fail loudly: continuing from the pre-call content would rebase
 * all later edits onto a wrong baseline and produce a file matching neither the
 * old nor the new revision.
 */
describe("replay divergence is never silently absorbed", () => {
	test("an Edit whose old_string is gone fails instead of returning stale content", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-replay-diverge-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = join(cwd, "a.txt");

		await ensureFileSnapshot(narratorId, "local", filePath, async () => "original\n");
		// This Edit targets text that is absent from the recorded baseline, so the
		// replay cannot reproduce it.
		await addToolCall(
			narratorId,
			1,
			{ file_path: filePath, old_string: "NEVER PRESENT", new_string: "replacement" },
			{ deviceId: "local", filePath },
			"Edit",
		);

		const rebuild = rebuildDeviceFileStatesUpToSeq(narratorId, 10);
		await expect(rebuild).rejects.toThrow(/no longer applies/);
		await rebuild.catch((error: unknown) => {
			expect(error).toBeInstanceOf(ReplayDivergedError);
			expect((error as ReplayDivergedError).code).toBe("REPLAY_DIVERGED");
			// The identity is attached so callers can name the offending file.
			expect((error as ReplayDivergedError).identity).toMatchObject({
				deviceId: "local",
				filePath,
			});
		});
	});

	test("a diverged replay reports a failure rather than writing a hybrid file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-replay-diverge-revert-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = join(cwd, "a.txt");
		writeFileSync(filePath, "second\n");

		await ensureFileSnapshot(narratorId, "local", filePath, async () => "original\n");
		const firstToolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: filePath, old_string: "original", new_string: "first" },
			{ deviceId: "local", filePath },
			"Edit",
		);
		// The second Edit consumes the text produced by the first one.
		await addToolCall(
			narratorId,
			2,
			{ file_path: filePath, old_string: "first", new_string: "second" },
			{ deviceId: "local", filePath },
			"Edit",
		);

		// Removing the *earlier* call strands the later one: replaying it against the
		// untouched baseline can no longer find "first". Previously this silently kept
		// the baseline and wrote "original", losing the second edit; it must fail and
		// leave the file alone instead.
		const result = await revertPatchForToolUses(narratorId, [firstToolUseId]);
		expect(result.reverted).toBe(false);
		expect(result.failures[0]).toMatchObject({ code: "REPLAY_DIVERGED", filePath });
		expect(readFileSync(filePath, "utf8")).toBe("second\n");
	});

	test("an Edit with an empty old_string still overwrites the whole file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-replay-create-mode-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = join(cwd, "created.txt");

		// Empty old_string is the Edit tool's create/overwrite mode.
		await addToolCall(
			narratorId,
			1,
			{ file_path: filePath, old_string: "", new_string: "brand new\n" },
			{ deviceId: "local", filePath },
			"Edit",
		);

		const states = await rebuildDeviceFileStatesUpToSeq(narratorId, 10);
		expect(states.get(deviceFileKey({ deviceId: "local", filePath }))?.content).toBe("brand new\n");
	});

	test("a binary baseline is refused instead of round-tripped through text", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-replay-binary-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = join(cwd, "blob.bin");

		await ensureFileSnapshot(narratorId, "local", filePath, async () => ({
			content: "\u0000\u0001binary",
			encoding: "utf-8",
			isBinary: true,
		}));
		await addToolCall(
			narratorId,
			1,
			{ file_path: filePath, content: "text" },
			{ deviceId: "local", filePath },
		);

		await expect(rebuildDeviceFileStatesUpToSeq(narratorId, 10)).rejects.toThrow(
			/recorded as binary/,
		);
	});
});

/**
 * Snapshots persist decoded text, so the charset must travel with them. Writing
 * a restored file back as UTF-8 unconditionally would silently rewrite the
 * charset of a legacy-encoded file.
 */
describe("snapshot encoding round trip", () => {
	test("reverting a GBK file restores the original bytes, not UTF-8", async () => {
		settings.agent.legacyEncoding = true;
		try {
			const cwd = mkdtempSync(join(tmpdir(), "nf-encoding-revert-"));
			tempDirs.push(cwd);
			const narratorId = await createNarrator(cwd);
			const filePath = join(cwd, "gbk.txt");
			const original = "你好世界\n这是GBK编码的文件\n";
			const originalBytes = iconv.encode(original, "gbk");
			writeFileSync(filePath, originalBytes);

			await ensureFileSnapshot(narratorId, "local", filePath, async () => ({
				content: original,
				encoding: "gbk",
				isBinary: false,
			}));
			const toolUseId = await addToolCall(
				narratorId,
				1,
				{ file_path: filePath, content: "overwritten" },
				{ deviceId: "local", filePath },
			);
			writeFileSync(filePath, "overwritten");

			const result = await revertPatchForToolUses(narratorId, [toolUseId]);
			expect(result.failures).toEqual([]);

			// Byte-for-byte equality: decoding as UTF-8 would not match.
			const restored = readFileSync(filePath);
			expect(Buffer.compare(restored, originalBytes)).toBe(0);
			expect(iconv.decode(restored, "gbk")).toBe(original);
		} finally {
			settings.agent.legacyEncoding = false;
		}
	});

	test("Write records the detected charset on the first-touch snapshot", async () => {
		settings.agent.legacyEncoding = true;
		try {
			const cwd = mkdtempSync(join(tmpdir(), "nf-encoding-capture-"));
			tempDirs.push(cwd);
			const narratorId = await createNarrator(cwd);
			const filePath = join(cwd, "gbk-capture.txt");
			writeFileSync(filePath, iconv.encode("你好世界，这是一个中文文件。\n", "gbk"));

			const toolUse: AgentToolUse = {
				toolUseId: generateId(),
				name: "Write",
				input: { file_path: filePath, content: "replaced" },
			};
			const config: AgentConfig = {
				narratorId,
				conversationId: "encoding-capture-test",
				model: "codex:gpt-5.5",
				provider: "codex",
				cwd,
				signal: new AbortController().signal,
				permissionHandler: async () => ({ behavior: "allow" }),
			};
			await addInitializingToolCall(narratorId, toolUse.toolUseId);
			const result = await executeTool(toolUse, config);
			expect(result.isError).toBeFalsy();

			const snap = await db.query.narratorFileSnapshots.findFirst({
				where: and(
					eq(narratorFileSnapshots.narratorId, narratorId),
					eq(narratorFileSnapshots.filePath, filePath),
				),
				columns: { originalEncoding: true, isBinary: true },
			});
			// chardet may report any member of the GB family (gbk / gb18030); what
			// matters is that a non-UTF-8 charset was persisted for the round trip.
			expect(snap?.originalEncoding).toMatch(/^gb/);
			expect(snap?.isBinary).toBe(false);
		} finally {
			settings.agent.legacyEncoding = false;
		}
	});

	test("Write flags a binary first-touch snapshot", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-encoding-binary-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = join(cwd, "blob.bin");
		writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));

		const toolUse: AgentToolUse = {
			toolUseId: generateId(),
			name: "Write",
			input: { file_path: filePath, content: "text" },
		};
		const config: AgentConfig = {
			narratorId,
			conversationId: "encoding-binary-test",
			model: "codex:gpt-5.5",
			provider: "codex",
			cwd,
			signal: new AbortController().signal,
			permissionHandler: async () => ({ behavior: "allow" }),
		};
		await addInitializingToolCall(narratorId, toolUse.toolUseId);
		const result = await executeTool(toolUse, config);
		expect(result.isError).toBeFalsy();

		const snap = await db.query.narratorFileSnapshots.findFirst({
			where: and(
				eq(narratorFileSnapshots.narratorId, narratorId),
				eq(narratorFileSnapshots.filePath, filePath),
			),
			columns: { isBinary: true },
		});
		expect(snap?.isBinary).toBe(true);
	});
});

/**
 * A revert that already touched the filesystem owns a compensation plan. Dropping
 * the result without resolving it would leave files rolled back while the history
 * they belong to is still present.
 */
describe("compensation plan lifecycle", () => {
	test("discarding a revert restores the pre-revert bytes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-compensate-discard-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = join(cwd, "a.txt");
		writeFileSync(filePath, "current\n");

		await ensureFileSnapshot(narratorId, "local", filePath, async () => "original\n");
		const toolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: filePath, content: "current\n" },
			{ deviceId: "local", filePath },
		);

		const result = await revertPatchForToolUses(narratorId, [toolUseId]);
		expect(result.failures).toEqual([]);
		expect(readFileSync(filePath, "utf8")).toBe("original\n");

		// Abandoning the revert must put the file back the way it was.
		const failures = await discardSnapshotRevert(result);
		expect(failures).toEqual([]);
		expect(readFileSync(filePath, "utf8")).toBe("current\n");
	});

	test("finalizing a revert keeps the reverted state and releases the plan", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nf-compensate-finalize-"));
		tempDirs.push(cwd);
		const narratorId = await createNarrator(cwd);
		const filePath = join(cwd, "a.txt");
		writeFileSync(filePath, "current\n");

		await ensureFileSnapshot(narratorId, "local", filePath, async () => "original\n");
		const toolUseId = await addToolCall(
			narratorId,
			1,
			{ file_path: filePath, content: "current\n" },
			{ deviceId: "local", filePath },
		);

		const result = await revertPatchForToolUses(narratorId, [toolUseId]);
		finalizeSnapshotRevert(result);

		// The plan is gone, so a later discard is a no-op and the file stays reverted.
		expect(await discardSnapshotRevert(result)).toEqual([]);
		expect(readFileSync(filePath, "utf8")).toBe("original\n");
	});
});
