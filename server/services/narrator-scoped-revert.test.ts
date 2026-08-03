import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
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
	dedupeBoundaryRows,
	previewNarratorScopedForToolUses,
	previewNarratorScopedFromSeq,
	revertNarratorScopedForMessages,
	revertNarratorScopedForToolUses,
	revertNarratorScopedFromSeq,
} from "./narrator-scoped-revert";
import { narratorService } from "./narrator-service";
import { type ActiveNarrator, activeNarrators } from "./narrator-session-state";
import {
	captureSessionTree,
	recordTreeSnapshotAfter,
	recordTreeSnapshotBefore,
	type TreeSnapshotSession,
} from "./narrator-tree-snapshot-hooks";
import { discardSnapshotRevert, finalizeSnapshotRevert } from "./snapshot-revert";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const createdNarrators: string[] = [];
const tempDirs: string[] = [];
const registeredSessions: string[] = [];

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
 * Register a live session in `activeNarrators`, the way a running narrator would.
 *
 * The tree-cache invalidation only reaches sessions in that map, so a bare object
 * would pass these tests without proving anything. Returns the registered session
 * so a test can inspect `_lastTreeHash` directly.
 */
function registerLiveSession(narratorId: string, cwd: string): TreeSnapshotSession {
	const session = {
		narratorId,
		cwd,
		alive: true,
		_isInGitRepo: true,
	} as unknown as ActiveNarrator;
	activeNarrators.set(narratorId, session);
	registeredSessions.push(narratorId);
	return session as TreeSnapshotSession;
}

/**
 * Run several tool calls inside ONE assistant message, each with its own boundary.
 *
 * This is the shape a message-level scope cannot express: selecting by messageId
 * pulls in every call the message contains, so targeting one of them requires the
 * tool-use scope. Returns the calls in execution order.
 */
async function runMultiToolMessage(
	session: TreeSnapshotSession,
	narratorId: string,
	seq: number,
	mutations: Array<() => void>,
	toolName = "Write",
): Promise<{ messageId: string; toolUseIds: string[] }> {
	const messageId = generateId();
	const now = new Date(Date.now() + seq).toISOString();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({ id: generateId(), narratorId, messageId, seq });

	const toolUseIds: string[] = [];
	for (const [index, mutate] of mutations.entries()) {
		const toolUseId = generateId();
		toolUseIds.push(toolUseId);
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId,
			messageId,
			toolUseId,
			toolName,
			inputJson: {},
			status: "success",
			// Ordered within the message so segment planning sees them in order.
			createdAt: new Date(Date.now() + seq * 1000 + index).toISOString(),
		});
		await recordTreeSnapshotBefore(session, narratorId, toolUseId);
		mutate();
		await recordTreeSnapshotAfter(session, narratorId, toolUseId);
	}
	return { messageId, toolUseIds };
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
	// `activeNarrators` is process-wide state; a leaked entry would make later tests
	// (and any real session in the same process) see a session that does not exist.
	for (const narratorId of registeredSessions.splice(0)) {
		activeNarrators.delete(narratorId);
	}
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

