/**
 * The snapshot hook pair a subagent loop installs.
 *
 * A subagent writes to a real worktree with the same tools as its parent, but its
 * orchestration layer is a separate function — and it used to pass only
 * `onContextUsage`, so no subagent tool call ever recorded a workspace boundary.
 * The rollback path reads `narrator_tool_calls.treeHashBefore/After` without
 * knowing which loop wrote the row, so that gap silently degraded every subagent
 * file change to per-file replay (which cannot see Bash or external writes at all).
 *
 * These tests drive `buildTreeSnapshotEventHooks` — the shared construction both
 * loops now use — against real git worktrees, because the thing worth guarding is
 * the persisted result, not that a function was called.
 *
 * The budget test is the load-bearing one: `onSnapshotBefore` is AWAITED inside the
 * narrator's event consumer, so a capture that blocks indefinitely freezes the whole
 * session. It must degrade to a null boundary and let the tool proceed.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileHistoryPolicy from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	worktreeTreeSnapshots,
} from "../../db/schema";
import { LOCAL_DEVICE_ID } from "../../lib/agent/execution/backend";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { normalizePathForComparison } from "../../lib/platform-path";
import { settings } from "../../lib/settings";
import { safeSpawn } from "../../lib/spawn";
import type { TreeSnapshotSession } from "../narrator-tree-snapshot-hooks";
import * as snapshotHooks from "../narrator-tree-snapshot-hooks";
import {
	buildTreeSnapshotEventHooks,
	buildTreeSnapshotExecutionHooks,
} from "../tree-snapshot-loop-hooks";
import { treeSnapshotPhysicalDir } from "../tree-snapshot-paths";
import { resetHotPathCaptureStateForTests, worktreeTreeSnapshot } from "../worktree-tree-snapshot";
import { peekClaim } from "../worktree-write-claims";

// Retained boundary/ownership algorithms use an explicit test-only policy;
// ordinary local execution is exercised separately below.
const previousSetting = settings.workspace.treeSnapshotsEnabled;
let restorePolicy = () => {};
beforeEach(() => {
	const policy = spyOn(fileHistoryPolicy, "isFileHistoryEnabledForDevice").mockReturnValue(true);
	restorePolicy = () => policy.mockRestore();
	settings.workspace.treeSnapshotsEnabled = true;
});
afterEach(() => {
	restorePolicy();
	settings.workspace.treeSnapshotsEnabled = previousSetting;
});

const createdNarrators: string[] = [];
const tempDirs: string[] = [];

async function createRepo(prefix: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	await safeSpawn({ cmd: ["git", "init"], cwd: dir, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: dir });
	await safeSpawn({ cmd: ["git", "config", "user.name", "Test"], cwd: dir });
	return dir;
}

/** A subagent narrator row, i.e. what `executeSubagent` runs against. */
async function createSubagent(cwd: string): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		cwd,
		variant: "subagent:general",
		createdAt: now,
		updatedAt: now,
	});
	createdNarrators.push(id);
	return id;
}

/** Insert an assistant message carrying one tool call, as the loop would. */
async function seedToolCall(
	narratorId: string,
	toolName: string,
	seq: number,
): Promise<{ toolUseId: string; messageId: string }> {
	const messageId = generateId();
	const toolUseId = generateId();
	const now = new Date().toISOString();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({ id: generateId(), narratorId, messageId, seq });
	await db.insert(narratorToolCalls).values({
		id: generateId(),
		narratorId,
		messageId,
		toolUseId,
		toolName,
		inputJson: {},
		status: "success",
		createdAt: now,
	});
	return { toolUseId, messageId };
}

async function readToolCallBoundaries(toolUseId: string) {
	return db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.toolUseId, toolUseId),
		columns: { treeHashBefore: true, treeHashAfter: true, ownedPathsJson: true },
	});
}

