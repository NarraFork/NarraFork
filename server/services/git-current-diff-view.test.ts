import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import {
	fileAttributions,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	users,
} from "../db/schema";
import * as workerRead from "../db/worker-read";
import { localBackend } from "../lib/agent/execution/local-backend";
import { editTool } from "../lib/agent/tools/edit";
import { writeTool } from "../lib/agent/tools/write";
import type { ToolContext } from "../lib/agent/types";
import type { SessionPayload } from "../lib/auth";
import { generateId } from "../lib/id";
import { getNarraforkHome } from "../lib/narrafork-home";
import { safeSpawn } from "../lib/spawn";
import { narratorGitRoutes } from "../routes/git";
import { recordAttribution } from "./file-attribution-service";
import { FileChangeBlobStore } from "./file-change-blob-store";
import { fileChangeLocalIo } from "./file-change-local-io";
import { LocalFileChangeRuntime, withLocalFileChangeRuntime } from "./file-change-runtime";
import { gitCurrentBaselineReader } from "./git-current-baseline";
import { getGitCurrentDiffView } from "./git-current-diff-view";
import { gitService } from "./git-service";
import { getWorkspaceModificationView } from "./workspace-modification-view";

let root: string;
let workspace: string;
let runtime: LocalFileChangeRuntime;
let narratorId: string;
let userId: string;
const initial = "first: initial\nkeep: middle\nlast: initial\n";
const originalSnapshot = gitCurrentBaselineReader.snapshot;
const unknownHistory = {
	status: "unknown",
	actor: null,
	effectId: null,
	reason: "history_incomplete",
	historyComplete: false,
	continuity: "unverified",
};

beforeAll(() => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	runtime = new LocalFileChangeRuntime({
		db,
		privateRoot: getNarraforkHome(),
		blobStoreOptions: { minimumFreeBytes: 0 },
	});
});
beforeEach(async () => {
	root = await mkdtemp(join(await realpath(tmpdir()), "nf-current-diff-"));
	workspace = join(root, "workspace");
	await mkdir(workspace);
	await git("init", "--initial-branch=main");
	await writeFile(join(workspace, "a.txt"), initial);
	await git("add", "a.txt");
	await git("commit", "-m", "baseline");
	narratorId = generateId();
	userId = generateId();
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: narratorId, title: "Actual AI", cwd: workspace, createdAt: now, updatedAt: now });
	await db.insert(users).values({
		id: userId,
		username: `human-${userId}`,
		passwordHash: "fixture-only",
		createdAt: now,
	});
});
afterEach(async () => {
	mock.restore();
	gitCurrentBaselineReader.snapshot = originalSnapshot;
	await rm(root, { recursive: true, force: true });
});
afterAll(() => {
	gitCurrentBaselineReader.snapshot = originalSnapshot;
});