describe("tool-use scoped revert", () => {
	test("undoes one write from a message containing two, keeping the other", async () => {
		const repo = await createRepo("nf-tooluse-one-of-two-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };

		// One message, two writes to different files — the case a message-level scope
		// cannot express, because selecting the message selects both.
		const { messageId, toolUseIds } = await runMultiToolMessage(session, narratorId, 1, [
			() => writeFileSync(join(repo, "undo-me.txt"), "undo\n"),
			() => writeFileSync(join(repo, "keep-me.txt"), "keep\n"),
		]);

		const result = await revertNarratorScopedForToolUses(narratorId, [
			{ messageId, toolUseId: toolUseIds[0] },
		]);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		expect(existsSync(join(repo, "undo-me.txt"))).toBe(false);
		expect(readFileSync(join(repo, "keep-me.txt"), "utf8")).toBe("keep\n");
	});

	test("undoes the FIRST of two writes to the same file, keeping the later one", async () => {
		const repo = await createRepo("nf-tooluse-same-file-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "shared.txt"), "base\n");

		// Both calls append to the same file in one message. Reversing the first means
		// merging against the state the second produced.
		const { messageId, toolUseIds } = await runMultiToolMessage(session, narratorId, 1, [
			() => writeFileSync(join(repo, "shared.txt"), "base\nfrom-first\n"),
			() => writeFileSync(join(repo, "shared.txt"), "base\nfrom-first\nfrom-second\n"),
		]);

		const result = await revertNarratorScopedForToolUses(narratorId, [
			{ messageId, toolUseId: toolUseIds[0] },
		]);
		if (result) finalizeSnapshotRevert(result);

		// Either the first call's line is gone and the second's survives, or git
		// reports a conflict. What must never happen is losing the second call's work
		// silently.
		const content = readFileSync(join(repo, "shared.txt"), "utf8");
		if (result?.failures.length) {
			expect(result.failures.map((f) => f.code)).toEqual(["REVERT_CONFLICT"]);
			expect(content).toContain("from-second");
		} else {
			expect(content).toContain("from-second");
			expect(content).not.toContain("from-first");
		}
	});

	test("undoes a mid-history Bash call that no tool input describes", async () => {
		const repo = await createRepo("nf-tooluse-bash-mid-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "script-target.txt"), "original\n");

		// A Bash turn in the middle: replay could never undo this, since the tool input
		// says nothing about which file it wrote.
		const bash = await runToolTurn(
			session,
			narratorId,
			1,
			() => {
				writeFileSync(join(repo, "script-target.txt"), "rewritten-by-script\n");
			},
			"Bash",
		);
		// Later, unrelated work that has to survive.
		await runToolTurn(session, narratorId, 2, () => {
			writeFileSync(join(repo, "after.txt"), "later\n");
		});

		const result = await revertNarratorScopedForToolUses(narratorId, [
			{ messageId: bash.messageId, toolUseId: bash.toolUseId },
		]);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		expect(readFileSync(join(repo, "script-target.txt"), "utf8")).toBe("original\n");
		expect(readFileSync(join(repo, "after.txt"), "utf8")).toBe("later\n");
	});

	test("a duplicated boundary row is selected once", () => {
		// Dedupe is asserted on the selected pairs, not on the resulting files, because
		// reversal is idempotent: reversing one boundary twice is
		// `merge(base=after, ours=before, theirs=before)` = `before`. A disk-level
		// assertion would therefore pass with dedupe removed and prove nothing.
		const row = { toolUseId: "tool-1", messageId: "msg-1", seq: 1, before: "a", after: "b" };
		expect(dedupeBoundaryRows([row, { ...row }])).toEqual([row]);

		// The same call cloned under another message is still one change.
		expect(dedupeBoundaryRows([row, { ...row, messageId: "msg-2" }])).toEqual([row]);
	});

	test("distinct boundaries survive dedupe even when they share a tool id", () => {
		// A retried call keeps its id but records a different boundary, so both have to
		// be reversed; collapsing them would leave one change applied.
		const first = { toolUseId: "tool-1", messageId: "msg-1", seq: 1, before: "a", after: "b" };
		const second = { ...first, before: "b", after: "c" };
		expect(dedupeBoundaryRows([first, second])).toEqual([first, second]);
	});

	test("a duplicated tool-call row still reverts to the pre-call state", async () => {
		const repo = await createRepo("nf-tooluse-dupe-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "counter.txt"), "1\n");

		const turn = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "counter.txt"), "2\n");
		});

		// The shape real data contains: the same toolUseId under a second message,
		// carrying the same boundary. This asserts the end state is still correct — the
		// dedupe itself is covered by the pure tests above.
		const original = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, turn.toolUseId),
		});
		const cloneMessageId = generateId();
		await db.insert(narratorMessages).values({
			id: cloneMessageId,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: new Date(Date.now() + 5).toISOString(),
		});
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId,
			messageId: cloneMessageId,
			seq: 2,
		});
		if (!original) throw new Error("expected the recorded tool call");
		await db
			.insert(narratorToolCalls)
			.values({ ...original, id: generateId(), messageId: cloneMessageId });

		const result = await revertNarratorScopedForToolUses(narratorId, [
			{ messageId: turn.messageId, toolUseId: turn.toolUseId },
			{ messageId: cloneMessageId, toolUseId: turn.toolUseId },
		]);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "counter.txt"), "utf8")).toBe("1\n");
	});

	test("preview reports the same files a tool-use rollback changes", async () => {
		const repo = await createRepo("nf-tooluse-preview-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "edited.txt"), "v0\n");

		const { messageId, toolUseIds } = await runMultiToolMessage(session, narratorId, 1, [
			() => {
				writeFileSync(join(repo, "edited.txt"), "v1\n");
				writeFileSync(join(repo, "created.txt"), "new\n");
			},
			() => writeFileSync(join(repo, "untouched.txt"), "other\n"),
		]);

		const target = [{ messageId, toolUseId: toolUseIds[0] }];
		const preview = await previewNarratorScopedForToolUses(narratorId, target);
		expect(preview.available).toBe(true);
		expect(preview.conflicts).toEqual([]);
		expect(preview.files.map((f) => f.relPath).sort()).toEqual(["created.txt", "edited.txt"]);

		const result = await revertNarratorScopedForToolUses(narratorId, target);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		// The dialog cannot promise a different scope than the rollback applies.
		expect(result?.fileCount).toBe(preview.files.length);
		expect(readFileSync(join(repo, "untouched.txt"), "utf8")).toBe("other\n");
	});

	test("returns null when the targeted call recorded no boundary", async () => {
		const repo = await createRepo("nf-tooluse-noboundary-");
		const narratorId = await createNarrator(repo);
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
		await db
			.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId, messageId, seq: 1 });
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId,
			messageId,
			toolUseId,
			toolName: "Write",
			inputJson: {},
			status: "success",
			createdAt: now,
		});

		// Null, not a failure: the caller falls back to per-file replay for history
		// recorded before tree snapshots existed.
		expect(
			await revertNarratorScopedForToolUses(narratorId, [{ messageId, toolUseId }]),
		).toBeNull();
	});
});

