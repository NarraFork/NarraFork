import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { normalizePathForComparison } from "../lib/platform-path";
import { settings } from "../lib/settings";
import { safeSpawn } from "../lib/spawn";
import {
	abandonSessionTreeSnapshots,
	abandonTreeSnapshot,
	declaredWorktreePaths,
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

/** Worktree-relative declaration for a Write/Edit turn, as the session computes it. */
function declare(cwd: string, relPath: string): string[] {
	return declaredWorktreePaths(cwd, { file_path: join(cwd, relPath) });
}

describe("declared paths", () => {
	const cwd = process.platform === "win32" ? "E:\\repo" : "/repo";

	test("a single-target tool declares just its file", () => {
		expect(declaredWorktreePaths(cwd, { file_path: join(cwd, "a", "b.ts") })).toEqual(["a/b.ts"]);
	});

	test("a move/copy declares BOTH its source and its destination", () => {
		// StructSed writes two files in one turn. An undeclared destination means its tree
		// delta is attributed to nobody, so a rollback would miss it.
		expect(
			declaredWorktreePaths(cwd, {
				file_path: join(cwd, "src", "big.ts"),
				to: join(cwd, "src", "types.ts"),
			}),
		).toEqual(["src/big.ts", "src/types.ts"]);
	});

	test("a destination equal to the source is not declared twice", () => {
		expect(
			declaredWorktreePaths(cwd, { file_path: join(cwd, "a.ts"), to: join(cwd, "a.ts") }),
		).toEqual(["a.ts"]);
	});

	test("a destination outside the worktree is dropped, keeping the source", () => {
		const outside = process.platform === "win32" ? "E:\\elsewhere\\x.ts" : "/elsewhere/x.ts";
		expect(declaredWorktreePaths(cwd, { file_path: join(cwd, "a.ts"), to: outside })).toEqual([
			"a.ts",
		]);
	});

	test("a spec:// target declares nothing, because nothing reaches the worktree", () => {
		expect(declaredWorktreePaths(cwd, { file_path: "spec://tasks.json" })).toEqual([]);
	});

	test("a malformed input yields no declaration rather than throwing", () => {
		expect(declaredWorktreePaths(cwd, null)).toEqual([]);
		expect(declaredWorktreePaths(cwd, { file_path: 42 })).toEqual([]);
	});
});

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

	test("fresh before preserves a human edit in the same file between cached tool boundaries", async () => {
		const repo = await createRepo("nf-hook-human-between-tools-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		const path = join(repo, "shared.txt");
		const content = (ai: number, human: number) =>
			`ai=${ai}\ncontext 1\ncontext 2\ncontext 3\ncontext 4\ncontext 5\nhuman=${human}\n`;
		writeFileSync(path, content(0, 0));

		const first = await seedToolCall(narratorId, "Edit", 1);
		await recordTreeSnapshotBefore(session, narratorId, first.toolUseId, ["shared.txt"]);
		writeFileSync(path, content(1, 0));
		const firstResult = await recordTreeSnapshotAfter(session, narratorId, first.toolUseId);
		if (!firstResult.after) throw new Error("missing first after boundary");
		expect(session._lastTreeHash).toBe(firstResult.after);

		// An external editor does not invalidate the session's cached observation.
		writeFileSync(path, content(1, 1));
		const second = await seedToolCall(narratorId, "Edit", 2);
		await recordTreeSnapshotBefore(session, narratorId, second.toolUseId, ["shared.txt"]);
		writeFileSync(path, content(2, 1));
		const secondResult = await recordTreeSnapshotAfter(session, narratorId, second.toolUseId);
		expect(secondResult.before).not.toBe(firstResult.after);
		if (!secondResult.before || !secondResult.after) throw new Error("missing boundaries");

		const reversed = await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before: secondResult.before, after: secondResult.after, ownedPaths: ["shared.txt"] },
		]);
		expect(reversed.conflicts).toEqual([]);
		expect(reversed.changedFiles).toEqual(["shared.txt"]);
		expect(readFileSync(path, "utf8")).toBe(content(1, 1));
	});

	test("failed path measurement stays unknown rather than recording an owned no-op", async () => {
		const repo = await createRepo("nf-hook-diff-unavailable-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "a.txt"), "before\n");
		const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, ["a.txt"]);
		writeFileSync(join(repo, "a.txt"), "after\n");
		const diff = spyOn(worktreeTreeSnapshot, "diffPathStatuses").mockRejectedValue(
			new Error("snapshot path listing exceeded the size limit"),
		);
		try {
			await recordTreeSnapshotAfter(session, narratorId, toolUseId);
		} finally {
			diff.mockRestore();
		}
		const row = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
			columns: { treeHashBefore: true, treeHashAfter: true, ownedPathsJson: true },
		});
		expect(row?.treeHashBefore).not.toBe(row?.treeHashAfter);
		expect(row?.ownedPathsJson).toBeNull();
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

	test("the treeSnapshotsEnabled setting turns every capture into a null boundary", async () => {
		const repo = await createRepo("nf-hook-setting-off-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "a.txt"), "one\n");

		// The escape hatch for worktrees whose whole-tree scan is not viable: with
		// the setting off, the tool path records no boundaries and never spawns git.
		const previous = settings.chapters.treeSnapshotsEnabled;
		settings.chapters.treeSnapshotsEnabled = false;
		try {
			const { toolUseId } = await seedToolCall(narratorId, "Write", 1);
			await recordTreeSnapshotBefore(session, narratorId, toolUseId);
			writeFileSync(join(repo, "a.txt"), "two\n");
			const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

			expect(result.before).toBeNull();
			expect(result.after).toBeNull();
			expect(result.changedFiles).toEqual([]);
			expect(session._lastTreeHash).toBeUndefined();
		} finally {
			settings.chapters.treeSnapshotsEnabled = previous;
		}

		// Re-enabled, the same session captures again (the cache was never poisoned
		// by the disabled window).
		const second = await seedToolCall(narratorId, "Write", 2);
		await recordTreeSnapshotBefore(session, narratorId, second.toolUseId);
		const result = await recordTreeSnapshotAfter(session, narratorId, second.toolUseId);
		expect(result.before).toMatch(/^[0-9a-f]{40}$/);
		expect(result.after).toMatch(/^[0-9a-f]{40}$/);
	});
});