afterEach(async () => {
	resetHotPathCaptureStateForTests();
	for (const narratorId of createdNarrators.splice(0)) {
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
		await db.delete(narrators).where(eq(narrators.id, narratorId));
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(treeSnapshotPhysicalDir(LOCAL_DEVICE_ID, dir), { recursive: true, force: true });
		await db
			.delete(worktreeTreeSnapshots)
			.where(eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(dir)));
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("execution-owned snapshot boundaries", () => {
	test("GenUI create records a generated file boundary while show records none", async () => {
		const repo = await createRepo("nf-ui-snapshot-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotExecutionHooks({ session, narratorId, isInGitRepo: true });
		const directory = join(repo, ".narrafork/gen_ui/demo-unique");
		for (const [seq, action] of [
			[1, "create"],
			[2, "show"],
		] as const) {
			const call = await seedToolCall(narratorId, "GenUI", seq);
			const row = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.messageId, call.messageId),
			});
			if (!row) throw new Error("Missing UI tool fixture");
			await db
				.update(narratorToolCalls)
				.set({ executionAttempt: 1 })
				.where(eq(narratorToolCalls.id, row.id));
			const input = action === "create" ? { action, prefix: "demo" } : { action, path: directory };
			const context = {
				toolUse: { name: "GenUI", toolUseId: call.toolUseId, input },
				effectiveInput: input,
				binding: { toolCallId: row.id, attempt: 1 },
				executionTarget: {
					deviceId: "local",
					backendKind: "local" as const,
					cwd: repo,
					selectionSource: "local_default" as const,
				},
			};
			await hooks.onToolExecutionBefore?.(context);
			if (action === "create") {
				mkdirSync(directory, { recursive: true });
				writeFileSync(join(directory, "App.tsx"), "export default () => null");
			}
			await hooks.onToolExecutionAfter?.({ ...context, result: { output: "ok" } });
			const boundary = await readToolCallBoundaries(call.toolUseId);
			if (action === "create") {
				expect(boundary?.treeHashBefore).toMatch(/^[0-9a-f]{40}$/);
				expect(boundary?.treeHashAfter).toMatch(/^[0-9a-f]{40}$/);
				expect(boundary?.treeHashAfter).not.toBe(boundary?.treeHashBefore);
			} else {
				expect(boundary?.treeHashBefore).toBeNull();
				expect(boundary?.treeHashAfter).toBeNull();
			}
		}
	});
	test("uses redirected inputs and updates only the bound row among repeated provider ids", async () => {
		const repo = await createRepo("nf-lifecycle-binding-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotExecutionHooks({ session, narratorId, isInGitRepo: true });
		const current = await seedToolCall(narratorId, "Write", 1);
		const other = await seedToolCall(narratorId, "Write", 2);
		const currentRow = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.messageId, current.messageId),
		});
		if (!currentRow) throw new Error("missing fixture tool row");
		await db
			.update(narratorToolCalls)
			.set({ executionAttempt: 1 })
			.where(eq(narratorToolCalls.id, currentRow.id));
		await db
			.update(narratorToolCalls)
			.set({ toolUseId: current.toolUseId })
			.where(eq(narratorToolCalls.messageId, other.messageId));
		writeFileSync(join(repo, "actual.txt"), "before");
		const context = {
			toolUse: {
				name: "Write",
				toolUseId: current.toolUseId,
				input: { file_path: join(repo, "original.txt") },
			},
			effectiveInput: { file_path: join(repo, "actual.txt") },
			binding: { toolCallId: currentRow.id, attempt: 1 },
			executionTarget: {
				deviceId: "local",
				backendKind: "local" as const,
				cwd: repo,
				selectionSource: "local_default" as const,
			},
		};
		await hooks.onToolExecutionBefore?.(context);
		writeFileSync(join(repo, "actual.txt"), "after");
		await hooks.onToolExecutionAfter?.({ ...context, result: { output: "ok" } });
		const updated = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, currentRow.id),
		});
		expect(updated?.treeHashBefore).toMatch(/^[0-9a-f]{40}$/);
		expect(updated?.treeHashAfter).toMatch(/^[0-9a-f]{40}$/);
		expect(updated?.ownedPathsJson).toEqual(["actual.txt"]);
		const untouched = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.messageId, other.messageId),
		});
		expect(untouched?.treeHashBefore).toBeNull();
		expect(untouched?.treeHashAfter).toBeNull();
		expect(session._treeHashBefore?.size).toBe(0);
	});

	test("stale execution attempts cannot overwrite a newer row's boundaries", async () => {
		const repo = await createRepo("nf-lifecycle-stale-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotExecutionHooks({ session, narratorId, isInGitRepo: true });
		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
		const row = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
		});
		if (!row) throw new Error("missing fixture tool row");
		await db
			.update(narratorToolCalls)
			.set({ executionAttempt: 2 })
			.where(eq(narratorToolCalls.id, row.id));
		writeFileSync(join(repo, "a.txt"), "before");
		const context = {
			toolUse: { name: "Write", toolUseId, input: {} },
			effectiveInput: { file_path: join(repo, "a.txt") },
			binding: { toolCallId: row.id, attempt: 1 },
		};
		await hooks.onToolExecutionBefore?.(context);
		writeFileSync(join(repo, "a.txt"), "after");
		await hooks.onToolExecutionAfter?.({ ...context, error: new Error("partially failed write") });
		expect((await readToolCallBoundaries(toolUseId))?.treeHashAfter).toBeNull();
		expect(session._treeHashBefore?.size).toBe(0);
		expect(peekClaim(repo, toolUseId)?.to).toBeNumber();
	});
});

