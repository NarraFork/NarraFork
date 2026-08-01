import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import iconv from "iconv-lite";
import { db } from "../db";
import {
	chapters,
	fileAttributions,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	worktreeTreeSnapshots,
} from "../db/schema";
import { generateId } from "../lib/id";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import { recordAttribution } from "./file-attribution-service";
import {
	recordTreeSnapshotAfter,
	recordTreeSnapshotBefore,
	type TreeSnapshotSession,
} from "./narrator-tree-snapshot-hooks";
import {
	commitSnapshotRevert,
	discardSnapshotRevert,
	finalizeSnapshotRevert,
	loadTreePreviewContents,
	previewSeqTreeRevert,
	revertForMessagesTree,
	revertFromSeqTree,
	revertToMessageTree,
	revertToToolCallTree,
	revertWorkspaceToTree,
} from "./snapshot-revert";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const createdNarrators: string[] = [];
const createdChapters: string[] = [];
const createdProjects: string[] = [];
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

/** Run one tool "turn": snapshot, apply the mutation, snapshot again. */
async function runToolTurn(
	session: TreeSnapshotSession,
	narratorId: string,
	seq: number,
	mutate: () => void,
	toolName = "Write",
): Promise<{ toolUseId: string; messageId: string; before: string | null; after: string | null }> {
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
	const { before, after } = await recordTreeSnapshotAfter(session, narratorId, toolUseId);
	return { toolUseId, messageId, before, after };
}