/**
 * What happens to a write claim when the second half of the lifecycle never runs.
 *
 * A claim is opened before the tool executes and closed after it reports a result.
 * There are real paths where the second never happens: the tool throws, the turn is
 * aborted between `tool_call` and `tool_result`, a re-run's execution metadata does
 * not name a local device. An unclosed claim reads as "still running, so it extends
 * to now", which makes it overlap *every* later window — and because the shell path
 * only ever subtracts, one leaked declaration silently turns another narrator's real
 * writes into unrevertable ones. These are the only cases that catch that.
 */
describe("unfinished tool lifecycles", () => {
	test("abandoning a call stops its declaration shadowing later windows", async () => {
		const repo = await createRepo("nf-hook-abandon-");
		const narratorId = await createNarrator(repo);
		const neighbourId = await createNarrator(repo);
		const session = makeSession(repo);
		const neighbour = makeSession(repo);
		writeFileSync(join(repo, "target.txt"), "v1\n");

		// The neighbour's Edit declares its target and then throws, so its after-hook
		// never runs. This is the leak.
		await recordTreeSnapshotBefore(neighbour, neighbourId, "threw-mid-write", ["target.txt"]);
		abandonTreeSnapshot(neighbour, neighbourId, "threw-mid-write");

		// A shell command starting afterwards genuinely writes that file, and must keep
		// it: without the seal the abandoned claim still overlaps and subtracts it.
		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, null);
		writeFileSync(join(repo, "target.txt"), "written-by-shell\n");
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		expect(result.changedFiles).toEqual(["target.txt"]);
		const row = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
			columns: { ownedPathsJson: true },
		});
		expect(row?.ownedPathsJson).toEqual(["target.txt"]);
	});

	test("an abandoned call still shadows a neighbour inside the span it occupied", async () => {
		const repo = await createRepo("nf-hook-abandon-overlap-");
		const narratorId = await createNarrator(repo);
		const neighbourId = await createNarrator(repo);
		const session = makeSession(repo);
		const neighbour = makeSession(repo);
		writeFileSync(join(repo, "theirs.txt"), "v1\n");

		// The shell window opens first, so the failed Edit's span lies inside it. The Edit
		// may well have written its target before failing, so the declaration must not be
		// discarded — only its window pinned.
		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, null);
		await recordTreeSnapshotBefore(neighbour, neighbourId, "threw-mid-write", ["theirs.txt"]);
		writeFileSync(join(repo, "theirs.txt"), "v2\n");
		abandonTreeSnapshot(neighbour, neighbourId, "threw-mid-write");
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		expect(result.workspaceDelta).toEqual(["theirs.txt"]);
		expect(result.changedFiles).toEqual([]);
	});

	test("an interrupted turn abandons every call the narrator still holds", async () => {
		const repo = await createRepo("nf-hook-abandon-turn-");
		const abortedId = await createNarrator(repo);
		const otherId = await createNarrator(repo);
		const shellId = await createNarrator(repo);
		const aborted = makeSession(repo);
		const other = makeSession(repo);
		const shell = makeSession(repo);
		writeFileSync(join(repo, "one.txt"), "v1\n");
		writeFileSync(join(repo, "two.txt"), "v1\n");

		// Two tools announced and never resolved — the interrupt shape: Write/Edit/Bash
		// are all excluded from eager execution, so on abort their `tool_call` has been
		// emitted and their `tool_result` never will be.
		await recordTreeSnapshotBefore(aborted, abortedId, "edit-a", ["one.txt"]);
		await recordTreeSnapshotBefore(aborted, abortedId, "edit-b", ["two.txt"]);
		// A different narrator is genuinely still running and must not be sealed.
		await recordTreeSnapshotBefore(other, otherId, "still-running", ["two.txt"]);

		abandonSessionTreeSnapshots(aborted, abortedId);

		const { toolUseId } = await seedToolCall(shellId, "Bash", 1);
		await recordTreeSnapshotBefore(shell, shellId, toolUseId, null);
		writeFileSync(join(repo, "one.txt"), "shell-wrote-this\n");
		writeFileSync(join(repo, "two.txt"), "shell-wrote-this\n");
		const result = await recordTreeSnapshotAfter(shell, shellId, toolUseId);

		// `one.txt` survives (its claim was sealed before the shell window opened);
		// `two.txt` is still claimed by the narrator that is actually running.
		expect(result.workspaceDelta.sort()).toEqual(["one.txt", "two.txt"]);
		expect(result.changedFiles).toEqual(["one.txt"]);
	});

	test("abandoning drops the staged boundary and the cached hash", async () => {
		const repo = await createRepo("nf-hook-abandon-state-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "a.txt"), "v1\n");

		const first = await seedToolCall(narratorId, "Write", 1);
		await recordTreeSnapshotBefore(session, narratorId, first.toolUseId);
		// The tool wrote and then failed, so the cache from before it ran is stale.
		writeFileSync(join(repo, "a.txt"), "half-written\n");
		abandonTreeSnapshot(session, narratorId, first.toolUseId);
		expect(session._lastTreeHash).toBeUndefined();

		// The next tool's `before` must describe the real disk, including what the failed
		// tool managed to write — otherwise segment planning would chain across a state
		// that never existed.
		const truthful = await worktreeTreeSnapshot.capture(repo);
		const second = await seedToolCall(narratorId, "Write", 2);
		await recordTreeSnapshotBefore(session, narratorId, second.toolUseId);
		writeFileSync(join(repo, "a.txt"), "v2\n");
		const result = await recordTreeSnapshotAfter(session, narratorId, second.toolUseId);
		expect(result.before).toBe(truthful);

		// The abandoned call recorded no boundary of its own.
		const row = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, first.toolUseId),
			columns: { treeHashAfter: true },
		});
		expect(row?.treeHashAfter).toBeNull();
	});

	test("abandoning an unknown call is a no-op rather than an error", async () => {
		const repo = await createRepo("nf-hook-abandon-unknown-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		// The cleanup paths run unconditionally, including for tools that never opened a
		// claim (remote target, non-git workspace), so neither may throw.
		expect(() => abandonTreeSnapshot(session, narratorId, "never-opened")).not.toThrow();
		expect(() => abandonSessionTreeSnapshots(session, narratorId)).not.toThrow();
	});
});

