import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
	fileAttributions,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	worktreeTreeSnapshots,
} from "../db/schema";
import { generateId } from "../lib/id";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import { recordAttribution } from "./file-attribution-service";
import {
	previewNarratorScopedFromSeq,
	revertNarratorScopedForMessages,
	revertNarratorScopedFromSeq,
} from "./narrator-scoped-revert";
import {
	recordTreeSnapshotAfter,
	recordTreeSnapshotBefore,
	type TreeSnapshotSession,
} from "./narrator-tree-snapshot-hooks";
import { discardSnapshotRevert, finalizeSnapshotRevert } from "./snapshot-revert";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

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

async function createNarrator(cwd: string, parentNarratorId?: string): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		cwd,
		createdAt: now,
		updatedAt: now,
		...(parentNarratorId ? { parentNarratorId, type: "subagent" } : {}),
	});
	createdNarrators.push(id);
	return id;
}

/** Run one tool "turn": snapshot, apply the mutation, snapshot again. */
async function runToolTurn(
	session: TreeSnapshotSession,
	narratorId: string,
	seq: number,
	mutate: () => void,
	toolName = "Write",
): Promise<{ toolUseId: string; messageId: string }> {
	const messageId = generateId();
	const toolUseId = generateId();
	const now = new Date(Date.now() + seq).toISOString();
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

	await recordTreeSnapshotBefore(session, narratorId, toolUseId);
	mutate();
	await recordTreeSnapshotAfter(session, narratorId, toolUseId);
	return { toolUseId, messageId };
}

/**
 * Simulate a change by someone else (another narrator, the user's editor).
 *
 * The session cache must be dropped: the next capture has to read the real
 * workspace rather than reuse a hash taken before this write.
 */
function outsideChange(session: TreeSnapshotSession, mutate: () => void): void {
	mutate();
	session._lastTreeHash = undefined;
}

