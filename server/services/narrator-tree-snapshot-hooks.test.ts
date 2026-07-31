import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	worktreeTreeSnapshots,
} from "../db/schema";
import { generateId } from "../lib/id";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import {
	recordTreeSnapshotAfter,
	recordTreeSnapshotBefore,
	type TreeSnapshotSession,
} from "./narrator-tree-snapshot-hooks";
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

async function createNarrator(cwd: string): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({ id, cwd, createdAt: now, updatedAt: now });
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

function makeSession(cwd: string): TreeSnapshotSession {
	return { cwd };
}

afterEach(async () => {
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

describe("narrator tree snapshot hooks", () => {
	test("records both boundaries on the tool call and mirrors the result on its message", async () => {
		const repo = await createRepo("nf-hook-record-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "a.txt"), "before\n");

		const { toolUseId, messageId } = await seedToolCall(narratorId, "Write", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId);
		// Stands in for the tool's own write.
		writeFileSync(join(repo, "a.txt"), "after\n");
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		expect(result.before).toMatch(/^[0-9a-f]{40}$/);
		expect(result.after).toMatch(/^[0-9a-f]{40}$/);
		expect(result.before).not.toBe(result.after);

		const toolCall = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
			columns: { treeHashBefore: true, treeHashAfter: true },
		});
		expect(toolCall?.treeHashBefore).toBe(result.before);
		expect(toolCall?.treeHashAfter).toBe(result.after);

		// The message boundary is what "roll back to just after this message" restores.
		const message = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { treeHashAfter: true },
		});
		expect(message?.treeHashAfter).toBe(result.after);
	});

	test("reports files changed by a shell command that no tool input describes", async () => {
		const repo = await createRepo("nf-hook-bash-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "tracked.txt"), "original\n");

		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId);
		// A real shell command writing files. The old status-diff path had to guess
		// this from `git status`; the tree diff observes it directly.
		await safeSpawn({
			cmd: ["sh", "-c", "printf 'via shell\\n' > tracked.txt && printf 'new\\n' > created.txt"],
			cwd: repo,
			timeout: 15_000,
		});
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		expect(result.changedFiles.sort()).toEqual(["created.txt", "tracked.txt"]);
	});

	test("sees a file the shell command modified even if it was already dirty", async () => {
		const repo = await createRepo("nf-hook-already-dirty-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "dirty.txt"), "uncommitted edit\n");

		// The file is already modified before the tool runs. A `git status` set
		// difference cannot detect a further change to it, because it appears in both
		// the before and after sets; the tree hash changes regardless.
		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId);
		writeFileSync(join(repo, "dirty.txt"), "changed again\n");
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		expect(result.changedFiles).toEqual(["dirty.txt"]);
	});

	test("a tool that changes nothing yields identical boundaries and no changed files", async () => {
		const repo = await createRepo("nf-hook-noop-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "a.txt"), "unchanged\n");

		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId);
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		expect(result.before).toBe(result.after);
		expect(result.changedFiles).toEqual([]);
	});

	test("consecutive tools chain so each one's before matches the previous after", async () => {
		const repo = await createRepo("nf-hook-chain-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "a.txt"), "v1\n");

		const first = await seedToolCall(narratorId, "Write", 1);
		await recordTreeSnapshotBefore(session, narratorId, first.toolUseId);
		writeFileSync(join(repo, "a.txt"), "v2\n");
		const firstResult = await recordTreeSnapshotAfter(session, narratorId, first.toolUseId);

		const second = await seedToolCall(narratorId, "Write", 2);
		await recordTreeSnapshotBefore(session, narratorId, second.toolUseId);
		writeFileSync(join(repo, "a.txt"), "v3\n");
		const secondResult = await recordTreeSnapshotAfter(session, narratorId, second.toolUseId);

		// A contiguous chain is what lets a rollback target any boundary.
		expect(secondResult.before).toBe(firstResult.after);
		expect(secondResult.after).not.toBe(secondResult.before);
	});

	test("restoring a recorded boundary undoes the tool's writes", async () => {
		const repo = await createRepo("nf-hook-restore-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "a.txt"), "original\n");

		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId);
		await safeSpawn({
			cmd: ["sh", "-c", "printf 'wrecked\\n' > a.txt && printf 'junk\\n' > b.txt"],
			cwd: repo,
			timeout: 15_000,
		});
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		const beforeHash = result.before;
		if (!beforeHash) throw new Error("expected a recorded before-boundary");
		await worktreeTreeSnapshot.restore(repo, beforeHash);
		expect(await worktreeTreeSnapshot.capture(repo)).toBe(beforeHash);
	});

	test("a remote execution target records no snapshot", async () => {
		const repo = await createRepo("nf-hook-remote-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo, _defaultDeviceId: "remote-a" };
		writeFileSync(join(repo, "a.txt"), "one\n");

		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId);
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		expect(result.before).toBeNull();
		expect(result.after).toBeNull();
		const toolCall = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
			columns: { treeHashBefore: true, treeHashAfter: true },
		});
		expect(toolCall?.treeHashBefore).toBeNull();
		expect(toolCall?.treeHashAfter).toBeNull();
	});

	test("a non-git workspace degrades to no snapshot instead of failing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nf-hook-nongit-"));
		tempDirs.push(dir);
		const narratorId = await createNarrator(dir);
		const session = makeSession(dir);
		writeFileSync(join(dir, "a.txt"), "one\n");

		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
		// A plain directory still gets its own shadow repo, so snapshots work here;
		// what matters is that the call never throws into the tool path.
		await recordTreeSnapshotBefore(session, narratorId, toolUseId);
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);
		expect(result.changedFiles).toEqual([]);
	});
});