describe("declaredWorktreePaths", () => {
	test("resolves an absolute path inside the worktree to a git-shaped relative path", () => {
		expect(declaredWorktreePaths("/work/repo", { file_path: "/work/repo/src/a.ts" })).toEqual([
			"src/a.ts",
		]);
	});

	test("resolves relative targets against the session workspace rather than the server cwd", () => {
		expect(declaredWorktreePaths("/work/repo", { file_path: "src/a.ts" })).toEqual(["src/a.ts"]);
		expect(declaredWorktreePaths("/work/repo", { file_path: "..notes" })).toEqual(["..notes"]);
	});

	test.skipIf(process.platform === "win32")("preserves POSIX filename backslashes", () => {
		expect(declaredWorktreePaths("/work/repo", { file_path: "/work/repo/a\\\\b.txt" })).toEqual([
			"a\\\\b.txt",
		]);
	});

	test("treats a spec:// URI as owning nothing on disk", () => {
		// Virtual files never reach the worktree, so there is nothing to restore. This
		// used to be inferred from `before === after`, which stops holding in a shared
		// worktree where a neighbour moves the hash during the call.
		expect(declaredWorktreePaths("/work/repo", { file_path: "spec://tasks.json" })).toEqual([]);
	});

	test("treats a path outside the worktree as owning nothing", () => {
		// Reported as a declaration of "nothing here", not as unknown: the call cannot
		// have changed a file this rollback is able to touch.
		expect(declaredWorktreePaths("/work/repo", { file_path: "/etc/hosts" })).toEqual([]);
		expect(declaredWorktreePaths("/work/repo", { file_path: "/work/other/a.ts" })).toEqual([]);
	});

	test("returns nothing for input that names no file", () => {
		expect(declaredWorktreePaths("/work/repo", {})).toEqual([]);
		expect(declaredWorktreePaths("/work/repo", null)).toEqual([]);
		expect(declaredWorktreePaths("/work/repo", { file_path: 42 })).toEqual([]);
	});
});

