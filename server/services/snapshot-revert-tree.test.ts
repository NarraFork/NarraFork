/**
 * M0: historical hashes do not carry complete-capture receipts. Former tests that
 * expected automatic v1 restore/compensation now require refusal and unchanged
 * bytes. Low-level tree engine mechanics are covered in its own test suite.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import iconv from "iconv-lite";
import { db } from "../db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
} from "../db/schema";
import { generateId } from "../lib/id";
import { safeSpawn } from "../lib/spawn";
import type { TreeSnapshotSession } from "./narrator-tree-snapshot-hooks";
import {
	commitSnapshotRevert,
	discardSnapshotRevert,
	finalizeSnapshotRevert,
	loadTreePreviewContents,
	previewSeqTreeRevert,
	resolveNarratorCwd,
	revertForMessagesTree,
	revertFromSeqTree,
	revertToMessageTree,
	revertToToolCallTree,
	revertWorkspaceToTree,
	unavailableSnapshotRevert,
} from "./snapshot-revert";
import { buildTreeSnapshotEventHooks } from "./tree-snapshot-loop-hooks";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const ids: string[] = [];
const projectIds: string[] = [];
const chapterIds: string[] = [];
const dirs: string[] = [];

async function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "nf-tree-m0-"));
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
async function call(f: Fixture, seq: number, mutate: () => void, capture = true) {
	const messageId = generateId();
	const toolUseId = generateId();
	const createdAt = new Date().toISOString();
	const input = { file_path: join(f.repo, "a.txt"), content: "changed\n" };
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: f.narratorId,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name: "Write", input }],
		createdAt,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: f.narratorId, messageId, seq });
	const hooks = buildTreeSnapshotEventHooks({
		session: f.session,
		narratorId: f.narratorId,
		isInGitRepo: true,
	});
	if (capture) await hooks.onSnapshotBefore?.(toolUseId, "Write", input);
	await db.insert(narratorToolCalls).values({
		id: generateId(),
		narratorId: f.narratorId,
		messageId,
		toolUseId,
		toolName: "Write",
		inputJson: input,
		status: "running",
		createdAt,
	});
	mutate();
	await db
		.update(narratorToolCalls)
		.set({ status: "success", completedAt: new Date().toISOString() })
		.where(eq(narratorToolCalls.toolUseId, toolUseId));
	if (capture) await hooks.onSnapshotAfter?.(toolUseId, "Write");
	return { messageId, toolUseId };
}

afterEach(async () => {
	for (const id of ids.splice(0)) {
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, id));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
		await db.delete(narrators).where(eq(narrators.id, id));
	}
	for (const id of chapterIds.splice(0)) await db.delete(chapters).where(eq(chapters.id, id));
	for (const id of projectIds.splice(0)) await db.delete(projects).where(eq(projects.id, id));
	for (const dir of dirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("M0 workspace restore safety", () => {
	test("a real stored tree object cannot authorize deletion without a complete receipt", async () => {
		const f = await fixture();
		writeFileSync(join(f.repo, "a.txt"), "baseline\n");
		const tree = await worktreeTreeSnapshot.capture(f.repo);
		expect(await worktreeTreeSnapshot.hasTree(f.repo, tree)).toBe(true);
		writeFileSync(join(f.repo, "a.txt"), "later\n");
		writeFileSync(join(f.repo, "absent-from-old-tree.txt"), "do not delete\n");
		const restore = spyOn(worktreeTreeSnapshot, "restore");
		try {
			const result = await revertWorkspaceToTree(f.narratorId, tree);
			expect(result).toMatchObject({ reverted: false, fileCount: 0, files: [] });
			expect(result.failures[0]?.code).toBe("REVERT_UNAVAILABLE");
			expect(result.failures[0]?.message).toContain("legacy_unverified");
			expect(restore).not.toHaveBeenCalled();
			expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("later\n");
			expect(readFileSync(join(f.repo, "absent-from-old-tree.txt"), "utf8")).toBe(
				"do not delete\n",
			);
		} finally {
			restore.mockRestore();
		}
	});

	test("all recorded tree selector adapters refuse the same legacy history", async () => {
		const f = await fixture();
		writeFileSync(join(f.repo, "a.txt"), "v1\n");
		const first = await call(f, 1, () => writeFileSync(join(f.repo, "a.txt"), "v2\n"));
		await call(f, 2, () => writeFileSync(join(f.repo, "a.txt"), "v3\n"));
		for (const result of [
			await revertToToolCallTree(f.narratorId, first.toolUseId),
			await revertToMessageTree(f.narratorId, first.messageId),
			await revertFromSeqTree(f.narratorId, 1),
			await revertForMessagesTree(f.narratorId, [first.messageId]),
		]) {
			expect(result?.failures[0]?.code).toBe("REVERT_UNAVAILABLE");
			expect(result?.failures[0]?.message).toContain("legacy_unverified");
		}
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("v3\n");
	});

	test("a missing boundary is an explicit refusal, never permission to replay", async () => {
		const f = await fixture();
		const target = await call(f, 1, () => writeFileSync(join(f.repo, "a.txt"), "legacy\n"), false);
		for (const result of [
			await revertToToolCallTree(f.narratorId, target.toolUseId),
			await revertToMessageTree(f.narratorId, target.messageId),
			await revertFromSeqTree(f.narratorId, 1),
			await revertForMessagesTree(f.narratorId, [target.messageId]),
		]) {
			expect(result?.failures[0]?.code).toBe("REVERT_UNAVAILABLE");
		}
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("legacy\n");
	});

	test("refusal cannot later compensate over an external write or commit history", async () => {
		const f = await fixture();
		const tree = await worktreeTreeSnapshot.capture(f.repo);
		writeFileSync(join(f.repo, "a.txt"), "AI\n");
		const result = await revertWorkspaceToTree(f.narratorId, tree);
		let committed = false;
		await expect(
			commitSnapshotRevert(result, () => {
				committed = true;
			}),
		).rejects.toThrow("REVERT_UNAVAILABLE");
		expect(committed).toBe(false);
		writeFileSync(join(f.repo, "a.txt"), "HUMAN\n");
		expect(await discardSnapshotRevert(result)).toEqual([]);
		finalizeSnapshotRevert(result);
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("HUMAN\n");
	});

	test("binary, CRLF, legacy-encoded and ignored current bytes all survive refusal", async () => {
		const f = await fixture();
		writeFileSync(join(f.repo, ".gitignore"), "*.local\n");
		const tree = await worktreeTreeSnapshot.capture(f.repo);
		const files = {
			"二进制.bin": Buffer.from([0, 255, 34]),
			"crlf.txt": Buffer.from("a\r\nb\r\n"),
			"gbk.txt": iconv.encode("中文\r\n", "gbk"),
			"user.local": Buffer.from("private\n"),
		};
		for (const [path, bytes] of Object.entries(files)) writeFileSync(join(f.repo, path), bytes);
		expect((await revertWorkspaceToTree(f.narratorId, tree)).failures[0]?.code).toBe(
			"REVERT_UNAVAILABLE",
		);
		for (const [path, bytes] of Object.entries(files))
			expect(Buffer.compare(readFileSync(join(f.repo, path)), bytes)).toBe(0);
	});

	test("a missing tree and an unresolvable workspace also fail without writing", async () => {
		const f = await fixture();
		expect((await revertWorkspaceToTree(f.narratorId, "0".repeat(40))).failures[0]?.code).toBe(
			"REVERT_UNAVAILABLE",
		);
		await db.update(narrators).set({ cwd: null }).where(eq(narrators.id, f.narratorId));
		const result = await revertWorkspaceToTree(f.narratorId, "0".repeat(40));
		expect(result.failures[0]).toMatchObject({ code: "REVERT_UNAVAILABLE", filePath: "(unknown)" });
		expect(result.failures[0]?.message).toContain("no_workspace");
	});

	test("unavailableSnapshotRevert exposes the stable failure contract", () => {
		expect(unavailableSnapshotRevert("incomplete_coverage")).toEqual({
			reverted: false,
			fileCount: 0,
			files: [],
			failures: [
				{
					deviceId: "local",
					filePath: "(unknown)",
					code: "REVERT_UNAVAILABLE",
					message: "incomplete_coverage",
				},
			],
		});
		expect(
			unavailableSnapshotRevert("legacy_unverified", "/workspace/file").failures[0]?.filePath,
		).toBe("/workspace/file");
	});
});

describe("M0 legacy tree material remains read-only", () => {
	test("tree comparison reports unverified availability and still permits content inspection", async () => {
		const f = await fixture();
		writeFileSync(join(f.repo, "a.txt"), "original\n");
		await call(f, 1, () => writeFileSync(join(f.repo, "a.txt"), "changed\n"));
		const preview = await previewSeqTreeRevert(f.narratorId, 1);
		expect(preview).toMatchObject({ available: false, reason: "legacy_unverified" });
		if (!preview) throw new Error("expected legacy comparison material");
		const [file] = await loadTreePreviewContents(preview);
		expect(file.currentContent).toBe("changed\n");
		expect(file.revertedContent).toBe("original\n");
		expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("changed\n");
	});

	test("binary comparison withholds text and never advertises an executable restore", async () => {
		const f = await fixture();
		writeFileSync(join(f.repo, "a.txt"), Buffer.from([0, 1, 255]));
		await call(f, 1, () => writeFileSync(join(f.repo, "a.txt"), Buffer.from([0, 99])));
		const preview = await previewSeqTreeRevert(f.narratorId, 1);
		if (!preview) throw new Error("expected legacy comparison material");
		expect(preview.available).toBe(false);
		const [file] = await loadTreePreviewContents(preview);
		expect(file.currentContent).toBeNull();
		expect(file.revertedContent).toBeNull();
	});

	test("missing boundaries produce no fabricated comparison", async () => {
		const f = await fixture();
		expect(await previewSeqTreeRevert(f.narratorId, 1)).toBeNull();
	});

	test.each([
		false,
		true,
	])("project fallback resolves the workspace but does not verify old evidence (chapter=%s)", async (chapter) => {
		const f = await fixture();
		const projectId = generateId();
		const now = new Date().toISOString();
		await db
			.insert(projects)
			.values({ id: projectId, name: "test", gitPath: f.repo, createdAt: now, updatedAt: now });
		projectIds.push(projectId);
		let chapterId: string | null = null;
		if (chapter) {
			chapterId = generateId();
			chapterIds.push(chapterId);
			await db.insert(chapters).values({
				id: chapterId,
				projectId,
				title: "dormant",
				status: "dormant",
				branch: "test",
				baseBranch: "main",
				worktreePath: null,
				createdAt: now,
				updatedAt: now,
			});
		}
		await db
			.update(narrators)
			.set({ cwd: null, chapterId, contextProjectId: projectId })
			.where(eq(narrators.id, f.narratorId));
		expect(await resolveNarratorCwd(f.narratorId)).toBe(f.repo);
		const tree = await worktreeTreeSnapshot.capture(f.repo);
		expect((await revertWorkspaceToTree(f.narratorId, tree)).failures[0]?.message).toContain(
			"legacy_unverified",
		);
	});
});