describe("session tree cache invalidation", () => {
	/**
	 * A rollback rewrites the worktree without going through a tool, so a live
	 * session's cached hash would otherwise be reused as the next tool's `before`.
	 *
	 * That is not just a stale-attribution problem: segment planning proves "nothing
	 * else wrote in between" by testing `previous.after === next.before`, so a
	 * `before` describing a state that no longer exists can merge two segments that
	 * must stay split — and a merged span reverses whatever landed inside it.
	 */
	test("a rollback drops the cached hash so the next tool records a truthful before", async () => {
		const repo = await createRepo("nf-cache-invalidate-");
		const narratorId = await createNarrator(repo);
		const session = registerLiveSession(narratorId, repo);
		writeFileSync(join(repo, "tracked.txt"), "v1\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "tracked.txt"), "v2\n");
		});
		// The turn cached the post-write state, which is what makes the bug reachable.
		const cachedAfterTurn = session._lastTreeHash;
		expect(cachedAfterTurn).toBeTruthy();

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("v1\n");

		// The cache must be gone rather than still describing the pre-rollback disk.
		expect(session._lastTreeHash).toBeUndefined();

		// And the next turn's recorded `before` must match the real (rolled back)
		// workspace, not the state the stale cache described.
		const truthfulBefore = await worktreeTreeSnapshot.capture(repo, "local");
		const second = await runToolTurn(session, narratorId, 2, () => {
			writeFileSync(join(repo, "tracked.txt"), "v3\n");
		});
		const row = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, second.toolUseId),
			columns: { treeHashBefore: true },
		});
		expect(row?.treeHashBefore).toBe(truthfulBefore);
		expect(row?.treeHashBefore).not.toBe(cachedAfterTurn);
	});

	test("a rollback also clears sessions of other narrators sharing the worktree", async () => {
		const repo = await createRepo("nf-cache-shared-");
		const narratorId = await createNarrator(repo);
		const neighbourId = await createNarrator(repo);
		const session = registerLiveSession(narratorId, repo);
		const neighbour = registerLiveSession(neighbourId, repo);
		writeFileSync(join(repo, "shared.txt"), "v1\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "shared.txt"), "v2\n");
		});
		// The neighbour observed the same worktree, so it holds a cache of its own.
		await captureSessionTree(neighbour, neighbourId);
		expect(neighbour._lastTreeHash).toBeTruthy();

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		expect(session._lastTreeHash).toBeUndefined();
		expect(neighbour._lastTreeHash).toBeUndefined();
	});

	test("a session on an unrelated worktree keeps its cache", async () => {
		const repo = await createRepo("nf-cache-mine-");
		const otherRepo = await createRepo("nf-cache-other-");
		const narratorId = await createNarrator(repo);
		const otherId = await createNarrator(otherRepo);
		const session = registerLiveSession(narratorId, repo);
		const other = registerLiveSession(otherId, otherRepo);
		writeFileSync(join(repo, "mine.txt"), "v1\n");
		writeFileSync(join(otherRepo, "theirs.txt"), "v1\n");

		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "mine.txt"), "v2\n");
		});
		await captureSessionTree(other, otherId);
		const otherCached = other._lastTreeHash;
		expect(otherCached).toBeTruthy();

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		// Invalidation is scoped to the worktree that actually changed.
		expect(other._lastTreeHash).toBe(otherCached);
	});
});