/**
 * A worktree is shared, and a tree hash covers all of it. So the span between a
 * tool's two boundaries also holds whatever the neighbours wrote while it ran —
 * which is how a narrator that only ran `git log` and `bun test` came to report
 * three modified files belonging to other narrators.
 */
describe("attribution in a shared worktree", () => {
	test("a read-only shell call owns nothing even though the tree moved", async () => {
		const repo = await createRepo("nf-hook-shared-readonly-");
		const narratorId = await createNarrator(repo);
		const neighbourId = await createNarrator(repo);
		const session = makeSession(repo);
		const neighbour = makeSession(repo);
		writeFileSync(join(repo, "theirs.txt"), "v1\n");

		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, null);
		// The neighbour's Write/Edit declares its target before it writes, exactly as
		// its own snapshot hook does.
		await recordTreeSnapshotBefore(neighbour, neighbourId, "neighbour-tool", ["theirs.txt"]);
		writeFileSync(join(repo, "theirs.txt"), "v2\n");
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		// The workspace genuinely moved, and the raw delta still says so — that is the
		// trap. Attribution is what separates the two.
		expect(result.before).not.toBe(result.after);
		expect(result.workspaceDelta).toEqual(["theirs.txt"]);
		expect(result.changedFiles).toEqual([]);

		const row = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
			columns: { ownedPathsJson: true },
		});
		expect(row?.ownedPathsJson).toEqual([]);
	});

	test("a declared write owns only its own target, not a concurrent neighbour's", async () => {
		const repo = await createRepo("nf-hook-shared-declared-");
		const narratorId = await createNarrator(repo);
		const neighbourId = await createNarrator(repo);
		const session = makeSession(repo);
		const neighbour = makeSession(repo);
		writeFileSync(join(repo, "mine.txt"), "mine-v1\n");
		writeFileSync(join(repo, "theirs.txt"), "theirs-v1\n");

		const { toolUseId } = await seedToolCall(narratorId, "Edit", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, declare(repo, "mine.txt"));
		await recordTreeSnapshotBefore(neighbour, neighbourId, "neighbour-tool", ["theirs.txt"]);
		writeFileSync(join(repo, "mine.txt"), "mine-v2\n");
		writeFileSync(join(repo, "theirs.txt"), "theirs-v2\n");
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		expect(result.workspaceDelta.sort()).toEqual(["mine.txt", "theirs.txt"]);
		// Attributing the raw delta is what credited one narrator with another's edits
		// in `file_attributions`.
		expect(result.changedFiles).toEqual(["mine.txt"]);
	});

	test("a declared path the tool did not actually write is not claimed", async () => {
		const repo = await createRepo("nf-hook-declared-noop-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "target.txt"), "unchanged\n");
		writeFileSync(join(repo, "other.txt"), "v1\n");

		// An Edit that produces identical bytes changes nothing, while something else
		// moves the tree during the window. Neither path may be claimed: one was not
		// written, the other was never declared.
		const { toolUseId } = await seedToolCall(narratorId, "Edit", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, declare(repo, "target.txt"));
		writeFileSync(join(repo, "other.txt"), "v2\n");
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		expect(result.workspaceDelta).toEqual(["other.txt"]);
		expect(result.changedFiles).toEqual([]);
	});

	test("a shell call keeps its own writes while dropping a declared neighbour's", async () => {
		const repo = await createRepo("nf-hook-shared-shell-");
		const narratorId = await createNarrator(repo);
		const neighbourId = await createNarrator(repo);
		const session = makeSession(repo);
		const neighbour = makeSession(repo);
		writeFileSync(join(repo, "built.txt"), "old\n");
		writeFileSync(join(repo, "theirs.txt"), "theirs-v1\n");

		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, null);
		await recordTreeSnapshotBefore(neighbour, neighbourId, "neighbour-tool", ["theirs.txt"]);
		// A real build step writing a file no tool input describes, plus the
		// neighbour's concurrent edit.
		await safeSpawn({
			cmd: ["sh", "-c", "printf 'new\\n' > built.txt && printf 'theirs-v2\\n' > theirs.txt"],
			cwd: repo,
			timeout: 15_000,
		});
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		expect(result.workspaceDelta.sort()).toEqual(["built.txt", "theirs.txt"]);
		// The capability that must not regress: a shell command's own writes are still
		// captured, even though they were never declared.
		expect(result.changedFiles).toEqual(["built.txt"]);
	});

	test("a neighbour that finished before the window began is not subtracted", async () => {
		const repo = await createRepo("nf-hook-stale-claim-");
		const narratorId = await createNarrator(repo);
		const neighbourId = await createNarrator(repo);
		const session = makeSession(repo);
		const neighbour = makeSession(repo);
		writeFileSync(join(repo, "shared.txt"), "v1\n");

		// The neighbour declares and completes first. Its declaration must not shadow a
		// later shell call that genuinely wrote the same file, or that write would
		// become unrevertable.
		await recordTreeSnapshotBefore(neighbour, neighbourId, "neighbour-tool", ["shared.txt"]);
		await recordTreeSnapshotAfter(neighbour, neighbourId, "neighbour-tool");

		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, null);
		writeFileSync(join(repo, "shared.txt"), "v2\n");
		const result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);

		expect(result.changedFiles).toEqual(["shared.txt"]);
	});
});

