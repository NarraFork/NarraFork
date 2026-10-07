import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { chapters, narrators, projects } from "../../db/schema";
import { generateId } from "../../lib/id";

const guard = await import("../worktree-lifecycle-guard");
mock.module("../worktree-lifecycle-guard", () => ({
	...guard,
	// Resource-retirement authority has separate native integration coverage.
	// This fixture exercises real DB CAS and canonical local workspace preparation.
	withLegacyRetirement: async (_ids: string[], _operation: string, body: () => Promise<unknown>) =>
		body(),
}));
const { reviewService } = await import("../review-service");
const { gitService } = await import("../git-service");
const { worktreeTreeSnapshot } = await import("../worktree-tree-snapshot");
const workspace = await import("../workspace-context-service");
const sessionState = await import("../narrator-session-state");
let directory = "";
let projectId = "";
let sourceId = "";
let reviewId = "";
let sourceNarratorId = "";
let reviewNarratorId = "";
let sourceCwd = "";
const calls: string[] = [];

beforeEach(async () => {
	calls.length = 0;
	directory = mkdtempSync(join(tmpdir(), "nf-review-convert-"));
	sourceCwd = join(directory, "source");
	const oldCwd = join(directory, "review");
	mkdirSync(sourceCwd);
	mkdirSync(oldCwd);
	projectId = generateId();
	sourceId = generateId();
	reviewId = generateId();
	sourceNarratorId = generateId();
	reviewNarratorId = generateId();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id: projectId,
		name: "review workspace",
		gitPath: directory,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(chapters).values([
		{
			id: sourceId,
			projectId,
			title: "source",
			branch: "main",
			baseBranch: "main",
			worktreePath: sourceCwd,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: reviewId,
			projectId,
			title: "review",
			branch: "review/main",
			baseBranch: "main",
			role: "review",
			reviewStatus: "concluded",
			reviewSourceChapterId: sourceId,
			worktreePath: oldCwd,
			createdAt: now,
			updatedAt: now,
		},
	]);
	await db.insert(narrators).values([
		{
			id: sourceNarratorId,
			chapterId: sourceId,
			type: "primary",
			variant: "primary",
			cwd: "/remote/selected",
			workspaceContext: {
				revision: 2,
				deviceId: "remote-selected",
				cwd: "/remote/selected",
				pathFlavor: "posix",
				contextKey: "remote-source",
				capabilities: { switchDirectory: true },
			},
			workspaceRevision: 2,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: reviewNarratorId,
			chapterId: reviewId,
			type: "primary",
			variant: "primary",
			cwd: oldCwd,
			workspaceRevision: 0,
			createdAt: now,
			updatedAt: now,
		},
	]);
	spyOn(gitService, "removeWorktree").mockImplementation(async () => {
		calls.push("cleanup");
	});
	spyOn(gitService, "deleteBranch").mockResolvedValue(undefined);
	spyOn(worktreeTreeSnapshot, "destroy").mockResolvedValue(true);
});

afterEach(async () => {
	mock.restore();
	sessionState.activeNarrators.delete(reviewNarratorId);
	await db.delete(narrators).where(eq(narrators.chapterId, sourceId));
	await db.delete(narrators).where(eq(narrators.chapterId, reviewId));
	await db.delete(chapters).where(eq(chapters.projectId, projectId));
	await db.delete(projects).where(eq(projects.id, projectId));
	rmSync(directory, { recursive: true, force: true });
});

test("conversion atomically binds the local source context before cleanup, not the parent's remote cwd", async () => {
	const install = workspace.installWorkspaceContext;
	spyOn(workspace, "installWorkspaceContext").mockImplementation(async (id, current) => {
		calls.push("install");
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
		expect(row).toMatchObject({
			chapterId: sourceId,
			parentNarratorId: sourceNarratorId,
			type: "subagent",
			cwd: sourceCwd,
			defaultDeviceId: null,
			workspaceRevision: 1,
			workspaceContext: JSON.parse(JSON.stringify(current)),
		});
		expect(current).toMatchObject({
			deviceId: "local",
			cwd: sourceCwd,
			contextProjectId: projectId,
			revision: 1,
		});
		expect(calls).toEqual(["install"]);
		await install(id, current);
	});
	const converted = await reviewService.convertToSubagent(reviewId);
	expect(converted?.workspaceContext?.deviceId).toBe("local");
	expect(converted?.cwd).toBe(sourceCwd);
	expect(calls).toEqual(["install", "cleanup"]);
	expect(
		(await db.query.chapters.findFirst({ where: eq(chapters.id, reviewId) }))?.reviewStatus,
	).toBe("converted");
});

test("failed install retains the committed context and old resources", async () => {
	const active = {
		alive: true,
		_loopRunning: false,
		cwd: join(directory, "review"),
		abortController: new AbortController(),
		_workspaceInstallFailed: false,
		_workspacePassInvalidated: false,
	};
	sessionState.activeNarrators.set(
		reviewNarratorId,
		active as Parameters<typeof sessionState.activeNarrators.set>[1],
	);
	spyOn(workspace, "installWorkspaceContext").mockRejectedValue(new Error("install failed"));
	await expect(reviewService.convertToSubagent(reviewId)).rejects.toMatchObject({
		code: "WORKSPACE_CONTEXT_INSTALL_FAILED",
	});
	expect(active._workspaceInstallFailed).toBe(true);
	expect(active._workspacePassInvalidated).toBe(true);
	expect(active.abortController.signal.aborted).toBe(true);
	const row = await db.query.narrators.findFirst({ where: eq(narrators.id, reviewNarratorId) });
	expect(row).toMatchObject({
		cwd: sourceCwd,
		workspaceRevision: 1,
		workspaceContext: { deviceId: "local", cwd: sourceCwd, revision: 1 },
	});
	expect(calls).toEqual([]);
	expect(
		(await db.query.chapters.findFirst({ where: eq(chapters.id, reviewId) }))?.worktreePath,
	).toBe(join(directory, "review"));
});

test("a conflicting context CAS leaves parentage and resources untouched", async () => {
	const prepare = workspace.prepareLocalWorkspaceContext;
	spyOn(workspace, "prepareLocalWorkspaceContext").mockImplementation(async (...args) => {
		const result = await prepare(...args);
		await db
			.update(narrators)
			.set({ workspaceRevision: 9 })
			.where(eq(narrators.id, reviewNarratorId));
		return result;
	});
	await expect(reviewService.convertToSubagent(reviewId)).rejects.toMatchObject({
		code: "WORKSPACE_CONTEXT_CONFLICT",
	});
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, reviewNarratorId) }))?.chapterId,
	).toBe(reviewId);
	expect(calls).toEqual([]);
});

test("a dormant source with only a remote selected cwd is never borrowed as a host path", async () => {
	await db.update(chapters).set({ worktreePath: null }).where(eq(chapters.id, sourceId));
	await expect(reviewService.convertToSubagent(reviewId)).rejects.toThrow("local source workspace");
	expect(calls).toEqual([]);
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, reviewNarratorId) }))
			?.workspaceRevision,
	).toBe(0);
});