describe("batch block deletion", () => {
	/** Give a message tool_use blocks so `deleteMessageBlocks` can address them. */
	async function setBlocks(messageId: string, toolUseIds: string[]): Promise<void> {
		await db
			.update(narratorMessages)
			.set({
				contentJson: toolUseIds.map((id) => ({ type: "tool_use", id, name: "Write", input: {} })),
			})
			.where(eq(narratorMessages.id, messageId));
	}

	test("reverts every targeted block in one pass and deletes their history", async () => {
		const repo = await createRepo("nf-batch-ok-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "base\n");

		const { messageId, toolUseIds } = await runMultiToolMessage(session, narratorId, 1, [
			() => writeFileSync(join(repo, "a.txt"), "changed\n"),
			() => writeFileSync(join(repo, "b.txt"), "created\n"),
		]);
		await setBlocks(messageId, toolUseIds);

		const result = await narratorService.deleteMessageBlocks(narratorId, [
			{ messageId, blockIndex: 0 },
			{ messageId, blockIndex: 1 },
		]);
		expect(result.failed).toBe(0);
		expect(result.deleted).toBe(2);

		// Both calls' writes are undone by the single batch rollback.
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("base\n");
		expect(existsSync(join(repo, "b.txt"))).toBe(false);
	});

	test("collapses adjacent calls into one segment instead of one rollback each", async () => {
		const repo = await createRepo("nf-batch-segments-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "log.txt"), "start\n");

		// Two chained calls: the first's `after` equals the second's `before`, so a
		// batched rollback must treat them as a single span.
		const { messageId, toolUseIds } = await runMultiToolMessage(session, narratorId, 1, [
			() => writeFileSync(join(repo, "log.txt"), "start\nstep1\n"),
			() => writeFileSync(join(repo, "log.txt"), "start\nstep1\nstep2\n"),
		]);
		await setBlocks(messageId, toolUseIds);

		const result = await narratorService.deleteMessageBlocks(narratorId, [
			{ messageId, blockIndex: 0 },
			{ messageId, blockIndex: 1 },
		]);
		expect(result.failed).toBe(0);
		// Reverting them as one span returns the file to its pre-message state. Reverting
		// block-by-block would have merged the second pass against the first's output.
		expect(readFileSync(join(repo, "log.txt"), "utf8")).toBe("start\n");
	});

	test("a conflict refuses the whole batch and leaves history intact", async () => {
		const repo = await createRepo("nf-batch-conflict-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "shared.txt"), "v0\n");

		const first = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "shared.txt"), "v1\n");
		});
		await setBlocks(first.messageId, [first.toolUseId]);
		// Another actor rewrites the same region after the targeted call.
		outsideChange(session, () => {
			writeFileSync(join(repo, "shared.txt"), "v1-and-theirs\n");
		});

		await expect(
			narratorService.deleteMessageBlocks(narratorId, [
				{ messageId: first.messageId, blockIndex: 0 },
			]),
		).rejects.toThrow();

		// Neither the file nor the history moved: the batch is all-or-nothing.
		expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe("v1-and-theirs\n");
		const stillThere = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, first.toolUseId),
		});
		expect(stillThere).toBeTruthy();
	});

	test("skipRevert deletes history and leaves the files alone", async () => {
		const repo = await createRepo("nf-batch-skip-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "kept.txt"), "base\n");

		const turn = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "kept.txt"), "changed\n");
		});
		await setBlocks(turn.messageId, [turn.toolUseId]);

		const result = await narratorService.deleteMessageBlocks(
			narratorId,
			[{ messageId: turn.messageId, blockIndex: 0 }],
			{ skipRevert: true },
		);
		expect(result.failed).toBe(0);
		expect(readFileSync(join(repo, "kept.txt"), "utf8")).toBe("changed\n");
	});

	test("an out-of-range index refuses the batch before anything is deleted", async () => {
		// Each block deletion commits its own transaction, so a bad index discovered midway
		// would leave the earlier blocks already gone while the rollback covering all of them
		// gets undone — history deleted, files restored, nothing left to describe them.
		// The batch therefore has to be rejected before the first write.
		const repo = await createRepo("nf-batch-precheck-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "base\n");

		const { messageId, toolUseIds } = await runMultiToolMessage(session, narratorId, 1, [
			() => writeFileSync(join(repo, "a.txt"), "changed\n"),
			() => writeFileSync(join(repo, "b.txt"), "created\n"),
		]);
		await setBlocks(messageId, toolUseIds);

		await expect(
			narratorService.deleteMessageBlocks(narratorId, [
				{ messageId, blockIndex: 0 },
				// Only two blocks exist; this one cannot be addressed.
				{ messageId, blockIndex: 7 },
			]),
		).rejects.toThrow(/out of range/);

		// Nothing was deleted and nothing was rolled back.
		const remainingCalls = await db.query.narratorToolCalls.findMany({
			where: eq(narratorToolCalls.messageId, messageId),
			columns: { toolUseId: true },
		});
		expect(remainingCalls).toHaveLength(2);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
		expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("created\n");
	});

	test("a message this narrator does not reference refuses the batch", async () => {
		// Same reasoning as the index check: `deleteMessageBlock` raises on a missing ref, and
		// that must surface before the batch starts writing.
		const repo = await createRepo("nf-batch-precheck-ref-");
		const narratorId = await createNarrator(repo);
		const otherId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "base\n");

		const mine = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "a.txt"), "changed\n");
		});
		await setBlocks(mine.messageId, [mine.toolUseId]);
		// Belongs to a different narrator, so this narrator has no ref to it.
		const theirs = await runToolTurn(session, otherId, 1, () => {
			writeFileSync(join(repo, "theirs.txt"), "theirs\n");
		});
		await setBlocks(theirs.messageId, [theirs.toolUseId]);

		await expect(
			narratorService.deleteMessageBlocks(narratorId, [
				{ messageId: mine.messageId, blockIndex: 0 },
				{ messageId: theirs.messageId, blockIndex: 0 },
			]),
		).rejects.toThrow();

		// The narrator's own block survived, because the batch never started.
		const stillThere = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, mine.toolUseId),
		});
		expect(stillThere).toBeTruthy();
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
	});

	test("deleting a shared message's last block keeps the other narrator's boundary", async () => {
		// A forked narrator shares the message rows of its prefix. Removing the block from one
		// side must not delete the tool call row: it carries the `treeHashBefore/After` the
		// other narrator reverts against, so dropping it would silently make that history
		// unrevertable.
		const repo = await createRepo("nf-batch-shared-");
		const narratorId = await createNarrator(repo);
		const forkId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "base\n");

		const turn = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "a.txt"), "changed\n");
		});
		await setBlocks(turn.messageId, [turn.toolUseId]);
		// The fork references the very same message, as a lazy fork's shared prefix does.
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId: forkId,
			messageId: turn.messageId,
			seq: 1,
		});

		const result = await narratorService.deleteMessageBlocks(narratorId, [
			{ messageId: turn.messageId, blockIndex: 0 },
		]);
		expect(result.failed).toBe(0);
		expect(result.deleted).toBe(1);

		// The row survives with its boundary intact for the fork.
		const shared = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, turn.toolUseId),
			columns: { treeHashBefore: true, treeHashAfter: true },
		});
		expect(shared).toBeTruthy();
		expect(shared?.treeHashBefore).toBeTruthy();
		expect(shared?.treeHashAfter).not.toBe(shared?.treeHashBefore);

		// The deleting narrator no longer sees the message; the fork still does.
		const mineRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, turn.messageId),
			),
		});
		expect(mineRef).toBeUndefined();
		const forkRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, forkId),
				eq(narratorMessageRefs.messageId, turn.messageId),
			),
		});
		expect(forkRef).toBeTruthy();
	});

	test("a Bash call keeps a checkpoint under skipRevert", async () => {
		const repo = await createRepo("nf-batch-bash-ckpt-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "built.txt"), "before\n");

		// Bash records no reversible tool input, so its tree boundary is the only
		// description of the change; the checkpoint has to retain it.
		const turn = await runToolTurn(
			session,
			narratorId,
			1,
			() => {
				writeFileSync(join(repo, "built.txt"), "after\n");
			},
			"Bash",
		);
		await setBlocks(turn.messageId, [turn.toolUseId]);

		await narratorService.deleteMessageBlocks(
			narratorId,
			[{ messageId: turn.messageId, blockIndex: 0 }],
			{ skipRevert: true },
		);

		const checkpoints = await db.query.narratorToolCalls.findMany({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.isFileHistoryCheckpoint, true),
			),
			columns: { toolName: true, treeHashBefore: true, treeHashAfter: true },
		});
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0].toolName).toBe("Bash");
		// The boundary survived, so a later rollback can still undo this change.
		expect(checkpoints[0].treeHashBefore).toBeTruthy();
		expect(checkpoints[0].treeHashAfter).not.toBe(checkpoints[0].treeHashBefore);
	});
});