/**
 * The workspace change feed a file tree patches from.
 *
 * This exists because the tempting mistake is silent: the hook computes both a raw
 * delta and a narrower `owned` set, and broadcasting `owned` would look correct in
 * every single-narrator test. In a shared worktree it would omit a neighbour's writes,
 * so the tree would keep rendering files that are no longer on disk — with nothing
 * anywhere reporting a problem.
 */
describe("workspace path change broadcast", () => {
	/** Collect `workspace_paths_changed` frames emitted during `run`. */
	async function captureBroadcasts(
		run: () => Promise<void>,
	): Promise<
		{ narratorId: string; changes: { path: string; kind: string }[]; truncated: boolean }[]
	> {
		const frames: {
			narratorId: string;
			changes: { path: string; kind: string }[];
			truncated: boolean;
		}[] = [];
		const handler = (event: NarraForkEvent) => {
			if (event.type !== "narrator:ws_broadcast") return;
			const message = event.message as {
				type?: string;
				changes?: { path: string; kind: string }[];
				truncated?: boolean;
			};
			if (message.type !== "workspace_paths_changed") return;
			frames.push({
				narratorId: event.narratorId,
				changes: message.changes ?? [],
				truncated: message.truncated === true,
			});
		};
		eventBus.on("narrator:ws_broadcast", handler);
		try {
			await run();
		} finally {
			eventBus.off("narrator:ws_broadcast", handler);
		}
		return frames;
	}

	test("announces the whole workspace delta, not just the acting call's owned set", async () => {
		const repo = await createRepo("nf-hook-broadcast-delta-");
		const narratorId = await createNarrator(repo);
		const neighbourId = await createNarrator(repo);
		const session = makeSession(repo);
		const neighbour = makeSession(repo);
		writeFileSync(join(repo, "mine.txt"), "mine-v1\n");
		writeFileSync(join(repo, "theirs.txt"), "theirs-v1\n");

		const { toolUseId } = await seedToolCall(narratorId, "Edit", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, declare(repo, "mine.txt"));
		await recordTreeSnapshotBefore(neighbour, neighbourId, "neighbour-tool", ["theirs.txt"]);
		writeFileSync(join(repo, "mine.txt"), "mine-v2\n");
		writeFileSync(join(repo, "theirs.txt"), "theirs-v2\n");

		let result: Awaited<ReturnType<typeof recordTreeSnapshotAfter>> | undefined;
		const frames = await captureBroadcasts(async () => {
			result = await recordTreeSnapshotAfter(session, narratorId, toolUseId);
		});

		// Attribution correctly narrows to the declared target...
		expect(result?.changedFiles).toEqual(["mine.txt"]);
		// ...but the tree must hear about both, because both are on disk now.
		expect(frames.length).toBeGreaterThan(0);
		const paths = frames[0]?.changes.map((entry) => entry.path).sort();
		expect(paths).toEqual(["mine.txt", "theirs.txt"]);
	});

	test("carries the change kind for each path", async () => {
		const repo = await createRepo("nf-hook-broadcast-kind-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "gone.txt"), "bye\n");

		const { toolUseId } = await seedToolCall(narratorId, "Bash", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, null);
		rmSync(join(repo, "gone.txt"));
		writeFileSync(join(repo, "fresh.txt"), "new\n");

		const frames = await captureBroadcasts(async () => {
			await recordTreeSnapshotAfter(session, narratorId, toolUseId);
		});

		const byPath = new Map(frames[0]?.changes.map((entry) => [entry.path, entry.kind]));
		// A tree cannot patch itself from paths alone: it has to know whether a row
		// appears or disappears.
		expect(byPath.get("fresh.txt")).toBe("added");
		expect(byPath.get("gone.txt")).toBe("deleted");
	});

	test("reaches the acting narrator even with no watcher registered", async () => {
		// The tool path must not depend on the filesystem watcher being active — that is
		// the whole reason this source exists (the native watcher is opt-in).
		const repo = await createRepo("nf-hook-broadcast-nowatcher-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);

		const { toolUseId } = await seedToolCall(narratorId, "Edit", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, declare(repo, "a.txt"));
		writeFileSync(join(repo, "a.txt"), "one\n");

		const frames = await captureBroadcasts(async () => {
			await recordTreeSnapshotAfter(session, narratorId, toolUseId);
		});

		expect(frames.map((frame) => frame.narratorId)).toEqual([narratorId]);
	});

	test("stays silent when the tool changed nothing", async () => {
		// Every no-op tool call would otherwise wake every attached tree.
		const repo = await createRepo("nf-hook-broadcast-noop-");
		const narratorId = await createNarrator(repo);
		const session = makeSession(repo);
		writeFileSync(join(repo, "a.txt"), "one\n");

		const { toolUseId } = await seedToolCall(narratorId, "Read", 1);
		await recordTreeSnapshotBefore(session, narratorId, toolUseId, []);

		const frames = await captureBroadcasts(async () => {
			await recordTreeSnapshotAfter(session, narratorId, toolUseId);
		});

		expect(frames).toEqual([]);
	});
});
