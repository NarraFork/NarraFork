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
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	worktreeTreeSnapshots,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { normalizePathForComparison } from "../../lib/platform-path";
import { settings } from "../../lib/settings";
import { safeSpawn } from "../../lib/spawn";
import type { TreeSnapshotSession } from "../narrator-tree-snapshot-hooks";
import { buildTreeSnapshotEventHooks } from "../tree-snapshot-loop-hooks";
import { resetHotPathCaptureStateForTests, worktreeTreeSnapshot } from "../worktree-tree-snapshot";

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
		await worktreeTreeSnapshot.destroy(dir).catch(() => {});
		await db
			.delete(worktreeTreeSnapshots)
			.where(eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(dir)));
		rmSync(dir, { recursive: true, force: true });
	}
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

	test("a recorded subagent boundary is restorable, undoing the tool's writes", async () => {
		// The point of the tree path over per-file replay: the boundary is real bytes,
		// so restoring it works for a shell command whose writes no input describes.
		const repo = await createRepo("nf-sa-snap-restore-");
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

		await worktreeTreeSnapshot.restore(repo, beforeHash);
		expect(await worktreeTreeSnapshot.capture(repo)).toBe(beforeHash);
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

	test("the treeSnapshotsEnabled escape hatch applies to subagents too", async () => {
		// The setting exists for worktrees whose whole-tree scan is not viable at all.
		// It gates `captureSessionTree`, so it has to reach the subagent path as well —
		// otherwise turning it off would still leave subagents scanning.
		const repo = await createRepo("nf-sa-snap-disabled-");
		const narratorId = await createSubagent(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const hooks = buildTreeSnapshotEventHooks({ session, narratorId, isInGitRepo: true });
		writeFileSync(join(repo, "a.txt"), "one\n");

		const previous = settings.chapters.treeSnapshotsEnabled;
		settings.chapters.treeSnapshotsEnabled = false;
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
			settings.chapters.treeSnapshotsEnabled = previous;
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
	});
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
		try {
			const startedAt = Date.now();
			// The real budget is 4s; the hook must return well inside it and NOT wait
			// for the hung scan. Asserting the elapsed time is the whole point — a
			// version that awaited the capture would sit here for 30s.
			await hooks.onSnapshotBefore?.(toolUseId, "Write", { file_path: join(repo, "a.txt") });
			const elapsed = Date.now() - startedAt;
			expect(elapsed).toBeLessThan(10_000);

			// The tool proceeds and its result hook also returns, with no boundary
			// recorded: degraded to per-file replay, which is the designed fallback.
			writeFileSync(join(repo, "a.txt"), "two\n");
			await hooks.onSnapshotAfter?.(toolUseId, "Write");

			const row = await readToolCallBoundaries(toolUseId);
			expect(row?.treeHashBefore).toBeNull();
			expect(row?.treeHashAfter).toBeNull();
		} finally {
			spy.mockRestore();
			// Kill the promoted background warm-up so the hung mock cannot outlive this
			// test; destroy() aborts an in-flight warm-up by contract.
			await worktreeTreeSnapshot.destroy(repo).catch(() => {});
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