async function git(...args: string[]): Promise<string> {
	const result = await safeSpawn({
		cmd: [
			"git",
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"-c",
			"core.autocrlf=false",
			...args,
		],
		cwd: workspace,
		timeout: 3000,
		maxOutputBytes: 64 * 1024,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}
async function context(
	tool: "Write" | "Edit",
	path: string,
	cwd = workspace,
): Promise<ToolContext> {
	const identity = await localBackend.resolvePathIdentity(path);
	const toolCallId = generateId();
	const messageId = generateId();
	const toolUseId = generateId();
	const now = new Date().toISOString();
	await db
		.insert(narratorMessages)
		.values({ id: messageId, narratorId, role: "assistant", contentJson: [], createdAt: now });
	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		messageId,
		narratorId,
		toolUseId,
		toolName: tool,
		status: "running",
		executionIdentityVersion: 1,
		executionAttempt: 1,
		executionStartedAt: now,
		executionDeviceId: "local",
		executionCwd: cwd,
		executionPathFlavor: localBackend.pathFlavor,
		resolvedFilePath: identity.lexicalPath,
		canonicalFilePath: identity.canonicalPath,
		runtimeGeneration: 0,
		createdAt: now,
	});
	return {
		narratorId,
		cwd,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: toolUseId,
		toolCallBinding: { toolCallId, attempt: 1 },
		executionTarget: {
			deviceId: "local",
			backendKind: "local",
			cwd,
			pathFlavor: localBackend.pathFlavor,
			lexicalPath: identity.lexicalPath,
			canonicalPath: identity.canonicalPath,
			runtimeGeneration: 0,
			selectionSource: "local_default",
		},
		resolveBackend: () => localBackend,
		requestPermission: async () => ({ behavior: "allow" }),
	};
}
async function aiWrite(content: string, path = join(workspace, "a.txt"), cwd = workspace) {
	const ctx = await context("Write", path, cwd);
	const result = await withLocalFileChangeRuntime(runtime, () =>
		writeTool.execute({ file_path: path, content }, ctx),
	);
	expect(result.isError).not.toBe(true);
	expect(result.metadata).toMatchObject({ diskOutcome: "applied", historyStatus: "disabled" });
	expect(result.metadata?.fileChangeEvidence).toMatchObject({
		version: 3,
		grade: "unknown",
		settlement: "settled",
		outcome: "unknown",
	});
	return result;
}
async function human(content: string) {
	const path = join(workspace, "a.txt");
	return runtime.executeEditor({
		requestId: generateId(),
		userId,
		narratorId,
		cwd: workspace,
		lexicalPath: path,
		canonicalPath: await realpath(path),
		signal: new AbortController().signal,
		input: { content },
		authorize: async () => {},
		construct: () => ({
			nextBytes: new TextEncoder().encode(content),
			result: true,
			lineStats: null,
		}),
	});
}
async function view() {
	return getGitCurrentDiffView(workspace, { filePaths: ["a.txt"] });
}

async function retainedRawFixture() {
	const result = await aiWrite("retained bytes\n");
	const evidence = result.metadata?.fileChangeEvidence as { effectId?: string } | undefined;
	const effectId = evidence?.effectId;
	if (!effectId) throw new Error("missing fixture effect");
	const effect = await db
		.select()
		.from(fileChangeEffects)
		.where(eq(fileChangeEffects.id, effectId))
		.get();
	if (!effect) throw new Error("missing fixture effect row");
	// Model pre-policy data explicitly: new local writes intentionally retain no raw content.
	const { store } = await runtime.initialize();
	const bytes = new TextEncoder().encode("retained bytes\n");
	const blob = await store.putBytes(bytes, { expectedSize: bytes.byteLength });
	const state = { kind: "regular" as const, blob, mode: 0o644 };
	await db
		.update(fileChangeEffects)
		.set({
			beforeStateJson: { kind: "absent" },
			intendedAfterStateJson: state,
			observedAfterStateJson: state,
			observedAfterBlobDigest: blob.digest,
			attributionGrade: "measured",
			executionConfirmed: true,
			outcome: "changed",
		})
		.where(eq(fileChangeEffects.id, effectId));
	await db
		.update(fileChangeOperations)
		.set({ coverage: "complete" })
		.where(eq(fileChangeOperations.id, effect.operationId));
	await db
		.update(fileAttributions)
		.set({ attributionGrade: "measured" })
		.where(eq(fileAttributions.effectId, effectId));
	return { effect, blob };
}

