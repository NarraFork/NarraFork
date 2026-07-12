import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});

describe("device-aware snapshot revert", () => {
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