describe("workspace write admission", () => {
	test("a running loop on the same worktree blocks a rollback", async () => {
		const repo = await createRepo("nf-admission-busy-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "f.txt"), "v1\n");
		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "f.txt"), "v2\n");
		});

		// A *different* narrator's loop is running in the same worktree — the case the
		// per-narrator status check cannot see (a background subagent looks like this).
		const busyId = await createNarrator(repo);
		const busy = registerLiveSession(busyId, repo);
		(busy as unknown as { _loopRunning?: boolean })._loopRunning = true;

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures.map((f) => f.code)).toEqual(["PREPARE_FAILED"]);
		// Refused before writing: the file still holds the running loop's state.
		expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("v2\n");
	});

	test("a running loop on an unrelated worktree does not block a rollback", async () => {
		const repo = await createRepo("nf-admission-other-");
		const elsewhere = await createRepo("nf-admission-elsewhere-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "f.txt"), "v1\n");
		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "f.txt"), "v2\n");
		});

		const busyId = await createNarrator(elsewhere);
		const busy = registerLiveSession(busyId, elsewhere);
		(busy as unknown as { _loopRunning?: boolean })._loopRunning = true;

		const result = await revertNarratorScopedFromSeq(narratorId, 1);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("v1\n");
	});

	test("an empty tool-use selection reverts nothing", async () => {
		const repo = await createRepo("nf-admission-empty-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "f.txt"), "v1\n");
		await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "f.txt"), "v2\n");
		});

		// The predicate for an empty list must be "match nothing". If it degraded to no
		// predicate at all, this would select every boundary and roll the file back.
		expect(await revertNarratorScopedForToolUses(narratorId, [])).toBeNull();
		expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("v2\n");
	});
});
