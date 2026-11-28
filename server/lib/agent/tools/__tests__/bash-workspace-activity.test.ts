import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { fileChangeScopes, narrators, workspaceWriteLeases } from "../../../../db/schema";
import { backgroundTaskService } from "../../../../services/background-task-service";
import { FileChangeEvidenceService } from "../../../../services/file-change-evidence";
import { withFileWrite } from "../../../../services/file-write-queue";
import * as capture from "../../../../services/narrator-tree-snapshot-hooks";
import { worktreeTreeSnapshot } from "../../../../services/worktree-tree-snapshot";
import { generateId } from "../../../id";
import { settings } from "../../../settings";
import { localBackend } from "../../execution/local-backend";
import type { ToolContext } from "../../types";
import { bashTool } from "../bash";

let root: string;
let ctx: ToolContext;
beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	root = await mkdtemp(join(await realpath(tmpdir()), "bash-file-queue-"));
	const narratorId = generateId();
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({ id: narratorId, cwd: root, title: "Bash fixture", createdAt: now, updatedAt: now })
		.run();
	ctx = {
		narratorId,
		cwd: root,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: generateId(),
		resolveBackend: () => localBackend,
		requestPermission: async () => ({ behavior: "allow" }),
	};
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	db.delete(narrators).where(eq(narrators.id, ctx.narratorId)).run();
});

function command(source: string): string {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

test("Bash runs while an ordinary single-file writer is held", async () => {
	const path = join(root, "target.txt");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const held = withFileWrite(
		{
			deviceId: "local",
			pathFlavor: localBackend.pathFlavor as "posix" | "windows",
			canonicalPath: path,
		},
		async () => {
			entered.resolve();
			await release.promise;
		},
	);
	try {
		await entered.promise;
		const result = await bashTool.execute(
			{
				command: command("await Bun.write('target.txt', 'bash'); process.stdout.write('finished')"),
				timeout: 5000,
			},
			ctx,
		);
		expect(result.isError).not.toBe(true);
		expect(result.output).toContain("finished");
		expect(await readFile(path, "utf8")).toBe("bash");
	} finally {
		release.resolve();
		await held;
	}
});

test("archived quarantine and owner-unknown metadata cannot gate Bash", async () => {
	const evidence = new FileChangeEvidenceService(db);
	const scope = evidence.prepareScope({
		sourceInstanceId: generateId(),
		deviceId: "local",
		workspaceInstanceId: generateId(),
		canonicalRoot: root,
		pathFlavor: localBackend.pathFlavor as "posix" | "windows",
	});
	const leaseId = generateId();
	const now = new Date().toISOString();
	db.insert(workspaceWriteLeases)
		.values({
			leaseId,
			scopeId: scope.id,
			deviceId: "local",
			ownerEpoch: "old-unknown-owner",
			runtimeEpoch: "old-runtime",
			runtimeGeneration: 0,
			fencingToken: 1,
			scopeRevision: 1,
			pathFlavor: localBackend.pathFlavor as "posix" | "windows",
			status: "quarantined",
			rangesJson: { version: 1, ranges: [{ kind: "subtree", canonicalPath: root }] },
			mutationManifestJson: {
				version: 1,
				mutations: [{ mutationId: "old-mutation", outcome: "pending" }],
			},
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.update(fileChangeScopes)
		.set({
			status: "needs_verification",
			activeLeaseId: leaseId,
			activeLeaseEpoch: "old-unknown-owner",
			activeMutationCount: 1,
		})
		.where(eq(fileChangeScopes.id, scope.id))
		.run();
	const result = await bashTool.execute(
		{ command: command("process.stdout.write('available')"), timeout: 5000 },
		ctx,
	);
	expect(result.isError).not.toBe(true);
	expect(result.output).toContain("available");
	expect(
		String(
			db.select().from(fileChangeScopes).where(eq(fileChangeScopes.id, scope.id)).get()?.status,
		),
	).toBe("needs_verification");
	expect(
		db.select().from(workspaceWriteLeases).where(eq(workspaceWriteLeases.leaseId, leaseId)).get()
			?.status,
	).toBe("quarantined");
});

test("snapshot observation failure leaves the command result intact", async () => {
	const snapshot = spyOn(capture, "beginBashCaptureWindow").mockImplementation(() => {
		throw new Error("history unavailable");
	});
	try {
		const result = await bashTool.execute(
			{ command: command("process.stdout.write('command succeeded')"), timeout: 5000 },
			ctx,
		);
		expect(result.isError).not.toBe(true);
		expect(result.output).toContain("command succeeded");
		expect(snapshot).not.toHaveBeenCalled();
	} finally {
		snapshot.mockRestore();
	}
});

for (const background of [false, true]) {
	test(`local ${background ? "background" : "foreground"} Bash never enters capture with the legacy setting enabled`, async () => {
		const previous = settings.workspace.treeSnapshotsEnabled;
		settings.workspace.treeSnapshotsEnabled = true;
		const window = spyOn(capture, "beginBashCaptureWindow");
		const hot = spyOn(worktreeTreeSnapshot, "tryCaptureHot");
		const tree = spyOn(worktreeTreeSnapshot, "capture");
		try {
			const result = await bashTool.execute(
				{
					command: command("process.stdout.write('completed')"),
					timeout: 5000,
					run_in_background: background,
				},
				ctx,
			);
			expect(result.isError).not.toBe(true);
			if (background)
				await backgroundTaskService.drainBashCollectors({ deadlineAt: Date.now() + 5000 });
			await new Promise<void>((done) => setImmediate(done));
			expect(window).not.toHaveBeenCalled();
			expect(hot).not.toHaveBeenCalled();
			expect(tree).not.toHaveBeenCalled();
		} finally {
			window.mockRestore();
			hot.mockRestore();
			tree.mockRestore();
			settings.workspace.treeSnapshotsEnabled = previous;
		}
	});
}

test("Bash still rejects a changed frozen execution target", async () => {
	ctx.executionTarget = {
		deviceId: "local",
		backendKind: "local",
		cwd: root,
		pathFlavor: localBackend.pathFlavor,
		runtimeGeneration: 99,
		selectionSource: "local_default",
	};
	const result = await bashTool.execute(
		{ command: command("process.stdout.write('unexpected')"), timeout: 5000 },
		ctx,
	);
	expect(result.isError).toBe(true);
	expect(result.output).toContain("frozen backend/cwd");
});