afterEach(async () => {
	for (const narratorId of createdNarrators.splice(0)) {
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
		await db.delete(narrators).where(eq(narrators.id, narratorId));
	}
	for (const chapterId of createdChapters.splice(0)) {
		await db.delete(chapters).where(eq(chapters.id, chapterId));
	}
	for (const projectId of createdProjects.splice(0)) {
		await db.delete(projects).where(eq(projects.id, projectId));
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

describe("tree-based rollback", () => {
	test("reverting to a tool call's boundary undoes exactly that tool's writes", async () => {
		const repo = await createRepo("nf-tree-revert-tool-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "v1\n");

		const turn = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "a.txt"), "v2\n");
			writeFileSync(join(repo, "extra.txt"), "created\n");
		});

		const result = await revertToToolCallTree(narratorId, turn.toolUseId);
		expect(result).not.toBeNull();
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1\n");
		// A file the tool created did not exist at the boundary, so it must be gone.
		expect(existsSync(join(repo, "extra.txt"))).toBe(false);
	});

	test("reverting to a message boundary keeps that message's own changes", async () => {
		const repo = await createRepo("nf-tree-revert-msg-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "v1\n");

		const first = await runToolTurn(session, narratorId, 1, () =>
			writeFileSync(join(repo, "a.txt"), "v2\n"),
		);
		await runToolTurn(session, narratorId, 2, () => writeFileSync(join(repo, "a.txt"), "v3\n"));

		// "Roll back to just after the first message" keeps v2 and discards v3.
		const result = await revertToMessageTree(narratorId, first.messageId);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v2\n");
	});

	test("reverting from a sequence discards every later turn", async () => {
		const repo = await createRepo("nf-tree-revert-seq-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "v1\n");

		await runToolTurn(session, narratorId, 1, () => writeFileSync(join(repo, "a.txt"), "v2\n"));
		await runToolTurn(session, narratorId, 2, () => writeFileSync(join(repo, "a.txt"), "v3\n"));
		await runToolTurn(session, narratorId, 3, () => writeFileSync(join(repo, "a.txt"), "v4\n"));

		// From seq 2 onwards: restores the state before the second turn, i.e. v2.
		const result = await revertFromSeqTree(narratorId, 2);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v2\n");
	});

	test("reverting for a set of deleted messages restores the earliest boundary", async () => {
		const repo = await createRepo("nf-tree-revert-msgs-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "v1\n");

		await runToolTurn(session, narratorId, 1, () => writeFileSync(join(repo, "a.txt"), "v2\n"));
		const second = await runToolTurn(session, narratorId, 2, () =>
			writeFileSync(join(repo, "a.txt"), "v3\n"),
		);
		const third = await runToolTurn(session, narratorId, 3, () =>
			writeFileSync(join(repo, "a.txt"), "v4\n"),
		);

		const result = await revertForMessagesTree(narratorId, [second.messageId, third.messageId]);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v2\n");
	});

	test("undoes changes made by a shell command, which replay could not reconstruct", async () => {
		const repo = await createRepo("nf-tree-revert-bash-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "original\n");

		const turn = await runToolTurn(
			session,
			narratorId,
			1,
			() => {
				// No Write/Edit tool input describes any of this.
				writeFileSync(join(repo, "a.txt"), "clobbered by shell\n");
				writeFileSync(join(repo, "side-effect.txt"), "junk\n");
			},
			"Bash",
		);

		const result = await revertToToolCallTree(narratorId, turn.toolUseId);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("original\n");
		expect(existsSync(join(repo, "side-effect.txt"))).toBe(false);
	});

	test("restores binary and legacy-encoded files byte for byte", async () => {
		const repo = await createRepo("nf-tree-revert-bytes-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		const blob = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]);
		const gbkText = "你好世界\n";
		const gbkBytes = iconv.encode(gbkText, "gbk");
		writeFileSync(join(repo, "blob.bin"), blob);
		writeFileSync(join(repo, "gbk.txt"), gbkBytes);

		const turn = await runToolTurn(session, narratorId, 1, () => {
			writeFileSync(join(repo, "blob.bin"), Buffer.from([0x99]));
			writeFileSync(join(repo, "gbk.txt"), "overwritten as utf-8");
		});

		const result = await revertToToolCallTree(narratorId, turn.toolUseId);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		expect(Buffer.compare(readFileSync(join(repo, "blob.bin")), blob)).toBe(0);
		expect(Buffer.compare(readFileSync(join(repo, "gbk.txt")), gbkBytes)).toBe(0);
	});

	test("a failed history mutation restores the pre-rollback state", async () => {
		const repo = await createRepo("nf-tree-revert-compensate-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "v1\n");

		const turn = await runToolTurn(session, narratorId, 1, () =>
			writeFileSync(join(repo, "a.txt"), "v2\n"),
		);

		const result = await revertToToolCallTree(narratorId, turn.toolUseId);
		expect(result).not.toBeNull();
		if (!result) throw new Error("expected a revert result");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1\n");

		// The history mutation fails, so the filesystem must go back to v2: files and
		// retained history have to agree.
		await expect(
			commitSnapshotRevert(result, () => {
				throw new Error("history mutation failed");
			}),
		).rejects.toThrow("history mutation failed");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v2\n");
	});

	test("discarding a tree rollback restores the pre-rollback state", async () => {
		const repo = await createRepo("nf-tree-revert-discard-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "v1\n");

		const turn = await runToolTurn(session, narratorId, 1, () =>
			writeFileSync(join(repo, "a.txt"), "v2\n"),
		);
		const result = await revertToToolCallTree(narratorId, turn.toolUseId);
		if (!result) throw new Error("expected a revert result");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1\n");

		expect(await discardSnapshotRevert(result)).toEqual([]);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v2\n");
	});

	test("a missing tree object fails without touching any file", async () => {
		const repo = await createRepo("nf-tree-revert-missing-");
		const narratorId = await createNarrator(repo);
		writeFileSync(join(repo, "a.txt"), "untouched\n");
		await worktreeTreeSnapshot.capture(repo);

		const result = await revertWorkspaceToTree(narratorId, "0".repeat(40));
		expect(result.reverted).toBe(false);
		expect(result.failures[0]?.code).toBe("TREE_SNAPSHOT_MISSING");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("untouched\n");
	});

	test("history without recorded boundaries returns null so callers can fall back", async () => {
		const repo = await createRepo("nf-tree-revert-legacy-");
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
		// A pre-snapshot row: no tree hashes recorded.
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

		expect(await revertToToolCallTree(narratorId, toolUseId)).toBeNull();
		expect(await revertToMessageTree(narratorId, messageId)).toBeNull();
		expect(await revertFromSeqTree(narratorId, 1)).toBeNull();
		expect(await revertForMessagesTree(narratorId, [messageId])).toBeNull();
	});

	test("the preview lists exactly the files the rollback changes, including Bash-only ones", async () => {
		const repo = await createRepo("nf-tree-preview-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "tracked.txt"), "v1\n");

		await runToolTurn(
			session,
			narratorId,
			1,
			() => {
				// None of this is described by a Write/Edit tool input, so the old
				// input-derived preview would have reported an empty list.
				writeFileSync(join(repo, "tracked.txt"), "v2\n");
				writeFileSync(join(repo, "created-by-bash.txt"), "new\n");
			},
			"Bash",
		);

		const preview = await previewSeqTreeRevert(narratorId, 1);
		expect(preview).not.toBeNull();
		if (!preview) throw new Error("expected a tree preview");
		expect(preview.files.map((f) => f.relPath).sort()).toEqual([
			"created-by-bash.txt",
			"tracked.txt",
		]);
		// A file that did not exist at the boundary is removed by restoring it.
		expect(preview.files.find((f) => f.relPath === "created-by-bash.txt")?.willBeDeleted).toBe(
			true,
		);
		expect(preview.files.find((f) => f.relPath === "tracked.txt")?.willBeDeleted).toBe(false);

		// The preview must agree with what the rollback actually touches.
		const result = await revertFromSeqTree(narratorId, 1);
		if (result) finalizeSnapshotRevert(result);
		expect(result?.files.sort()).toEqual(["created-by-bash.txt", "tracked.txt"]);
	});

	test("the preview supplies current and reverted text for diffing", async () => {
		const repo = await createRepo("nf-tree-preview-content-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "original\n");

		await runToolTurn(session, narratorId, 1, () =>
			writeFileSync(join(repo, "a.txt"), "changed\n"),
		);

		const preview = await previewSeqTreeRevert(narratorId, 1);
		if (!preview) throw new Error("expected a tree preview");
		const [file] = await loadTreePreviewContents(preview);
		expect(file.currentContent).toBe("changed\n");
		expect(file.revertedContent).toBe("original\n");
	});

	test("the preview omits binary contents instead of returning mojibake", async () => {
		const repo = await createRepo("nf-tree-preview-binary-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "blob.bin"), Buffer.from([0x00, 0x01, 0xff, 0xfe]));

		await runToolTurn(session, narratorId, 1, () =>
			writeFileSync(join(repo, "blob.bin"), Buffer.from([0x00, 0x99])),
		);

		const preview = await previewSeqTreeRevert(narratorId, 1);
		if (!preview) throw new Error("expected a tree preview");
		const [file] = await loadTreePreviewContents(preview);
		// The file is still reported as affected; only its text preview is withheld.
		expect(file.relPath).toBe("blob.bin");
		expect(file.currentContent).toBeNull();
		expect(file.revertedContent).toBeNull();
	});

	test("no preview is produced for history without boundaries", async () => {
		const repo = await createRepo("nf-tree-preview-legacy-");
		const narratorId = await createNarrator(repo);
		writeFileSync(join(repo, "a.txt"), "v1\n");
		expect(await previewSeqTreeRevert(narratorId, 1)).toBeNull();
	});

	// Standalone narrators are not bound to a chapter, so their workspace comes from
	// their own cwd or their context project's repo. Rollback must resolve the same
	// directory the session ran in, otherwise snapshots are captured in one place and
	// reverted in another.
	test("a standalone narrator with its own cwd can be rolled back", async () => {
		const repo = await createRepo("nf-tree-standalone-cwd-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "v1\n");

		const turn = await runToolTurn(session, narratorId, 1, () =>
			writeFileSync(join(repo, "a.txt"), "v2\n"),
		);

		const result = await revertToToolCallTree(narratorId, turn.toolUseId);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1\n");
	});

	test("a standalone narrator scoped to a project rolls back in the project repo", async () => {
		const repo = await createRepo("nf-tree-standalone-project-");
		const projectId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: projectId,
			name: "Standalone context project",
			gitPath: repo,
			createdAt: now,
			updatedAt: now,
		});
		createdProjects.push(projectId);

		// No chapter and no explicit cwd: the session resolves to the project git path,
		// so the revert path has to do the same.
		const narratorId = generateId();
		await db.insert(narrators).values({
			id: narratorId,
			cwd: null,
			contextProjectId: projectId,
			createdAt: now,
			updatedAt: now,
		});
		createdNarrators.push(narratorId);

		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "v1\n");
		const turn = await runToolTurn(session, narratorId, 1, () =>
			writeFileSync(join(repo, "a.txt"), "v2\n"),
		);

		const result = await revertToToolCallTree(narratorId, turn.toolUseId);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1\n");
	});

	test("a chapter-bound narrator falls back to the project repo when dormant", async () => {
		const repo = await createRepo("nf-tree-dormant-");
		const projectId = generateId();
		const chapterId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: projectId,
			name: "Dormant chapter project",
			gitPath: repo,
			createdAt: now,
			updatedAt: now,
		});
		createdProjects.push(projectId);
		// A dormant chapter has no worktree; the session runs in the project repo.
		await db.insert(chapters).values({
			id: chapterId,
			projectId,
			title: "Dormant chapter",
			status: "dormant",
			branch: `chapter/dormant-${generateId()}`,
			baseBranch: "main",
			worktreePath: null,
			createdAt: now,
			updatedAt: now,
		});
		createdChapters.push(chapterId);

		const narratorId = generateId();
		await db.insert(narrators).values({
			id: narratorId,
			chapterId,
			cwd: null,
			createdAt: now,
			updatedAt: now,
		});
		createdNarrators.push(narratorId);

		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "v1\n");
		const turn = await runToolTurn(session, narratorId, 1, () =>
			writeFileSync(join(repo, "a.txt"), "v2\n"),
		);

		const result = await revertToToolCallTree(narratorId, turn.toolUseId);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1\n");
	});

	test("an unresolvable workspace fails instead of touching the home directory", async () => {
		// No cwd, no chapter, no context project: there is no workspace to restore, and
		// falling back to the home directory would be destructive.
		const narratorId = generateId();
		const now = new Date().toISOString();
		await db
			.insert(narrators)
			.values({ id: narratorId, cwd: null, createdAt: now, updatedAt: now });
		createdNarrators.push(narratorId);

		const result = await revertWorkspaceToTree(narratorId, "0".repeat(40));
		expect(result.reverted).toBe(false);
		expect(result.failures[0]?.code).toBe("PREPARE_FAILED");
	});

	test("warns when the reverted window contained another actor's changes", async () => {
		const repo = await createRepo("nf-tree-revert-warn-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "v1\n");

		const turn = await runToolTurn(session, narratorId, 1, () =>
			writeFileSync(join(repo, "a.txt"), "v2\n"),
		);

		// Someone else also wrote inside the window this rollback undoes. A workspace
		// restore discards that too, so the result must say so rather than imply the
		// change set was this narrator's alone.
		await recordAttribution({
			deviceId: "local",
			workspacePath: repo,
			filePath: "other.txt",
			narratorId: null,
			action: "external",
			toolName: null,
			toolUseId: null,
		});

		const result = await revertToToolCallTree(narratorId, turn.toolUseId);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		// Structured, not prose: the UI is bilingual, so wording is the client's job.
		expect(result?.warnings?.length).toBe(1);
		const warning = result?.warnings?.[0];
		expect(warning?.code).toBe("WORKSPACE_SCOPE_DISCARDED_OTHERS");
		if (warning?.code === "WORKSPACE_SCOPE_DISCARDED_OTHERS") {
			expect(warning.externalCount).toBeGreaterThan(0);
			expect(warning.sampleFilePaths).toContain("other.txt");
		}
	});

	test("omits warnings when the window is clean", async () => {
		const repo = await createRepo("nf-tree-revert-nowarn-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, "a.txt"), "v1\n");

		const turn = await runToolTurn(session, narratorId, 1, () =>
			writeFileSync(join(repo, "a.txt"), "v2\n"),
		);
		await recordAttribution({
			deviceId: "local",
			workspacePath: repo,
			filePath: "a.txt",
			narratorId,
			action: "write",
			toolName: "Write",
			toolUseId: turn.toolUseId,
		});

		const result = await revertToToolCallTree(narratorId, turn.toolUseId);
		if (result) finalizeSnapshotRevert(result);
		expect(result?.warnings).toBeUndefined();
	});

	test("leaves gitignored files alone when rolling back", async () => {
		const repo = await createRepo("nf-tree-revert-ignored-");
		const narratorId = await createNarrator(repo);
		const session: TreeSnapshotSession = { cwd: repo };
		writeFileSync(join(repo, ".gitignore"), "*.local\n");
		writeFileSync(join(repo, "keep.local"), "user data\n");
		writeFileSync(join(repo, "a.txt"), "v1\n");

		const turn = await runToolTurn(session, narratorId, 1, () =>
			writeFileSync(join(repo, "a.txt"), "v2\n"),
		);
		writeFileSync(join(repo, "keep.local"), "user data, edited later\n");

		const result = await revertToToolCallTree(narratorId, turn.toolUseId);
		expect(result?.failures).toEqual([]);
		if (result) finalizeSnapshotRevert(result);

		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1\n");
		// Ignored files are outside the snapshot's authority.
		expect(readFileSync(join(repo, "keep.local"), "utf8")).toBe("user data, edited later\n");
	});
});