describe("local current Git targets with disabled history", () => {
	test("clean targets retain a complete live baseline", async () => {
		const current = await view();
		expect(current).toMatchObject({ baselineStatus: "stable", clean: true, complete: true });
		for (const target of [current.byFile[0]?.index, current.byFile[0]?.worktree])
			expect(target).toMatchObject({
				status: "clean",
				reason: null,
				actor: null,
				historyComplete: true,
			});
	});

	test("local AI and editor writes retain current state while actor proof stays unknown", async () => {
		await aiWrite(initial.replace("first: initial", "first: AI"));
		const ai = await view();
		expect(ai).toMatchObject({ baselineStatus: "stable", clean: false, complete: false });
		expect(ai.byFile[0]?.worktree).toMatchObject(unknownHistory);
		expect(ai.byFile[0]?.index.status).toBe("clean");
		await human(
			initial.replace("first: initial", "first: AI").replace("last: initial", "last: human"),
		);
		const person = await view();
		expect(person.byFile[0]?.worktree).toMatchObject(unknownHistory);
		expect(person.version).not.toBe(ai.version);
	});

	test("retained local effects and raw objects are not read or used as current actor proof", async () => {
		await retainedRawFixture();
		const tasks = spyOn(workerRead, "readDomainTask");
		const queries = spyOn(workerRead, "readQuery");
		const firstQuery = spyOn(workerRead, "readQueryFirst").mockImplementation(async () => {
			throw new Error("optional historical metadata unavailable");
		});
		const read = spyOn(FileChangeBlobStore.prototype, "readBytes").mockImplementation(async () => {
			throw new Error("local history read");
		});
		const verify = spyOn(gitCurrentBaselineReader, "verifyBlobs").mockImplementation(async () => {
			throw new Error("local raw verification");
		});
		const snapshot = spyOn(gitCurrentBaselineReader, "snapshot");
		const current = await view();
		expect(current.baselineStatus).toBe("stable");
		expect(current.byFile[0]?.worktree).toMatchObject(unknownHistory);
		expect(snapshot).toHaveBeenCalledTimes(2);
		expect(tasks.mock.calls.some(([, task]) => task === "gitCurrentDiffEvidence")).toBe(false);
		expect(
			queries.mock.calls.some(([query]) => query.toSQL().sql.includes('"file_change_effects"')),
		).toBe(false);
		expect(firstQuery).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
	});

	test("missing retained raw files do not prevent stable current fingerprints", async () => {
		const { blob } = await retainedRawFixture();
		const path = join(
			getNarraforkHome(),
			"file-change-blobs",
			"sha256",
			blob.digest.slice(0, 2),
			blob.digest,
		);
		await rename(path, `${path}.test-held`);
		try {
			const current = await view();
			expect(current.baselineStatus).toBe("stable");
			expect(current.byFile[0]?.worktree).toMatchObject(unknownHistory);
		} finally {
			await rename(`${path}.test-held`, path);
		}
	});

	test("ordinary staged, unstaged and untracked diff content is unchanged", async () => {
		const aiText = initial.replace("first: initial", "first: staged");
		await aiWrite(aiText);
		await git("add", "a.txt");
		await writeFile(join(workspace, "a.txt"), aiText.replace("last: initial", "last: unstaged"));
		await writeFile(join(workspace, "untracked.txt"), "untracked content\n");
		const diffBefore = await gitService.getFullDiff(workspace);
		const stagedBefore = await git("diff", "--cached", "--", "a.txt");
		const unstagedBefore = await git("diff", "--", "a.txt");
		const current = await view();
		expect(current.byFile[0]?.index).toMatchObject({
			...unknownHistory,
			modeScope: "git_executable_bit",
		});
		expect(current.byFile[0]?.worktree).toMatchObject({
			...unknownHistory,
			modeScope: "filesystem",
		});
		expect(diffBefore).toContain("+first: staged");
		expect(diffBefore).toContain("+last: unstaged");
		expect(diffBefore).toContain("+untracked content");
		expect(stagedBefore).toContain("+first: staged");
		expect(unstagedBefore).toContain("+last: unstaged");
		expect(await gitService.getFullDiff(workspace)).toBe(diffBefore);
		expect(await git("diff", "--cached", "--", "a.txt")).toBe(stagedBefore);
		expect(await git("diff", "--", "a.txt")).toBe(unstagedBefore);
	});

	test("live CRLF bytes and executable mode still change the baseline version", async () => {
		const { chmod } = await import("node:fs/promises");
		const path = join(workspace, "a.txt");
		await writeFile(path, "first: human\r\nlast: human\r\n");
		const crlf = await view();
		await writeFile(path, "first: human\nlast: human\n");
		const lf = await view();
		expect(lf.version).not.toBe(crlf.version);
		await chmod(path, 0o755);
		const executable = await view();
		expect(executable.version).not.toBe(lf.version);
		expect(executable.byFile[0]?.worktree).toMatchObject(unknownHistory);
	}, 20_000);

	test("commit, discard and same-second commit+write never reuse a time boundary", async () => {
		await aiWrite("first after\n");
		const changed = await view();
		await git("add", "a.txt");
		await git("commit", "-m", "same second");
		const clean = await view();
		expect(clean).toMatchObject({ clean: true, complete: true });
		expect(clean.byFile[0]?.worktree.status).toBe("clean");
		expect(clean.version).not.toBe(changed.version);
		await aiWrite("second after\n");
		// Pin the legacy observation timestamp to the exact commit second. A time-based
		// 'since commit' filter would discard the real new write; current evidence must not.
		const commitAt = new Date(await git("show", "-s", "--format=%cI", "HEAD")).toISOString();
		await db
			.update(fileAttributions)
			.set({ changedAt: commitAt })
			.where(eq(fileAttributions.workspacePath, workspace));
		const again = await view();
		expect(again.byFile[0]?.worktree.status).toBe("matching_evidence");
		expect(again.version).not.toBe(clean.version);
		await git("restore", "--", "a.txt");
		expect((await view()).clean).toBe(true);
	});

	test("external observations cannot upgrade unknown local history to measured", async () => {
		await aiWrite("matching bytes\n");
		await recordAttribution({ workspacePath: workspace, filePath: "a.txt", action: "external" });
		expect((await view()).byFile[0]?.worktree).toMatchObject(unknownHistory);
	});

	test("recreated workspaces and remote devices retain their existing boundaries", async () => {
		await aiWrite("matching bytes\n");
		await rename(workspace, join(root, "old-workspace"));
		await mkdir(workspace);
		await git("init", "--initial-branch=main");
		await writeFile(join(workspace, "a.txt"), "matching bytes\n");
		expect((await view()).byFile[0]?.worktree).toMatchObject(unknownHistory);
		const snapshot = spyOn(gitCurrentBaselineReader, "snapshot");
		const remote = await getGitCurrentDiffView(workspace, {
			deviceId: "not-local",
			filePaths: ["a.txt"],
		});
		expect(remote.baselineStatus).toBe("unsupported");
		expect(snapshot).not.toHaveBeenCalled();
	});

	test("concurrent worktree changes still produce stale instead of mixed fingerprints", async () => {
		await aiWrite("first\n");
		let calls = 0;
		gitCurrentBaselineReader.snapshot = async (...args) => {
			const snapshot = await originalSnapshot(...args);
			if (++calls === 1) await writeFile(join(workspace, "a.txt"), "concurrent\n");
			return snapshot;
		};
		const current = await view();
		expect(current.baselineStatus).toBe("stale");
		expect(current.byFile[0]?.worktree.actor).toBeNull();
	});

	test("physical index changes invalidate the view while legacy scope revisions do not", async () => {
		await aiWrite("initial evidence\n");
		for (const change of ["index", "scope"] as const) {
			let calls = 0;
			gitCurrentBaselineReader.snapshot = async (...args) => {
				if (++calls === 2) {
					if (change === "index") await git("add", "a.txt");
					else {
						const scope = await db
							.select()
							.from(fileChangeScopes)
							.where(eq(fileChangeScopes.canonicalRoot, workspace))
							.get();
						if (!scope) throw new Error("scope missing");
						await db
							.update(fileChangeScopes)
							.set({ revision: scope.revision + 1 })
							.where(eq(fileChangeScopes.id, scope.id));
					}
				}
				return originalSnapshot(...args);
			};
			expect((await view()).baselineStatus).toBe(change === "index" ? "stale" : "stable");
			gitCurrentBaselineReader.snapshot = originalSnapshot;
		}
	});

	test.skipIf(process.platform === "win32")(
		"canonical symlink cwd and literal backslash paths retain current identity",
		async () => {
			const alias = join(root, "alias");
			await symlink(workspace, alias);
			const name = "literal\\name.txt";
			await aiWrite("backslash bytes\n", join(alias, name), alias);
			const baseline = await originalSnapshot(
				alias,
				[name],
				getNarraforkHome(),
				AbortSignal.timeout(5000),
			);
			expect(baseline.canonicalRoot).toBe(workspace);
			expect(baseline.files[0]?.canonicalPath).toBe(join(workspace, name));
			expect(baseline.files[0]?.worktreeState.kind).toBe("regular");
			const current = await getGitCurrentDiffView(alias, { filePaths: [name] });
			expect(current.byFile[0]?.filePath).toBe(name);
			expect(current.byFile[0]?.worktree).toMatchObject(unknownHistory);
			expect(await readFile(join(workspace, name), "utf8")).toBe("backslash bytes\n");
		},
	);

	test("aborted requests keep explicit cancelled status", async () => {
		const current = await getGitCurrentDiffView(workspace, {
			filePaths: ["a.txt"],
			signal: AbortSignal.abort(),
		});
		expect(current.byFile[0]?.worktree.reason).toBe("cancelled");
	});

	test("a pending write keeps the indexed baseline and leaves history unknown", async () => {
		await aiWrite("previous bytes\n");
		await git("add", "a.txt");
		let release!: () => void;
		let applying!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			applying = resolve;
		});
		const pendingRuntime = new LocalFileChangeRuntime({
			db,
			privateRoot: getNarraforkHome(),
			io: {
				...fileChangeLocalIo,
				apply: async (input) => {
					applying();
					await gate;
					return fileChangeLocalIo.apply(input);
				},
			},
		});
		const path = join(workspace, "a.txt");
		const ctx = await context("Write", path);
		const pending = withLocalFileChangeRuntime(pendingRuntime, () =>
			writeTool.execute({ file_path: path, content: "pending after\n" }, ctx),
		);
		try {
			await entered;
			const current = await view();
			expect(current.baselineStatus).toBe("stable");
			expect(current.byFile[0]?.index).toMatchObject(unknownHistory);
		} finally {
			release();
			await pending;
		}
	});

	test("API preserves history paging separately from unknown current actor proof", async () => {
		await aiWrite("api first\n");
		await human("api human\n");
		const path = join(workspace, "a.txt");
		const ctx = await context("Edit", path);
		const edited = await withLocalFileChangeRuntime(runtime, () =>
			editTool.execute({ file_path: path, old_string: "human", new_string: "last" }, ctx),
		);
		expect(edited.isError).not.toBe(true);
		await db
			.update(fileAttributions)
			.set({ changedAt: "2026-01-01T00:00:00.000Z" })
			.where(eq(fileAttributions.workspacePath, workspace));
		const projectId = generateId();
		const sessionId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: projectId,
			name: "current api",
			gitPath: workspace,
			ownerUserId: userId,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(narrators).values({
			id: sessionId,
			title: "current api",
			cwd: workspace,
			contextProjectId: projectId,
			ownerUserId: userId,
			traits: ["standalone"],
			createdAt: now,
			updatedAt: now,
		});
		const app = new Hono<{ Variables: { user: SessionPayload } }>();
		app.use("*", async (c, next) => {
			c.set("user", { sub: userId, role: "admin", iat: 0, exp: 2_147_483_647 });
			await next();
		});
		app.route("/narrators", narratorGitRoutes);
		const route = `http://localhost/narrators/${sessionId}/git/modifications`;
		const response = await app.request(`${route}?scope=uncommitted&projection=byFile`);
		expect(response.status).toBe(200);
		const combined = await response.json();
		expect(combined.source).toBe("history");
		expect(combined.currentDiff.source).toBe("current_diff");
		expect(combined.currentDiff.byFile[0].worktree).toMatchObject(unknownHistory);
		const seen = new Set<string>();
		let cursor: { changedAt: string; rowId: string } | null = null;
		for (let page = 0; page < 3; page++) {
			const params = new URLSearchParams({ limit: "1" });
			if (cursor) {
				params.set("cursorAt", cursor.changedAt);
				params.set("cursorRowId", cursor.rowId);
			}
			const pageResponse = await app.request(`${route}?${params}`);
			expect(pageResponse.status).toBe(200);
			const body = await pageResponse.json();
			expect(body.currentDiff).toBeUndefined();
			expect(body.timeline).toHaveLength(1);
			expect(seen.has(body.timeline[0].id)).toBe(false);
			seen.add(body.timeline[0].id);
			cursor = body.nextCursor;
		}
		expect(seen.size).toBe(3);
		expect(cursor).toBeNull();
		for (const rowId of ["0", "-1", "1.5", "business-id", "9007199254740992"])
			await expect(
				getWorkspaceModificationView(workspace, {
					cursor: { changedAt: "2026-01-01T00:00:00.000Z", rowId },
				}),
			).rejects.toThrow("Invalid historical row cursor");
		expect((await view()).byFile[0]?.worktree).toMatchObject(unknownHistory);
	});
});