describe("subagent snapshot hooks record boundaries", () => {
	test("a subagent Write persists both boundaries and its owned path", async () => {
		const repo = await createRepo("nf-sa-snap-write-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
		writeFileSync(join(repo, "a.txt"), "before\n");

		const { toolUseId, messageId } = await seedToolCall(narratorId, "Write", 1);
		// The loop passes the tool's declared target, which is what makes the delta
		// attributable in a worktree the parent writes to as well.
		await hooks.onSnapshotBefore?.(toolUseId, "Write", { file_path: join(repo, "a.txt") });
		writeFileSync(join(repo, "a.txt"), "after\n");
		await hooks.onSnapshotAfter?.(toolUseId, "Write");

		const row = await readToolCallBoundaries(toolUseId);
		expect(row?.treeHashBefore).toMatch(/^[0-9a-f]{40}$/);
		expect(row?.treeHashAfter).toMatch(/^[0-9a-f]{40}$/);
		expect(row?.treeHashBefore).not.toBe(row?.treeHashAfter);
		expect(row?.ownedPathsJson).toEqual(["a.txt"]);

		// The message mirror is what "roll back to just after this message" restores.
		const message = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { treeHashAfter: true },
		});
		expect(message?.treeHashAfter).toBe(row?.treeHashAfter);
	});

	test("a recorded subagent boundary holds the bytes from before a shell command", async () => {
		// The point of the tree path: the boundary is real bytes, so it observes a shell
		// command whose writes no input describes.
		const repo = await createRepo("nf-sa-snap-before-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
		writeFileSync(join(repo, "a.txt"), "original\n");

		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		await hooks.onSnapshotBefore?.(toolUseId, "Bash", { command: "..." });
		await safeSpawn({
			cmd: ["sh", "-c", "printf 'wrecked\\n' > a.txt && printf 'junk\\n' > b.txt"],
			cwd: repo,
			timeout: 15_000,
		});
		await hooks.onSnapshotAfter?.(toolUseId, "Bash");

		const row = await readToolCallBoundaries(toolUseId);
		const beforeHash = row?.treeHashBefore;
		if (!beforeHash) throw new Error("expected a recorded before-boundary");
		// A shell command declares nothing, so its owned set is derived from the delta.
		expect((row?.ownedPathsJson as string[]).sort()).toEqual(["a.txt", "b.txt"]);

		expect(
			await worktreeTreeSnapshot.readFilePreviewAtTree(
				repo,
				beforeHash,
				"a.txt",
				LOCAL_DEVICE_ID,
				4096,
				{ signal: new AbortController().signal, timeoutMs: 15_000 },
			),
		).toEqual({ status: "available", content: "original\n" });
	});

	test("read-only tools are skipped entirely", async () => {
		// Only Write/Edit/Bash can change files, so anything else must not pay for a
		// whole-tree scan on the hot path.
		const repo = await createRepo("nf-sa-snap-readonly-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
		writeFileSync(join(repo, "a.txt"), "one\n");

		const { toolUseId } = await seedToolCall(narratorId, "Read", 1);
		const spy = spyOn(worktreeTreeSnapshot, "tryCaptureHot");
		try {
			await hooks.onSnapshotBefore?.(toolUseId, "Read", { file_path: join(repo, "a.txt") });
			await hooks.onSnapshotAfter?.(toolUseId, "Read");
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		const row = await readToolCallBoundaries(toolUseId);
		expect(row?.treeHashBefore).toBeNull();
		expect(row?.treeHashAfter).toBeNull();
	});

	test("a non-git subagent workspace installs no hooks at all", async () => {
		// `{}` rather than no-op hooks: the loop then never awaits a call that cannot
		// produce a boundary.
		const dir = mkdtempSync(join(tmpdir(), "nf-sa-snap-nongit-"));
		tempDirs.push(dir);
		const narratorId = await createSubagent(dir);
		const hooks = buildTreeSnapshotEventHooks({
			session: { cwd: dir },
			narratorId,
			isInGitRepo: false,
		});
		expect(hooks.onSnapshotBefore).toBeUndefined();
		expect(hooks.onSnapshotAfter).toBeUndefined();
	});

	test("a virtual Spec write skips tree capture without an unverified-target warning", async () => {
		const repo = await createRepo("nf-sa-snap-spec-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await hooks.onSnapshotBefore?.(toolUseId, "Write", {
				file_path: "spec://tasks.json",
				content: "{}",
			});
			await hooks.onSnapshotAfter?.(toolUseId, "Write");
			expect(warn).not.toHaveBeenCalledWith(
				"Tree snapshot skipped: tool target is not verified inside the local workspace",
				expect.anything(),
			);
		} finally {
			warn.mockRestore();
		}
		const row = await readToolCallBoundaries(toolUseId);
		expect(row?.treeHashBefore).toBeNull();
		expect(row?.treeHashAfter).toBeNull();
	});

	test("a remote-targeted subagent records null boundaries", async () => {
		// Remote workspaces have no shadow repository; the per-file path still covers
		// them, so this must degrade rather than fail.
		const repo = await createRepo("nf-sa-snap-remote-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo, _defaultDeviceId: "remote-a" };
		const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
		writeFileSync(join(repo, "a.txt"), "one\n");

		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
		await hooks.onSnapshotBefore?.(toolUseId, "Write", { file_path: join(repo, "a.txt") });
		writeFileSync(join(repo, "a.txt"), "two\n");
		await hooks.onSnapshotAfter?.(toolUseId, "Write");

		const row = await readToolCallBoundaries(toolUseId);
		expect(row?.treeHashBefore).toBeNull();
		expect(row?.treeHashAfter).toBeNull();
	});

	for (const target of [
		"remote-override",
		"local-override-remote-default",
		"outside",
		"workdir",
	] as const) {
		test(`unverified ${target} records unknown boundaries, not a local no-op`, async () => {
			const repo = await createRepo("nf-sa-snap-unknown-target-");
			const narratorId = await createSubagent(repo);
			const session: TreeSnapshotSession = {
				cwd: repo,
				...(target === "local-override-remote-default" && { _defaultDeviceId: "remote-a" }),
			};
			const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
			const toolName = target === "workdir" ? "Bash" : "Write";
			const { toolUseId } = await seedToolCall(narratorId, toolName, 1);
			writeFileSync(join(repo, "a.txt"), "local bytes\n");
			const input = {
				file_path: target === "outside" ? join(repo, "..", "outside.txt") : join(repo, "a.txt"),
				...(target === "remote-override" && { device: "remote-a" }),
				...(target === "local-override-remote-default" && { device: "local" }),
				...(target === "workdir" && { command: "...", workdir: join(repo, "..") }),
			};
			const capture = spyOn(worktreeTreeSnapshot, "tryCaptureHot");
			try {
				await hooks.onSnapshotBefore?.(toolUseId, toolName, input);
				await hooks.onSnapshotAfter?.(toolUseId, toolName);
				expect(capture).not.toHaveBeenCalled();
			} finally {
				capture.mockRestore();
			}
			const row = await readToolCallBoundaries(toolUseId);
			expect(row?.treeHashBefore).toBeNull();
			expect(row?.treeHashAfter).toBeNull();
			expect(row?.ownedPathsJson).toBeNull();
		});
	}

	test("a remote retry clears earlier local evidence and never consumes the session cache", async () => {
		const repo = await createRepo("nf-sa-snap-remote-retry-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
		const { toolUseId, messageId } = await seedToolCall(narratorId, "Write", 1);
		writeFileSync(join(repo, "a.txt"), "before\n");
		await hooks.onSnapshotBefore?.(toolUseId, "Write", { file_path: join(repo, "a.txt") });
		writeFileSync(join(repo, "a.txt"), "after\n");
		await hooks.onSnapshotAfter?.(toolUseId, "Write");
		expect(session._lastTreeHash).toMatch(/^[0-9a-f]{40}$/);
		expect((await readToolCallBoundaries(toolUseId))?.ownedPathsJson).toEqual(["a.txt"]);

		// Re-execution may reuse the row after the default device changed. Even an
		// explicit local override cannot prove that the remote session cwd is local.
		session._defaultDeviceId = "remote-a";
		const capture = spyOn(worktreeTreeSnapshot, "tryCaptureHot");
		try {
			await hooks.onSnapshotBefore?.(toolUseId, "Write", {
				file_path: join(repo, "a.txt"),
				device: "local",
			});
			await hooks.onSnapshotAfter?.(toolUseId, "Write");
			expect(capture).not.toHaveBeenCalled();
		} finally {
			capture.mockRestore();
		}
		expect(await readToolCallBoundaries(toolUseId)).toEqual({
			treeHashBefore: null,
			treeHashAfter: null,
			ownedPathsJson: null,
		});
		const message = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { treeHashAfter: true },
		});
		expect(message?.treeHashAfter).toBeNull();
	});

	test("an explicit local override in a local session still records a real boundary", async () => {
		const repo = await createRepo("nf-sa-snap-local-override-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
		writeFileSync(join(repo, "a.txt"), "before\n");
		await hooks.onSnapshotBefore?.(toolUseId, "Write", {
			file_path: join(repo, "a.txt"),
			device: "local",
		});
		writeFileSync(join(repo, "a.txt"), "after\n");
		await hooks.onSnapshotAfter?.(toolUseId, "Write");
		expect((await readToolCallBoundaries(toolUseId))?.ownedPathsJson).toEqual(["a.txt"]);
	});

	test("a canonical alias of the local workspace still records a boundary", async () => {
		// Session cwd can be a symlink while the frozen target carries the real path.
		// Those are the same worktree; skipping would drop every later revert boundary.
		const repo = await createRepo("nf-sa-snap-alias-");
		const real = realpathSync(repo);
		const linkDir = mkdtempSync(join(tmpdir(), "nf-sa-snap-alias-link-"));
		tempDirs.push(linkDir);
		const link = join(linkDir, "workspace");
		symlinkSync(real, link, "dir");
		const narratorId = await createSubagent(link);
		const session: TreeSnapshotSession = { cwd: link };
		const canonicalFile = join(real, "a.txt");
		writeFileSync(canonicalFile, "before\n");
		const hooks = buildTreeSnapshotEventHooks({
			session,
			narratorId,
			isInGitRepo: true,
			executionTarget: {
				deviceId: "local",
				backendKind: "local",
				cwd: real,
				canonicalPath: canonicalFile,
				selectionSource: "local_default",
			},
		});
		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await hooks.onSnapshotBefore?.(toolUseId, "Write", { file_path: canonicalFile });
			writeFileSync(canonicalFile, "after\n");
			await hooks.onSnapshotAfter?.(toolUseId, "Write");
			expect(warn).not.toHaveBeenCalledWith(
				"Tree snapshot skipped: tool target is not verified inside the local workspace",
				expect.anything(),
			);
		} finally {
			warn.mockRestore();
			rmSync(treeSnapshotPhysicalDir(LOCAL_DEVICE_ID, link), { recursive: true, force: true });
			await db
				.delete(worktreeTreeSnapshots)
				.where(eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(link)));
		}
		const row = await readToolCallBoundaries(toolUseId);
		expect(row?.treeHashBefore).toMatch(/^[0-9a-f]{40}$/);
		expect(row?.treeHashAfter).toMatch(/^[0-9a-f]{40}$/);
		expect(row?.treeHashBefore).not.toBe(row?.treeHashAfter);
		expect(row?.ownedPathsJson).toEqual(["a.txt"]);
	});

	test("a trailing-slash workspace cwd is the same local target", async () => {
		const repo = await createRepo("nf-sa-snap-slash-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "before\n");
		const hooks = buildTreeSnapshotEventHooks({
			session,
			narratorId,
			isInGitRepo: true,
			executionTarget: {
				deviceId: "local",
				backendKind: "local",
				cwd: `${repo}/`,
				canonicalPath: join(repo, "a.txt"),
				selectionSource: "local_default",
			},
		});
		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
		await hooks.onSnapshotBefore?.(toolUseId, "Write", { file_path: join(repo, "a.txt") });
		writeFileSync(join(repo, "a.txt"), "after\n");
		await hooks.onSnapshotAfter?.(toolUseId, "Write");
		expect((await readToolCallBoundaries(toolUseId))?.ownedPathsJson).toEqual(["a.txt"]);
	});

	test("a symlink that leaves the workspace is not recorded as a local no-op", async () => {
		const repo = await createRepo("nf-sa-snap-escape-");
		const outside = mkdtempSync(join(tmpdir(), "nf-sa-snap-escape-out-"));
		tempDirs.push(outside);
		symlinkSync(outside, join(repo, "escape"), "dir");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const canonicalFile = join(realpathSync(outside), "secret.txt");
		const hooks = buildTreeSnapshotEventHooks({
			session,
			narratorId,
			isInGitRepo: true,
			executionTarget: {
				deviceId: "local",
				backendKind: "local",
				cwd: repo,
				canonicalPath: canonicalFile,
				selectionSource: "local_default",
			},
		});
		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
		const capture = spyOn(worktreeTreeSnapshot, "tryCaptureHot");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await hooks.onSnapshotBefore?.(toolUseId, "Write", {
				file_path: join(repo, "escape", "secret.txt"),
			});
			await hooks.onSnapshotAfter?.(toolUseId, "Write");
			expect(capture).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith(
				"Tree snapshot skipped: tool target is not verified inside the local workspace",
				expect.objectContaining({ reason: "canonical_path" }),
			);
		} finally {
			capture.mockRestore();
			warn.mockRestore();
		}
		expect(await readToolCallBoundaries(toolUseId)).toEqual({
			treeHashBefore: null,
			treeHashAfter: null,
			ownedPathsJson: null,
		});
	});

	test("bash workdir inside the workspace still records a boundary", async () => {
		const repo = await createRepo("nf-sa-snap-subdir-");
		mkdirSync(join(repo, "sub"));
		writeFileSync(join(repo, "sub", "b.txt"), "before\n");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const sub = join(repo, "sub");
		const dot = buildTreeSnapshotEventHooks({
			session,
			narratorId,
			isInGitRepo: true,
			executionTarget: {
				deviceId: "local",
				backendKind: "local",
				cwd: repo,
				selectionSource: "local_default",
			},
		});
		const dotCall = await seedToolCall(narratorId, "Bash", 1);
		await dot.onSnapshotBefore?.(dotCall.toolUseId, "Bash", { command: "...", workdir: "." });
		writeFileSync(join(repo, "a.txt"), "from-dot\n");
		await dot.onSnapshotAfter?.(dotCall.toolUseId, "Bash");
		expect((await readToolCallBoundaries(dotCall.toolUseId))?.ownedPathsJson).toEqual(["a.txt"]);

		const nested = buildTreeSnapshotEventHooks({
			session,
			narratorId,
			isInGitRepo: true,
			executionTarget: {
				deviceId: "local",
				backendKind: "local",
				cwd: sub,
				selectionSource: "local_default",
			},
		});
		const nestedCall = await seedToolCall(narratorId, "Bash", 2);
		await nested.onSnapshotBefore?.(nestedCall.toolUseId, "Bash", {
			command: "...",
			workdir: "sub",
		});
		writeFileSync(join(repo, "sub", "b.txt"), "after\n");
		await nested.onSnapshotAfter?.(nestedCall.toolUseId, "Bash");
		const row = await readToolCallBoundaries(nestedCall.toolUseId);
		expect(row?.treeHashBefore).toMatch(/^[0-9a-f]{40}$/);
		expect(row?.treeHashAfter).not.toBe(row?.treeHashBefore);
		expect(row?.ownedPathsJson).toEqual(["sub/b.txt"]);
	});

	test("a bash workdir that symlinks out of the workspace stays unverified", async () => {
		const repo = await createRepo("nf-sa-snap-wd-escape-");
		const outside = mkdtempSync(join(tmpdir(), "nf-sa-snap-wd-escape-out-"));
		tempDirs.push(outside);
		symlinkSync(outside, join(repo, "linked-out"), "dir");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const linked = join(repo, "linked-out");
		const hooks = buildTreeSnapshotEventHooks({
			session,
			narratorId,
			isInGitRepo: true,
			executionTarget: {
				deviceId: "local",
				backendKind: "local",
				cwd: linked,
				selectionSource: "local_default",
			},
		});
		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		const capture = spyOn(worktreeTreeSnapshot, "tryCaptureHot");
		try {
			await hooks.onSnapshotBefore?.(toolUseId, "Bash", {
				command: "...",
				workdir: "linked-out",
			});
			await hooks.onSnapshotAfter?.(toolUseId, "Bash");
			expect(capture).not.toHaveBeenCalled();
		} finally {
			capture.mockRestore();
		}
		expect(await readToolCallBoundaries(toolUseId)).toEqual({
			treeHashBefore: null,
			treeHashAfter: null,
			ownedPathsJson: null,
		});
	});

	test("a missing bash workdir stays unverified", async () => {
		const repo = await createRepo("nf-sa-snap-missing-wd-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const missing = join(repo, "missing");
		const hooks = buildTreeSnapshotEventHooks({
			session,
			narratorId,
			isInGitRepo: true,
			executionTarget: {
				deviceId: "local",
				backendKind: "local",
				cwd: missing,
				selectionSource: "local_default",
			},
		});
		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		const capture = spyOn(worktreeTreeSnapshot, "tryCaptureHot");
		try {
			await hooks.onSnapshotBefore?.(toolUseId, "Bash", { command: "...", workdir: "missing" });
			await hooks.onSnapshotAfter?.(toolUseId, "Bash");
			expect(capture).not.toHaveBeenCalled();
		} finally {
			capture.mockRestore();
		}
		expect(await readToolCallBoundaries(toolUseId)).toEqual({
			treeHashBefore: null,
			treeHashAfter: null,
			ownedPathsJson: null,
		});
	});

	test("the treeSnapshotsEnabled escape hatch applies to subagents too", async () => {
		// The setting exists for worktrees whose whole-tree scan is not viable at all.
		// It gates `captureSessionTree`, so it has to reach the subagent path as well —
		// otherwise turning it off would still leave subagents scanning.
		const repo = await createRepo("nf-sa-snap-disabled-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
		writeFileSync(join(repo, "a.txt"), "one\n");

		const previous = settings.workspace.treeSnapshotsEnabled;
		settings.workspace.treeSnapshotsEnabled = false;
		try {
			const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
			await hooks.onSnapshotBefore?.(toolUseId, "Write", { file_path: join(repo, "a.txt") });
			writeFileSync(join(repo, "a.txt"), "two\n");
			await hooks.onSnapshotAfter?.(toolUseId, "Write");

			const row = await readToolCallBoundaries(toolUseId);
			expect(row?.treeHashBefore).toBeNull();
			expect(row?.treeHashAfter).toBeNull();
			expect(session._lastTreeHash).toBeUndefined();
		} finally {
			settings.workspace.treeSnapshotsEnabled = previous;
		}

		// Re-enabled, the same session captures again — the disabled window left no
		// poisoned cache behind.
		const second = await seedToolCall(narratorId, "Write", 2);
		await hooks.onSnapshotBefore?.(second.toolUseId, "Write", {
			file_path: join(repo, "a.txt"),
		});
		writeFileSync(join(repo, "a.txt"), "three\n");
		await hooks.onSnapshotAfter?.(second.toolUseId, "Write");
		const row = await readToolCallBoundaries(second.toolUseId);
		expect(row?.treeHashBefore).toMatch(/^[0-9a-f]{40}$/);
	}, 30_000);
});

/**
 * The reason `onSnapshotBefore` may never block indefinitely.
 *
 * It is awaited inside the narrator's event consumer, so until it returns the tool
 * does not reach its permission gate, its timeout has not started, and every later
 * event of the turn is queued behind it — the session appears frozen at "streaming
 * started". A worktree whose full scan exceeds the budget must therefore cost a null
 * boundary, never the turn.
 */
describe("subagent snapshot hooks never block the loop", () => {
	test("an over-budget capture returns instead of stalling the hook", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-sa-snap-budget-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
		writeFileSync(join(repo, "a.txt"), "one\n");
		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);

		// A capture that never finishes on its own — the pathological huge-worktree
		// scan, in its purest form. Aborted via the signal the warm-up path passes it,
		// so the test cannot leak a live process.
		const spy = spyOn(worktreeTreeSnapshot, "capture").mockImplementation(
			(_worktreePath, _deviceId, captureOpts) =>
				new Promise<string>((_resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error("hung capture outlived the test")),
						30_000,
					);
					captureOpts?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				}),
		);
		// Same real budget path, shorter budget: the production 4 s budget elapses twice (before
		// and after hooks), which made this case ~8 s of waiting. Only "the hook returns once its
		// budget expires instead of waiting for the hung scan" is under test.
		const realHot = worktreeTreeSnapshot.tryCaptureHot.bind(worktreeTreeSnapshot);
		const hot = spyOn(worktreeTreeSnapshot, "tryCaptureHot").mockImplementation(
			(path, deviceId, hotOpts) => realHot(path, deviceId, { ...hotOpts, budgetMs: 400 }),
		);
		try {
			const startedAt = Date.now();
			// The hook must return at its budget and NOT wait for the hung scan. Asserting
			// the elapsed time is the whole point — a version that awaited the capture would
			// sit here for 30 s.
			await hooks.onSnapshotBefore?.(toolUseId, "Write", { file_path: join(repo, "a.txt") });
			const elapsed = Date.now() - startedAt;
			expect(elapsed).toBeLessThan(10_000);
			expect(hot).toHaveBeenCalled();

			// The tool proceeds and its result hook also returns, with no boundary
			// recorded: degraded to per-file replay, which is the designed fallback.
			writeFileSync(join(repo, "a.txt"), "two\n");
			await hooks.onSnapshotAfter?.(toolUseId, "Write");

			const row = await readToolCallBoundaries(toolUseId);
			expect(row?.treeHashBefore).toBeNull();
			expect(row?.treeHashAfter).toBeNull();
		} finally {
			hot.mockRestore();
			spy.mockRestore();
			// Kill the promoted background warm-up so the hung mock cannot outlive this
			// test; a direct capture preempts an in-flight warm-up by contract.
			await worktreeTreeSnapshot.capture(repo).catch(() => {});
			resetHotPathCaptureStateForTests();
		}
	}, 30_000);

	test("a capture failure degrades to a null boundary rather than throwing", async () => {
		// Snapshotting must never break a turn: the hooks swallow every failure.
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-sa-snap-failure-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);

		const spy = spyOn(worktreeTreeSnapshot, "capture").mockImplementation(() =>
			Promise.reject(new Error("shadow repo is on fire")),
		);
		try {
			await hooks.onSnapshotBefore?.(toolUseId, "Write", { file_path: join(repo, "a.txt") });
			await hooks.onSnapshotAfter?.(toolUseId, "Write");
		} finally {
			spy.mockRestore();
			resetHotPathCaptureStateForTests();
		}

		const row = await readToolCallBoundaries(toolUseId);
		expect(row?.treeHashBefore).toBeNull();
		expect(row?.treeHashAfter).toBeNull();
	});
});