afterEach(async () => {
	// Reverse creation order: `parentNarratorId` is a self-reference without
	// ON DELETE, so a subagent row must go before the parent it points at.
	for (const narratorId of createdNarrators.splice(0).reverse()) {
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
		await db.delete(fileAttributions).where(eq(fileAttributions.narratorId, narratorId));
		await db.delete(narrators).where(eq(narrators.id, narratorId));
	}
	for (const dir of tempDirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir).catch(() => {});
		await db
			.delete(worktreeTreeSnapshots)
			.where(eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(dir)));
		await db
			.delete(fileAttributions)
			.where(eq(fileAttributions.workspacePath, normalizePathForComparison(dir)));
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("narrator-scoped revert", () => {
	test("undoes only this narrator's files and leaves another actor's untouched", async () => {
		const repo = await createRepo("nf-scoped-basic-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "mine.txt"), "v1\n");
		writeFileSync(join(repo, "theirs.txt"), "original\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "mine.txt"), "v2\n");
		});
		// Someone else edits a different file afterwards.
		outsideChange(session, () => {
			writeFileSync(join(repo, "theirs.txt"), "changed-by-other\n");
		});

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result).not.toBeNull();
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		expect(readFileSync(join(repo, "mine.txt"), "utf8")).toBe("v1\n");
		// The other actor's work must survive a scoped rollback.
		expect(readFileSync(join(repo, "theirs.txt"), "utf8")).toBe("changed-by-other\n");
	});

	test("preserves another actor's edits to a different region of the same file", async () => {
		const repo = await createRepo("nf-scoped-hunk-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "shared.txt"), "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "shared.txt"), "NARRATOR\nB\nC\nD\nE\nF\nG\nH\nI\nJ\n");
		});
		outsideChange(session, () => {
			writeFileSync(join(repo, "shared.txt"), "NARRATOR\nB\nC\nD\nE\nF\nG\nH\nI\nOTHER\n");
		});

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		// The narrator's line reverts to A; the other actor's line stays OTHER.
		expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe(
			"A\nB\nC\nD\nE\nF\nG\nH\nI\nOTHER\n",
		);
	});

	test("deletes files this narrator created and keeps files another actor created", async () => {
		const repo = await createRepo("nf-scoped-create-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "base.txt"), "base\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "narrator-made.txt"), "mine\n");
		});
		outsideChange(session, () => {
			writeFileSync(join(repo, "other-made.txt"), "theirs\n");
		});

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		expect(existsSync(join(repo, "narrator-made.txt"))).toBe(false);
		expect(existsSync(join(repo, "other-made.txt"))).toBe(true);
	});

	test("reports a conflict and leaves the workspace untouched", async () => {
		const repo = await createRepo("nf-scoped-conflict-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "f.txt"), "a\nb\nc\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "f.txt"), "a\nNARRATOR\nc\n");
		});
		// Another actor rewrites the very line the narrator changed.
		outsideChange(session, () => {
			writeFileSync(join(repo, "f.txt"), "a\nOTHER_ACTOR\nc\n");
		});

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result).not.toBeNull();
		expect(result?.failures.map((f) => f.code)).toEqual(["REVERT_CONFLICT"]);
		// A refused rollback must not have written anything.
		expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("a\nOTHER_ACTOR\nc\n");
	});

	test("refuses a non-tail window whose later change overlaps the same region", async () => {
		const repo = await createRepo("nf-scoped-midwindow-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "f.txt"), "v0\n");

		// Two turns to the same region; only the first is targeted for deletion.
		const first = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "f.txt"), "v1\n");
		});
		await runToolTurn(session, narratorId, 2, () => {
			writeFileSync(join(repo, "f.txt"), "v1\nKEEP_THIS\n");
		});

		// Reversing turn 1 alone means merging against the state turn 2 produced. The
		// two touch the same lines, so this is a real conflict — and a conflict is the
		// only honest answer: silently yielding "v0\n" would destroy KEEP_THIS.
		const result = await revertNarratorScopedForMessages(narratorId, [first.messageId]);
		expect(result?.failures.map((f) => f.code)).toEqual(["REVERT_CONFLICT"]);
		expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("v1\nKEEP_THIS\n");

		const preview = await previewNarratorScopedFromSeq(narratorId, 2);
		expect(preview.available).toBe(true);
	});

	test("reverses a non-tail window when the later change is elsewhere", async () => {
		const repo = await createRepo("nf-scoped-nontail-ok-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "first.txt"), "v0\n");

		const first = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "first.txt"), "v1\n");
		});
		// A later turn this window does not include, touching a different file.
		await runToolTurn(session, narratorId, 2, () => {
			writeFileSync(join(repo, "second.txt"), "later\n");
		});

		// Reversing an earlier turn merges against later state, so the later work is
		// kept instead of being collapsed away with it.
		const result = await revertNarratorScopedForMessages(narratorId, [first.messageId]);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "first.txt"), "utf8")).toBe("v0\n");
		expect(readFileSync(join(repo, "second.txt"), "utf8")).toBe("later\n");
	});

	test("keeps another actor's edit made BETWEEN two of the narrator's turns", async () => {
		const repo = await createRepo("nf-scoped-inwindow-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "mine.txt"), "v0\n");
		writeFileSync(join(repo, "theirs.txt"), "original\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "mine.txt"), "v1\n");
		});
		// The critical case: a foreign write lands INSIDE the window, not after it.
		// Collapsing the window to (first before, last after) would put this change in
		// the reversed span and discard it.
		outsideChange(session, () => {
			writeFileSync(join(repo, "theirs.txt"), "changed-by-other\n");
		});
		await runToolTurn(session, narratorId, 2, () => {
			writeFileSync(join(repo, "mine.txt"), "v2\n");
		});

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		expect(readFileSync(join(repo, "mine.txt"), "utf8")).toBe("v0\n");
		expect(readFileSync(join(repo, "theirs.txt"), "utf8")).toBe("changed-by-other\n");
		// Only the narrator's own file was touched, so the reported set says so too.
		expect(result?.files.map((f) => f.split("/").pop())).toEqual(["mine.txt"]);
	});

	test("keeps a mid-window foreign edit to the same file, different region", async () => {
		const repo = await createRepo("nf-scoped-inwindow-hunk-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "shared.txt"), "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "shared.txt"), "NARRATOR1\nB\nC\nD\nE\nF\nG\nH\nI\nJ\n");
		});
		outsideChange(session, () => {
			writeFileSync(join(repo, "shared.txt"), "NARRATOR1\nB\nC\nD\nE\nF\nG\nH\nI\nOTHER\n");
		});
		await runToolTurn(session, narratorId, 2, () => {
			writeFileSync(join(repo, "shared.txt"), "NARRATOR2\nB\nC\nD\nE\nF\nG\nH\nI\nOTHER\n");
		});

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		// Both narrator turns are undone; the foreign line inside the window survives.
		expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe(
			"A\nB\nC\nD\nE\nF\nG\nH\nI\nOTHER\n",
		);
	});

	test("accepts a contiguous tail spanning several turns", async () => {
		const repo = await createRepo("nf-scoped-tail-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "f.txt"), "v0\n");

		const first = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "f.txt"), "v1\n");
		});
		const second = await runToolTurn(session, narratorId, 2, () => {
			writeFileSync(join(repo, "f.txt"), "v1\nv2\n");
		});

		const result = await revertNarratorScopedForMessages(narratorId, [
			first.messageId,
			second.messageId,
		]);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("v0\n");
	});

	test("returns null when no tool call recorded a boundary", async () => {
		const repo = await createRepo("nf-scoped-noboundary-");
		const narratorId = await createNarrator(repo);
		const messageId = generateId();
		const now = new Date().toISOString();
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: now,
		});
		await db
			.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId, messageId, seq: 1 });
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId,
			messageId,
			toolUseId: generateId(),
			toolName: "Edit",
			inputJson: {},
			status: "success",
			createdAt: now,
		});

		expect(await revertNarratorScopedFromSeq(narratorId, 1)).toBeNull();
		const preview = await previewNarratorScopedFromSeq(narratorId, 1);
		expect(preview.available).toBe(false);
		expect(preview.reason).toBe("no_boundaries");
	});

	test("ignores calls that did not change the workspace, such as spec:// writes", async () => {
		const repo = await createRepo("nf-scoped-spec-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "real.txt"), "v1\n");

		// A real change, then a call that touches nothing on disk (spec:// edit).
		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "real.txt"), "v2\n");
		});
		const specTurn = await runToolTurn(session, narratorId, 2, () => {}, "Edit");

		// The no-op call must not become a rollback anchor: a window starting at it
		// has nothing to reverse.
		const noop = await revertNarratorScopedFromSeq(narratorId, 2);
		expect(noop).toBeNull();

		const specCall = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, specTurn.toolUseId),
			columns: { treeHashBefore: true, treeHashAfter: true },
		});
		expect(specCall?.treeHashBefore).toBe(specCall?.treeHashAfter as string);

		// The earlier real change is still reversible.
		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "real.txt"), "utf8")).toBe("v1\n");
	});

	test("leaves a subagent file written after the window, and says nothing about it", async () => {
		const repo = await createRepo("nf-scoped-subagent-");
		const narratorId = await createNarrator(repo);
		const subagentId = await createNarrator(repo, narratorId);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "mine.txt"), "v1\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "mine.txt"), "v2\n");
		});
		outsideChange(session, () => {
			writeFileSync(join(repo, "by-subagent.txt"), "subagent-wrote-this\n");
		});
		await recordAttribution({
			deviceId: "local",
			workspacePath: repo,
			narratorId: subagentId,
			subagentType: "general",
			action: "write",
			toolName: "Write",
			filePath: "by-subagent.txt",
		});

		const preview = await previewNarratorScopedFromSeq(narratorId, 1);
		expect(preview.available).toBe(true);
		// The merge does not touch this file, so there is nothing to warn about — a
		// warning here would tell the user to go verify a file that never moved.
		expect(preview.subagentWarning).toBeUndefined();

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		expect(result?.warnings).toBeUndefined();
		if (result) finalizeSnapshotRevert(result);
		expect(existsSync(join(repo, "by-subagent.txt"))).toBe(true);
	});

	test("reports subagent changes that the rollback actually reverts", async () => {
		const repo = await createRepo("nf-scoped-subagent-inwindow-");
		const narratorId = await createNarrator(repo);
		const subagentId = await createNarrator(repo, narratorId);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "mine.txt"), "v0\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "mine.txt"), "v1\n");
		});
		// A subagent writes INSIDE the window. Subagent calls record no boundary, so the
		// merge decides its fate; whatever that is, the report must match reality.
		outsideChange(session, () => {
			writeFileSync(join(repo, "by-subagent.txt"), "subagent-wrote-this\n");
		});
		await recordAttribution({
			deviceId: "local",
			workspacePath: repo,
			narratorId: subagentId,
			subagentType: "general",
			action: "write",
			toolName: "Write",
			filePath: "by-subagent.txt",
		});
		await runToolTurn(session, narratorId, 2, () => {
			writeFileSync(join(repo, "mine.txt"), "v2\n");
		});

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		// Segmenting at the foreign write keeps the subagent's file, so no warning is
		// due — and the file is still there, which is what makes that honest.
		expect(existsSync(join(repo, "by-subagent.txt"))).toBe(true);
		expect(result?.warnings).toBeUndefined();
		expect(readFileSync(join(repo, "mine.txt"), "utf8")).toBe("v0\n");
	});

	test("a subagent overwrite of the narrator's own file is reported when reverted", async () => {
		const repo = await createRepo("nf-scoped-subagent-overlap-");
		const narratorId = await createNarrator(repo);
		const subagentId = await createNarrator(repo, narratorId);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "shared.txt"), "base\n");

		// The subagent's write is inside the narrator's own tool call, so it lands
		// between that call's before/after boundaries and cannot be segmented apart.
		const turn = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "shared.txt"), "narrator\n");
			writeFileSync(join(repo, "by-subagent.txt"), "subagent\n");
		});
		await recordAttribution({
			deviceId: "local",
			workspacePath: repo,
			narratorId: subagentId,
			subagentType: "general",
			action: "write",
			toolName: "Write",
			filePath: "by-subagent.txt",
			toolUseId: turn.toolUseId,
		});

		const preview = await previewNarratorScopedFromSeq(narratorId, 1);
		expect(preview.subagentWarning?.changeCount).toBe(1);
		expect(preview.subagentWarning?.sampleFiles).toEqual(["by-subagent.txt"]);

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		// The file IS removed, so the warning has to say it was reverted — the previous
		// behaviour claimed subagent work was "left in place" while deleting it.
		expect(existsSync(join(repo, "by-subagent.txt"))).toBe(false);
		expect(result?.warnings?.[0]?.code).toBe("SUBAGENT_CHANGES_REVERTED");
	});

	test("ignores a fork's changes when reporting the subagent gap", async () => {
		const repo = await createRepo("nf-scoped-fork-");
		const narratorId = await createNarrator(repo);
		// A fork also carries parentNarratorId, but it is a separate actor rather than a
		// subagent, so it must not be described as one.
		const forkId = await createNarrator(repo);
		await db
			.update(narrators)
			.set({ parentNarratorId: narratorId })
			.where(eq(narrators.id, forkId));
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "shared.txt"), "base\n");

		const turn = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "shared.txt"), "narrator\n");
			writeFileSync(join(repo, "by-fork.txt"), "fork\n");
		});
		await recordAttribution({
			deviceId: "local",
			workspacePath: repo,
			narratorId: forkId,
			action: "write",
			toolName: "Write",
			filePath: "by-fork.txt",
			toolUseId: turn.toolUseId,
		});

		const preview = await previewNarratorScopedFromSeq(narratorId, 1);
		expect(preview.subagentWarning).toBeUndefined();
	});

	test("discarding a scoped revert restores the pre-rollback state", async () => {
		const repo = await createRepo("nf-scoped-compensate-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "f.txt"), "v1\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "f.txt"), "v2\n");
		});

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("v1\n");

		// Simulates the history mutation failing after files were already rolled back.
		if (result) {
			const failures = await discardSnapshotRevert(result);
			expect(failures).toEqual([]);
		}
		expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("v2\n");
	});

	test("refuses to restore when the workspace moved after the plan was computed", async () => {
		const repo = await createRepo("nf-scoped-drift-");
		writeFileSync(join(repo, "f.txt"), "v1\n");
		const stale = await worktreeTreeSnapshot.capture(repo);

		// Simulates a writer landing between the capture the plan was built from and
		// the restore that applies it.
		writeFileSync(join(repo, "f.txt"), "v2\n");

		await expect(worktreeTreeSnapshot.restore(repo, stale, "local", stale)).rejects.toThrow(
			/workspace changed during rollback/,
		);
		// Nothing may be written once the guard trips.
		expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("v2\n");
	});

	test("handles non-ASCII paths instead of git's quoted escapes", async () => {
		const repo = await createRepo("nf-scoped-cjk-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const cjkEdited = "中文 文件.txt";
		const cjkCreated = "新建 文件.txt";
		writeFileSync(join(repo, cjkEdited), "v1\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, cjkEdited), "v2\n");
			writeFileSync(join(repo, cjkCreated), "new\n");
		});

		// Without `-z`, git returns these as quoted octal escapes. Resolving such a
		// string points at a path that does not exist, so the created file would survive
		// a rollback that claims to remove it.
		const preview = await previewNarratorScopedFromSeq(narratorId, 1);
		expect(preview.files.map((f) => f.relPath).sort()).toEqual([cjkEdited, cjkCreated].sort());

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		expect(readFileSync(join(repo, cjkEdited), "utf8")).toBe("v1\n");
		expect(existsSync(join(repo, cjkCreated))).toBe(false);
		expect(result?.files.some((f) => f.includes(cjkEdited))).toBe(true);
	});

	test("preview can attach file contents for the diff view", async () => {
		const repo = await createRepo("nf-scoped-contents-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "edited.txt"), "before\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "edited.txt"), "after\n");
		});

		// The delete-preview dialog diffs these two sides; without contents every file
		// would render as an empty change.
		const preview = await previewNarratorScopedFromSeq(narratorId, 1, { withContents: true });
		const file = preview.files.find((f) => f.relPath === "edited.txt");
		expect(file?.currentContent).toBe("after\n");
		expect(file?.revertedContent).toBe("before\n");
	});

	test("preview reports the same files the rollback changes", async () => {
		const repo = await createRepo("nf-scoped-preview-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "edited.txt"), "v1\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "edited.txt"), "v2\n");
			writeFileSync(join(repo, "created.txt"), "new\n");
		});
		outsideChange(session, () => {
			writeFileSync(join(repo, "unrelated.txt"), "other\n");
		});

		const preview = await previewNarratorScopedFromSeq(narratorId, 1);
		expect(preview.available).toBe(true);
		expect(preview.conflicts).toEqual([]);
		expect(preview.files.map((f) => f.relPath).sort()).toEqual(["created.txt", "edited.txt"]);
		expect(preview.files.find((f) => f.relPath === "created.txt")?.willBeDeleted).toBe(true);
		expect(preview.files.find((f) => f.relPath === "edited.txt")?.willBeDeleted).toBe(false);

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		if (result) finalizeSnapshotRevert(result);
		expect(result?.fileCount).toBe(preview.files.length);
	});

	test("covers Bash changes that no tool input describes", async () => {
		const repo = await createRepo("nf-scoped-bash-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "formatted.txt"), "unformatted\n");

		// A Bash turn: the tool input says nothing about which files it wrote, but the
		// tree boundaries capture it regardless.
		await runToolTurn(
			session,
			narratorId,
			1,
			() => {
				writeFileSync(join(repo, "formatted.txt"), "formatted-by-script\n");
			},
			"Bash",
		);

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "formatted.txt"), "utf8")).toBe("unformatted\n");
	});
});
