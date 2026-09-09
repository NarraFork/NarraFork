/**
 * M0 deliberately retires the old v1 success assertions: whole-tree boundaries and
 * declared paths are not operation-content evidence. These tests keep real capture
 * hooks and mutations, but require rejection before either files or history move.
 * In particular, no helper clears the session tree cache after a foreign write.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
	fileAttributions,
	fileChangeOperations,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../db/schema";
import { generateId } from "../lib/id";
import { safeSpawn } from "../lib/spawn";
import {
	dedupeBoundaryRows,
	previewNarratorScopedForMessages,
	previewNarratorScopedForToolUses,
	previewNarratorScopedFromSeq,
	revertNarratorScopedForMessages,
	revertNarratorScopedForToolUses,
	revertNarratorScopedFromSeq,
	type ScopedRevertUnavailableReason,
} from "./narrator-scoped-revert";
import { narratorService } from "./narrator-service";
import { type ActiveNarrator, activeNarrators } from "./narrator-session-state";
import type { TreeSnapshotSession } from "./narrator-tree-snapshot-hooks";
import { commitSnapshotRevert, discardSnapshotRevert } from "./snapshot-revert";
import { buildTreeSnapshotEventHooks } from "./tree-snapshot-loop-hooks";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const ids: string[] = [];
const dirs: string[] = [];

async function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "nf-scoped-m0-"));
	dirs.push(repo);
	await safeSpawn({ cmd: ["git", "init"], cwd: repo, timeout: 15_000 });
	const narratorId = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({ id: narratorId, cwd: repo, createdAt: now, updatedAt: now });
	ids.push(narratorId);
	const session: TreeSnapshotSession = { cwd: repo };
	return { repo, narratorId, session };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type CallOptions = {
	seq?: number;
	toolName?: string;
	input?: Record<string, unknown>;
	status?: "success" | "fail" | "running" | "pending" | "initializing";
	capture?: "both" | "before" | "none";
	recordOperation?: boolean;
	isBackground?: boolean;
	executionDeviceId?: string;
	resolvedFilePath?: string;
	messageId?: string;
};

async function call(f: Fixture, mutate: () => void | Promise<void>, opts: CallOptions = {}) {
	const messageId = opts.messageId ?? generateId();
	const toolUseId = generateId();
	const toolName = opts.toolName ?? "Write";
	const input = opts.input ?? { file_path: join(f.repo, "a.txt"), content: "changed\n" };
	const createdAt = new Date().toISOString();
	if (!opts.messageId) {
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId: f.narratorId,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: toolName, input }],
			createdAt,
		});
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId: f.narratorId,
			messageId,
			seq: opts.seq ?? 1,
		});
	}
	const hooks = buildTreeSnapshotEventHooks({
		session: f.session,
		narratorId: f.narratorId,
		isInGitRepo: true,
	});
	// The production event handler captures before inserting the tool-call row.
	if (opts.capture !== "none") await hooks.onSnapshotBefore?.(toolUseId, toolName, input);
	const toolCallId = generateId();
	const operationId = opts.recordOperation ? generateId() : null;
	if (operationId) {
		// A real FK-bound pointer, deliberately WITHOUT settled/complete evidence.
		// The diagnostic must not treat its existence as permission to revert.
		await db.insert(fileChangeOperations).values({
			id: operationId,
			sourceInstanceId: "test-installation",
			sourceKind: "tool",
			sourceId: toolCallId,
			attempt: 1,
			narratorId: f.narratorId,
			actorSubjectKey: `primary:${f.narratorId}`,
			actorJson: {
				kind: "primary",
				subjectKey: `primary:${f.narratorId}`,
				narratorId: f.narratorId,
				userId: null,
				label: null,
				deleted: false,
				parentSubjectKey: null,
			},
			startedAt: createdAt,
			updatedAt: createdAt,
		});
	}
	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		fileChangeOperationId: operationId,
		narratorId: f.narratorId,
		messageId,
		toolUseId,
		toolName,
		inputJson: input,
		status: "running",
		createdAt,
		executionDeviceId: opts.executionDeviceId ?? "local",
		executionCwd: f.repo,
		executionPathFlavor: "posix",
		resolvedFilePath:
			opts.resolvedFilePath ?? (typeof input.file_path === "string" ? input.file_path : null),
		isBackground: opts.isBackground ?? false,
	});
	await mutate();
	await db
		.update(narratorToolCalls)
		.set({
			status: opts.status ?? "success",
			completedAt:
				opts.status === "running" || opts.status === "pending" || opts.status === "initializing"
					? null
					: new Date().toISOString(),
		})
		.where(eq(narratorToolCalls.toolUseId, toolUseId));
	if (!opts.capture || opts.capture === "both") await hooks.onSnapshotAfter?.(toolUseId, toolName);
	return { messageId, toolUseId };
}

async function expectRefused(f: Fixture, reason: ScopedRevertUnavailableReason, minSeq = 1) {
	const preview = await previewNarratorScopedFromSeq(f.narratorId, minSeq);
	expect(preview.available).toBe(false);
	expect(preview.reason).toBe(reason);
	const result = await revertNarratorScopedFromSeq(f.narratorId, minSeq);
	expect(result).toMatchObject({ reverted: false, fileCount: 0, files: [] });
	expect(result?.failures.map((failure) => failure.code)).toEqual(["REVERT_UNAVAILABLE"]);
	expect(result?.failures[0]?.message).toContain(reason);
	return result;
}

afterEach(async () => {
	for (const id of ids.splice(0).reverse()) {
		activeNarrators.delete(id);
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, id));
		await db.delete(fileChangeOperations).where(eq(fileChangeOperations.narratorId, id));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
		await db.delete(fileAttributions).where(eq(fileAttributions.narratorId, id));
		await db.delete(narrators).where(eq(narrators.id, id));
	}
	for (const dir of dirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("M0 complete operation coverage", () => {
	test.each([
		"success",
		"fail",
		"running",
		"pending",
		"initializing",
	] as const)("does not omit a %s call missing its after boundary from a mixed window", async (status) => {
		const f = await fixture();
		writeFileSync(join(f.repo, "a.txt"), "base\n");
		await call(f, () => writeFileSync(join(f.repo, "a.txt"), "first\n"));
		const incomplete = await call(f, () => writeFileSync(join(f.repo, "b.txt"), "partial\n"), {
			seq: 2,
			status,
			capture: "before",
			input: { file_path: join(f.repo, "b.txt"), content: "partial\n" },
		});
		// A historical non-terminal row is not proof that an operation is still alive.
		await expectRefused(f, "incomplete_coverage");
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("first\n");
		expect(readFileSync(join(f.repo, "b.txt"), "utf8")).toBe("partial\n");
		expect(
			await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.toolUseId, incomplete.toolUseId),
			}),
		).toMatchObject({ status });
	});

	test("a nonzero shell exit cannot erase the write it already made", async () => {
		const f = await fixture();
		await call(
			f,
			async () => {
				const result = await safeSpawn({
					cmd: ["sh", "-c", "printf 'partial\\n' > a.txt; exit 7"],
					cwd: f.repo,
					timeout: 15_000,
				});
				expect(result.exitCode).toBe(7);
			},
			{
				toolName: "Bash",
				input: { command: "printf 'partial\\n' > a.txt; exit 7" },
				status: "fail",
				capture: "before",
			},
		);
		await expectRefused(f, "incomplete_coverage");
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("partial\n");
	});

	test("background success and equal trees do not settle a late writer", async () => {
		const f = await fixture();
		await call(f, () => {}, {
			toolName: "Bash",
			input: { command: "background task", run_in_background: true },
			isBackground: true,
		});
		writeFileSync(join(f.repo, "a.txt"), "written after tool result\n");
		await expectRefused(f, "incomplete_coverage");
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("written after tool result\n");
	});

	test("local equal trees cannot prove a cwd-external Write was a no-op", async () => {
		const f = await fixture();
		const outside = mkdtempSync(join(tmpdir(), "nf-outside-m0-"));
		dirs.push(outside);
		const file = join(outside, "outside.txt");
		await call(f, () => writeFileSync(file, "outside changed\n"), {
			input: { file_path: file, content: "outside changed\n" },
		});
		await expectRefused(f, "unsupported_target");
		expect(readFileSync(file, "utf8")).toBe("outside changed\n");
	});

	test.each([
		true,
		false,
	])("a per-call remote override is not a local no-op (frozen target=%s)", async (frozen) => {
		const f = await fixture();
		await call(f, () => {}, {
			input: { file_path: "/remote/a.txt", device: "remote-device", content: "remote mutation" },
			executionDeviceId: frozen ? "remote-device" : "local",
		});
		await expectRefused(f, "unsupported_target");
	});

	test("an equal-tree disk Edit still needs actual operation evidence", async () => {
		const f = await fixture();
		writeFileSync(join(f.repo, "a.txt"), "unchanged\n");
		await call(f, () => {}, { toolName: "Edit" });
		await expectRefused(f, "legacy_unverified");
	});

	test("only a genuine spec URI is a no-disk no-op, even without tree boundaries", async () => {
		const f = await fixture();
		await call(f, () => {}, {
			input: { file_path: "spec://tasks.json", content: "{}" },
			capture: "none",
		});
		expect(await revertNarratorScopedFromSeq(f.narratorId, 1)).toMatchObject({
			reverted: false,
			fileCount: 0,
			failures: [],
		});
		expect(await previewNarratorScopedFromSeq(f.narratorId, 1)).toMatchObject({
			available: true,
			reason: "nothing_owned",
		});
	});

	test("a spec call cannot hide a second disk call without evidence", async () => {
		const f = await fixture();
		await call(f, () => {}, { input: { file_path: "spec://tasks.json" }, capture: "none" });
		await call(f, () => writeFileSync(join(f.repo, "a.txt"), "changed\n"), {
			seq: 2,
			capture: "none",
		});
		await expectRefused(f, "incomplete_coverage");
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("changed\n");
	});

	test("a read-only call needs no filesystem restore", async () => {
		const f = await fixture();
		await call(f, () => {}, { toolName: "Read", capture: "none" });
		expect(await revertNarratorScopedFromSeq(f.narratorId, 1)).toMatchObject({
			failures: [],
			fileCount: 0,
		});
	});

	test("unrecorded history is unavailable, not silently successful", async () => {
		const f = await fixture();
		await expectRefused(f, "no_boundaries");
	});

	test("the operation cap includes unsuccessful calls with no hashes", async () => {
		const f = await fixture();
		const first = await call(f, () => {}, { toolName: "Read", capture: "none" });
		for (let index = 0; index < 1_001; index++) {
			await db.insert(narratorToolCalls).values({
				id: generateId(),
				narratorId: f.narratorId,
				messageId: first.messageId,
				toolUseId: `missing-${index}`,
				toolName: "Bash",
				status: "fail",
				createdAt: new Date().toISOString(),
			});
		}
		await expectRefused(f, "window_too_large");
	});
});

describe("M0 rejects unverified ownership without mutation", () => {
	test("AI1 -> human same-file hunk -> AI2 preserves all bytes without clearing cache", async () => {
		const f = await fixture();
		writeFileSync(join(f.repo, "a.txt"), "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\n");
		await call(f, () => writeFileSync(join(f.repo, "a.txt"), "AI1\nB\nC\nD\nE\nF\nG\nH\nI\nJ\n"));
		expect(f.session._lastTreeHash).toBeTruthy();
		writeFileSync(join(f.repo, "a.txt"), "AI1\nB\nC\nD\nE\nF\nG\nH\nI\nHUMAN\n");
		await call(
			f,
			() => writeFileSync(join(f.repo, "a.txt"), "AI2\nB\nC\nD\nE\nF\nG\nH\nI\nHUMAN\n"),
			{ seq: 2 },
		);
		await expectRefused(f, "legacy_unverified", 2);
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe(
			"AI2\nB\nC\nD\nE\nF\nG\nH\nI\nHUMAN\n",
		);
	});

	test("chained pairs cannot union declared paths and roll back a neighbour's earlier b", async () => {
		const f = await fixture();
		writeFileSync(join(f.repo, "a.txt"), "base a\n");
		writeFileSync(join(f.repo, "b.txt"), "base b\n");
		await call(f, () => {
			writeFileSync(join(f.repo, "a.txt"), "AI a\n");
			writeFileSync(join(f.repo, "b.txt"), "HUMAN b\n");
		});
		await call(f, () => writeFileSync(join(f.repo, "b.txt"), "AI over HUMAN b\n"), {
			seq: 2,
			input: { file_path: join(f.repo, "b.txt"), content: "AI over HUMAN b\n" },
		});
		await expectRefused(f, "legacy_unverified");
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("AI a\n");
		expect(readFileSync(join(f.repo, "b.txt"), "utf8")).toBe("AI over HUMAN b\n");
	});

	test("legacy rejection registers no compensation capable of overwriting later work", async () => {
		const f = await fixture();
		await call(f, () => writeFileSync(join(f.repo, "a.txt"), "AI\n"));
		const result = await expectRefused(f, "legacy_unverified");
		if (!result) throw new Error("expected a refusal result");
		let historyCommitted = false;
		await expect(
			commitSnapshotRevert(result, () => {
				historyCommitted = true;
			}),
		).rejects.toThrow("REVERT_UNAVAILABLE");
		expect(historyCommitted).toBe(false);
		writeFileSync(join(f.repo, "a.txt"), "later human\n");
		expect(await discardSnapshotRevert(result)).toEqual([]);
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("later human\n");
	});

	test.each([
		true,
		false,
	])("an active loop does not mask permanent legacy refusal (same narrator=%s)", async (sameNarrator) => {
		const f = await fixture();
		const active = sameNarrator ? f : await fixture();
		await call(f, () => writeFileSync(join(f.repo, "a.txt"), "AI\n"));
		// A live loop may just be thinking/reading. Even a real writer does not
		// make waiting sufficient to turn legacy evidence into an executable plan.
		activeNarrators.set(active.narratorId, {
			cwd: f.repo,
			alive: true,
			_loopRunning: true,
		} as ActiveNarrator);
		await expectRefused(f, "legacy_unverified");
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("AI\n");
	});

	test("active incomplete writes remain blocked without claiming waiting will enable rollback", async () => {
		const f = await fixture();
		await call(f, () => writeFileSync(join(f.repo, "a.txt"), "partial\n"), {
			status: "running",
			capture: "before",
		});
		activeNarrators.set(f.narratorId, {
			cwd: f.repo,
			alive: true,
			_loopRunning: true,
		} as ActiveNarrator);
		await expectRefused(f, "incomplete_coverage");
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("partial\n");
	});

	test.each([
		"none",
		"both",
	] as const)("an operation pointer identifies the unconnected entrypoint without authorizing rollback (trees=%s)", async (capture) => {
		const f = await fixture();
		const target = await call(f, () => writeFileSync(join(f.repo, "a.txt"), "AI\n"), {
			recordOperation: true,
			capture,
		});
		await expectRefused(f, "execution_unavailable");
		for (const preview of [
			await previewNarratorScopedForMessages(f.narratorId, [target.messageId]),
			await previewNarratorScopedForToolUses(f.narratorId, [target]),
		]) {
			expect(preview).toMatchObject({ available: false, reason: "execution_unavailable" });
		}
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("AI\n");
		expect(
			await db.query.fileChangeOperations.findFirst({
				where: eq(fileChangeOperations.narratorId, f.narratorId),
				columns: { settlement: true, coverage: true },
			}),
		).toMatchObject({ settlement: "preparing", coverage: "unavailable" });
	});

	test.each([
		true,
		false,
	])("a new operation pointer cannot mask another legacy call (new operation first=%s)", async (newFirst) => {
		const f = await fixture();
		await call(f, () => writeFileSync(join(f.repo, "a.txt"), "first\n"), {
			recordOperation: newFirst,
		});
		await call(f, () => writeFileSync(join(f.repo, "a.txt"), "second\n"), {
			seq: 2,
			recordOperation: !newFirst,
		});
		await expectRefused(f, "legacy_unverified");
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("second\n");
	});
});

describe("M0 selector and history safety", () => {
	test("all three selectors refuse the same legacy call", async () => {
		const f = await fixture();
		const target = await call(f, () => writeFileSync(join(f.repo, "a.txt"), "changed\n"));
		for (const result of [
			await revertNarratorScopedForMessages(f.narratorId, [target.messageId]),
			await revertNarratorScopedForToolUses(f.narratorId, [target]),
		]) {
			expect(result?.failures[0]?.code).toBe("REVERT_UNAVAILABLE");
			expect(result?.failures[0]?.message).toContain("legacy_unverified");
		}
		expect((await previewNarratorScopedForToolUses(f.narratorId, [target])).reason).toBe(
			"legacy_unverified",
		);
		expect((await previewNarratorScopedForMessages(f.narratorId, [target.messageId])).reason).toBe(
			"legacy_unverified",
		);
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("changed\n");
	});

	test("an explicitly empty selector is a no-op rather than all history", async () => {
		const f = await fixture();
		await call(f, () => writeFileSync(join(f.repo, "a.txt"), "changed\n"));
		for (const result of [
			await revertNarratorScopedForMessages(f.narratorId, []),
			await revertNarratorScopedForToolUses(f.narratorId, []),
		]) {
			expect(result).toMatchObject({ fileCount: 0, failures: [] });
		}
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("changed\n");
	});

	test("a missing selected tool is not covered by a neighbouring spec no-op", async () => {
		const f = await fixture();
		const spec = await call(f, () => {}, {
			input: { file_path: "spec://tasks.json" },
			capture: "none",
		});
		const result = await revertNarratorScopedForToolUses(f.narratorId, [
			spec,
			{ messageId: spec.messageId, toolUseId: "missing" },
		]);
		expect(result?.failures[0]?.message).toContain("incomplete_coverage");
	});

	test("a missing selected message cannot hide behind a spec-only neighbour", async () => {
		const f = await fixture();
		const spec = await call(f, () => {}, {
			input: { file_path: "spec://tasks.json" },
			capture: "none",
		});
		const result = await revertNarratorScopedForMessages(f.narratorId, [
			spec.messageId,
			"missing-message",
		]);
		expect(result.failures[0]?.message).toContain("incomplete_coverage");
	});

	test("an unknown plugin call is not proof of no disk mutations", async () => {
		const f = await fixture();
		await call(f, () => writeFileSync(join(f.repo, "a.txt"), "plugin\n"), {
			toolName: "plugin-write",
			capture: "none",
		});
		await expectRefused(f, "incomplete_coverage");
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("plugin\n");
	});

	test("shared-message tools cannot disappear because their author differs from the ref owner", async () => {
		const owner = await fixture();
		const fork = await fixture();
		const target = await call(owner, () => writeFileSync(join(owner.repo, "a.txt"), "owner\n"), {
			capture: "none",
		});
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId: fork.narratorId,
			messageId: target.messageId,
			seq: 1,
		});
		await expectRefused(fork, "unsupported_target");
		expect(readFileSync(join(owner.repo, "a.txt"), "utf8")).toBe("owner\n");
	});

	test("rejection keeps every batch block and file; explicit skipRevert still deletes history only", async () => {
		const f = await fixture();
		const first = await call(f, () => writeFileSync(join(f.repo, "a.txt"), "first\n"));
		const second = await call(f, () => writeFileSync(join(f.repo, "b.txt"), "partial\n"), {
			seq: 2,
			capture: "before",
			status: "fail",
			input: { file_path: join(f.repo, "b.txt") },
		});
		const blocks = [first, second].map(({ messageId }) => ({ messageId, blockIndex: 0 }));
		await expect(narratorService.deleteMessageBlocks(f.narratorId, blocks)).rejects.toThrow(
			"REVERT_UNAVAILABLE",
		);
		for (const target of [first, second]) {
			expect(
				await db.query.narratorMessageRefs.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, f.narratorId),
						eq(narratorMessageRefs.messageId, target.messageId),
					),
				}),
			).toBeTruthy();
		}
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("first\n");
		expect(readFileSync(join(f.repo, "b.txt"), "utf8")).toBe("partial\n");
		const skipped = await narratorService.deleteMessageBlocks(f.narratorId, blocks, {
			skipRevert: true,
		});
		expect(skipped.deleted).toBe(2);
		expect(readFileSync(join(f.repo, "b.txt"), "utf8")).toBe("partial\n");
	});

	test("legacy preview deduplication never turns different claims into one", () => {
		const row = {
			toolUseId: "tool",
			messageId: "msg",
			seq: 1,
			before: "a",
			after: "b",
			ownedPaths: ["a.txt"],
		};
		expect(dedupeBoundaryRows([row, { ...row, messageId: "clone" }])).toEqual([row]);
		const other = { ...row, ownedPaths: ["b.txt"] };
		expect(dedupeBoundaryRows([row, other])).toEqual([row, other]);
	});
});