describe("local subagent execution retains claims without capture", () => {
	beforeEach(() => {
		restorePolicy();
		settings.workspace.treeSnapshotsEnabled = true;
	});
	for (const toolName of ["Write", "Edit", "StructSed", "Bash", "GenUI"]) {
		test(`${toolName} leaves no background or hot scan with the legacy setting enabled`, async () => {
			const repo = await createRepo("nf-sa-local-disabled-");
			const narratorId = await createSubagent(repo);
			const { toolUseId } = await seedToolCall(narratorId, toolName, 1);
			const session: TreeSnapshotSession = {
				cwd: repo,
				_lastTreeHash: "stale",
				_lastTreeHashAt: Date.now(),
				_treeHashBefore: new Map([[toolUseId, "a".repeat(40)]]),
			};
			const hooks = buildTreeSnapshotExecutionHooks({ session, narratorId, isInGitRepo: true });
			const input =
				toolName === "Bash"
					? { command: "true" }
					: toolName === "GenUI"
						? { action: "create", prefix: "fixture" }
						: { file_path: join(repo, "target.txt") };
			const context = {
				toolUse: { name: toolName, toolUseId, input },
				effectiveInput: input,
				binding: { toolCallId: "unused-fixture-id", attempt: 1 },
				executionTarget: {
					deviceId: "local",
					backendKind: "local" as const,
					cwd: repo,
					selectionSource: "local_default" as const,
				},
			};
			const hot = spyOn(worktreeTreeSnapshot, "tryCaptureHot");
			const capture = spyOn(worktreeTreeSnapshot, "capture");
			try {
				await hooks.onToolExecutionBefore?.(context);
				expect(peekClaim(repo, toolUseId)?.to).toBeNull();
				await hooks.onToolExecutionAfter?.({ ...context, result: { output: "ok" } });
				await new Promise<void>((done) => setImmediate(done));
				expect(peekClaim(repo, toolUseId)?.to).toBeNumber();
				expect(hot).not.toHaveBeenCalled();
				expect(capture).not.toHaveBeenCalled();
				expect(session._treeHashBefore?.size).toBe(0);
				expect(session._lastTreeHash).toBeUndefined();
				expect(session._lastTreeHashAt).toBeUndefined();
			} finally {
				hot.mockRestore();
				capture.mockRestore();
			}
		});
	}

	test("an after-hook exception seals the local write claim", async () => {
		const repo = await createRepo("nf-sa-local-after-error-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotExecutionHooks({ session, narratorId, isInGitRepo: true });
		const input = { file_path: join(repo, "target.txt") };
		const context = {
			toolUse: { name: "Write", toolUseId: generateId(), input },
			effectiveInput: input,
			binding: { toolCallId: "unused-fixture-id", attempt: 1 },
			executionTarget: {
				deviceId: "local",
				backendKind: "local" as const,
				cwd: repo,
				selectionSource: "local_default" as const,
			},
		};
		await hooks.onToolExecutionBefore?.(context);
		expect(peekClaim(repo, context.toolUse.toolUseId)?.to).toBeNull();
		const after = spyOn(snapshotHooks, "recordTreeSnapshotAfter").mockRejectedValue(
			new Error("fixture"),
		);
		try {
			await expect(
				hooks.onToolExecutionAfter?.({ ...context, result: { output: "ok" } }),
			).rejects.toThrow("fixture");
			expect(peekClaim(repo, context.toolUse.toolUseId)?.to).toBeNumber();
			expect(peekClaim(repo, context.toolUse.toolUseId)?.declared).toEqual(["target.txt"]);
		} finally {
			after.mockRestore();
		}
	});
});
