import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import {
	chapters,
	fileAttributions,
	fileChangeEffects,
	fileChangeScopes,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	users,
} from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { editTool } from "../lib/agent/tools/edit";
import { writeTool } from "../lib/agent/tools/write";
import type { ToolContext } from "../lib/agent/types";
import type { JwtPayload } from "../lib/auth";
import { generateId } from "../lib/id";
import { getNarraforkHome } from "../lib/narrafork-home";
import { safeSpawn } from "../lib/spawn";
import { gitRoutes } from "../routes/git";
import { recordAttribution } from "./file-attribution-service";
import { fileChangeLocalIo } from "./file-change-local-io";
import { LocalFileChangeRuntime, withLocalFileChangeRuntime } from "./file-change-runtime";
import { gitCurrentBaselineReader } from "./git-current-baseline";
import { getGitCurrentDiffView } from "./git-current-diff-view";
import { getWorkspaceModificationView } from "./workspace-modification-view";
import { createWorkspaceWriteCoordinatorState } from "./workspace-write-coordinator";

let root: string;
let workspace: string;
let runtime: LocalFileChangeRuntime;
let narratorId: string;
let userId: string;
const initial = "first: initial\nkeep: middle\nlast: initial\n";
const originalSnapshot = gitCurrentBaselineReader.snapshot;

beforeAll(() => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	runtime = new LocalFileChangeRuntime({
		db,
		privateRoot: getNarraforkHome(),
		coordinatorState: createWorkspaceWriteCoordinatorState(),
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
	expect(result.metadata?.fileChangeEvidence).toMatchObject({
		version: 2,
		grade: "measured",
		settlement: "settled",
		outcome: "changed",
	});
	return result;
}
async function aiEdit(old: string, next: string) {
	const path = join(workspace, "a.txt");
	const ctx = await context("Edit", path);
	const result = await withLocalFileChangeRuntime(runtime, () =>
		editTool.execute({ file_path: path, old_string: old, new_string: next }, ctx),
	);
	expect(result.isError).not.toBe(true);
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

describe("current Git targets matched against actual v2 writes", () => {
	test("real AI Write and editor another hunk name only the latest matching after, not all contributors", async () => {
		await aiWrite(initial.replace("first: initial", "first: AI"));
		const ai = await view();
		expect(ai.baselineStatus).toBe("stable");
		expect(ai.byFile[0]?.worktree).toMatchObject({
			status: "matching_evidence",
			actor: { narratorId, kind: "primary" },
			continuity: "unverified",
		});
		expect(ai.byFile[0]?.index.status).toBe("clean");
		await human(
			initial.replace("first: initial", "first: AI").replace("last: initial", "last: human"),
		);
		const person = await view();
		expect(person.byFile[0]?.worktree).toMatchObject({
			status: "matching_evidence",
			actor: { userId, narratorId: null, kind: "human" },
		});
		expect(person.version).not.toBe(ai.version);
		expect(person.byFile[0]?.worktree.actor?.title).toBe(`human-${userId}`);
	});

	test("raw CRLF bytes and executable mode are checked independently of Git text normalization", async () => {
		const file = join(workspace, "a.txt");
		const fs = await import("node:fs/promises");
		await fs.chmod(file, 0o755);
		await human("first: human\r\nlast: human\r\n");
		const saved = await view();
		expect(saved.byFile[0]?.worktree).toMatchObject({
			status: "matching_evidence",
			actor: { kind: "human" },
		});
		await writeFile(file, "first: human\nlast: human\n");
		expect((await view()).byFile[0]?.worktree.reason).toBe("state_mismatch");
		await writeFile(file, "first: human\r\nlast: human\r\n");
		await fs.chmod(file, 0o644);
		expect((await view()).byFile[0]?.worktree.reason).toBe("state_mismatch");
	});

	test("complete overwrite replaces latest evidence, and external mismatches are unknown", async () => {
		await aiEdit("first: initial", "first: AI");
		await human("human completely replaced it\n");
		expect((await view()).byFile[0]?.worktree.actor?.kind).toBe("human");
		await writeFile(join(workspace, "a.txt"), "outside platform\n");
		expect((await view()).byFile[0]?.worktree).toMatchObject({
			status: "unknown",
			reason: "state_mismatch",
			actor: null,
		});
	});

	test("index and worktree bind different actual states, including partially staged content", async () => {
		const aiText = initial.replace("first: initial", "first: AI");
		await aiWrite(aiText);
		await git("add", "a.txt");
		await human(aiText.replace("last: initial", "last: human"));
		const split = await view();
		expect(split.byFile[0]?.index).toMatchObject({
			status: "matching_evidence",
			actor: { kind: "primary", narratorId },
			modeScope: "git_executable_bit",
		});
		expect(split.byFile[0]?.worktree).toMatchObject({
			status: "matching_evidence",
			actor: { kind: "human", userId },
			modeScope: "filesystem",
		});
		// Stage an intermediate state that was never a complete recorded after.
		const patch =
			"diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n first: AI\n-keep: middle\n+keep: staged-only\n last: initial\n";
		const patchPath = join(root, "partial.patch");
		await writeFile(patchPath, patch);
		await git("apply", "--cached", patchPath);
		const partial = await view();
		expect(partial.version).not.toBe(split.version);
		expect(partial.byFile[0]?.index.status).toBe("unknown");
		expect(partial.byFile[0]?.worktree.actor?.kind).toBe("human");
	});

	test("commit, discard and same-second commit+write never reuse a time boundary", async () => {
		await aiWrite("first after\n");
		const changed = await view();
		await git("add", "a.txt");
		await git("commit", "-m", "same second");
		const clean = await view();
		expect(clean.clean).toBe(true);
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

	test("known external observations veto equal-byte matches; unobserved equal bytes do not prove continuity", async () => {
		await aiWrite("matching bytes\n");
		const before = await view();
		await writeFile(join(workspace, "a.txt"), "matching bytes\n");
		const same = await view();
		expect(same.version).not.toBe(before.version);
		expect(same.byFile[0]?.worktree.continuity).toBe("unverified");
		await recordAttribution({ workspacePath: workspace, filePath: "a.txt", action: "external" });
		expect((await view()).byFile[0]?.worktree).toMatchObject({
			status: "unknown",
			reason: "legacy_or_external",
			actor: null,
		});
	});

	test("recreated workspace at the same path and remote device never inherit local evidence", async () => {
		await aiWrite("matching bytes\n");
		expect((await view()).scope).not.toBeNull();
		await rename(workspace, join(root, "old-workspace"));
		await mkdir(workspace);
		await git("init", "--initial-branch=main");
		await writeFile(join(workspace, "a.txt"), "matching bytes\n");
		const replaced = await view();
		expect(replaced.scope).toBeNull();
		expect(replaced.byFile[0]?.worktree.reason).toBe("scope_unknown");
		const snapshot = spyOn(gitCurrentBaselineReader, "snapshot");
		const remote = await getGitCurrentDiffView(workspace, {
			deviceId: "not-local",
			filePaths: ["a.txt"],
		});
		expect(remote.baselineStatus).toBe("unsupported");
		expect(snapshot).not.toHaveBeenCalled();
		snapshot.mockRestore();
	});

	test("missing raw/receipt and over-budget file can never become a matching actor", async () => {
		await aiWrite("raw evidence\n");
		const match = (await view()).byFile[0]?.worktree.effectId;
		expect(match).not.toBeNull();
		const effect = await db
			.select()
			.from(fileChangeEffects)
			.where(eq(fileChangeEffects.id, match as string))
			.get();
		if (!effect) throw new Error("missing actual effect");
		await db
			.update(fileChangeEffects)
			.set({ executionReceiptJson: null })
			.where(eq(fileChangeEffects.id, effect.id));
		expect((await view()).byFile[0]?.worktree.status).toBe("unknown");
		await db
			.update(fileChangeEffects)
			.set({ executionReceiptJson: effect.executionReceiptJson })
			.where(eq(fileChangeEffects.id, effect.id));
		const { store } = await runtime.initialize();
		const observed = effect.observedAfterStateJson;
		if (observed.kind !== "regular") throw new Error("expected regular after");
		// Mark the exact raw object missing; metadata alone cannot satisfy the read gate.
		const catalog = await import("../db/schema");
		await db
			.update(catalog.fileChangeBlobs)
			.set({ status: "missing" })
			.where(eq(catalog.fileChangeBlobs.digest, observed.blob.digest));
		expect((await view()).byFile[0]?.worktree.status).toBe("unknown");
		await db
			.update(catalog.fileChangeBlobs)
			.set({ status: "ready" })
			.where(eq(catalog.fileChangeBlobs.digest, observed.blob.digest));
		expect(await store.readBytes(observed.blob)).toBeDefined();
		const rawPath = join(
			getNarraforkHome(),
			"file-change-blobs",
			"sha256",
			observed.blob.digest.slice(0, 2),
			observed.blob.digest,
		);
		await rename(rawPath, `${rawPath}.test-held`);
		try {
			expect((await view()).byFile[0]?.worktree.reason).toBe("missing_raw");
		} finally {
			await rename(`${rawPath}.test-held`, rawPath);
		}
		const file = await open(join(workspace, "a.txt"), "r+");
		try {
			await file.truncate(5 * 1024 * 1024);
		} finally {
			await file.close();
		}
		expect((await view()).byFile[0]?.worktree.reason).toBe("budget_exceeded");
	});

	test("an effect beyond the bounded sample remains unknown rather than silently complete", async () => {
		for (let i = 0; i < 11; i++) await aiWrite(`version ${i}\n`);
		const current = (await view()).byFile[0]?.worktree;
		expect(current).toMatchObject({
			status: "unknown",
			reason: "history_incomplete",
			historyComplete: false,
		});
	});

	test("HEAD/index/worktree or scope changes during construction yield stale without mixed actors", async () => {
		await aiWrite("verified\n");
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

	test("canonical symlink cwd and POSIX backslash filenames retain their recorded identity", async () => {
		if (process.platform === "win32") return;
		const alias = join(root, "alias");
		await symlink(workspace, alias);
		const name = "literal\\name.txt";
		await aiWrite("backslash bytes\n", join(alias, name), alias);
		expect(await readFile(join(workspace, name), "utf8")).toBe("backslash bytes\n");
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
		expect(current.byFile[0]?.worktree).toMatchObject({
			status: "matching_evidence",
			actor: { narratorId },
		});
		expect(current.byFile[0]?.filePath).toBe(name);
		const history = await getWorkspaceModificationView(alias, { filePaths: [name] });
		expect(history.byFile[0]?.lastActor.narratorId).toBe(narratorId);
		expect(history.byFile[0]?.evidence).toBe("v2");
		expect(await readFile(join(workspace, name), "utf8")).toBe("backslash bytes\n");
	});

	test("real deleted human actor retains its kind and never invents a name", async () => {
		await human("human bytes\n");
		await db.delete(users).where(eq(users.id, userId));
		const current = (await view()).byFile[0]?.worktree;
		expect(current).toMatchObject({
			status: "matching_evidence",
			actor: { kind: "human", deleted: true, exists: false, title: null },
		});
	});

	test("aborted requests return explicit unknown without starting a fingerprint read", async () => {
		const signal = AbortSignal.abort();
		const current = await getGitCurrentDiffView(workspace, { filePaths: ["a.txt"], signal });
		expect(current.byFile[0]?.worktree.reason).toBe("cancelled");
	});

	test("a real applying Write never falls back to earlier measured evidence", async () => {
		await aiWrite("previous evidence\n");
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
			coordinatorState: createWorkspaceWriteCoordinatorState(),
			blobStoreOptions: { minimumFreeBytes: 0 },
			io: {
				...fileChangeLocalIo,
				apply: async (input) => {
					applying();
					await gate;
					await fileChangeLocalIo.apply(input);
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
			expect(current.byFile[0]?.index).toMatchObject({ status: "unknown", actor: null });
		} finally {
			release();
			await pending;
		}
	});

	test("a new external observation during baseline construction invalidates even equal bytes", async () => {
		await aiWrite("unchanged after\n");
		let calls = 0;
		gitCurrentBaselineReader.snapshot = async (...args) => {
			if (++calls === 2)
				await recordAttribution({
					workspacePath: workspace,
					filePath: "a.txt",
					action: "external",
				});
			return originalSnapshot(...args);
		};
		expect((await view()).baselineStatus).toBe("stale");
	});

	test("same timestamp external observation cannot be hidden by a random-ID winner", async () => {
		await aiWrite("same bytes\n");
		const projected = db
			.select()
			.from(fileAttributions)
			.where(eq(fileAttributions.workspacePath, workspace))
			.get();
		if (!projected) throw new Error("missing projection");
		await db.insert(fileAttributions).values({
			id: generateId(),
			deviceId: "local",
			workspacePath: workspace,
			filePath: "a.txt",
			action: "external",
			changedAt: projected.changedAt,
		});
		expect((await view()).byFile[0]?.worktree).toMatchObject({
			status: "unknown",
			reason: "legacy_or_external",
		});
		// Imported/backdated observation still arrived after the actual write.
		await db
			.update(fileAttributions)
			.set({ changedAt: "2020-01-01T00:00:00.000Z" })
			.where(
				and(eq(fileAttributions.workspacePath, workspace), eq(fileAttributions.action, "external")),
			);
		expect((await view()).byFile[0]?.worktree.reason).toBe("legacy_or_external");
	});

	test("repeated effect scope revisions are unknown rather than sorted by nanoid", async () => {
		await aiWrite("revision one\n");
		const first = (await view()).byFile[0]?.worktree.effectId;
		await human("revision two\n");
		const next = (await view()).byFile[0]?.worktree.effectId;
		const row = db
			.select()
			.from(fileChangeEffects)
			.where(eq(fileChangeEffects.id, first as string))
			.get();
		if (!row || !next) throw new Error("missing real effects");
		await db
			.update(fileChangeEffects)
			.set({ scopeRevision: row.scopeRevision })
			.where(eq(fileChangeEffects.id, next));
		expect((await view()).byFile[0]?.worktree).toMatchObject({
			status: "unknown",
			reason: "ambiguous_order",
		});
	});

	test("a second-pass index or scope revision change invalidates all candidate actors", async () => {
		await aiWrite("initial evidence\n");
		for (const change of ["index", "scope"] as const) {
			let calls = 0;
			gitCurrentBaselineReader.snapshot = async (...args) => {
				if (++calls === 2) {
					if (change === "index") await git("add", "a.txt");
					else {
						const scope = db
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
			expect((await view()).baselineStatus).toBe("stale");
			gitCurrentBaselineReader.snapshot = originalSnapshot;
		}
	});

	test("legacy recycled toolUseId cannot contaminate a v2 actual tool-call boundary", async () => {
		const path = join(workspace, "a.txt");
		const ctx = await context("Write", path);
		const other = generateId();
		const message = generateId();
		const now = new Date().toISOString();
		await db
			.insert(narrators)
			.values({ id: other, title: "Different session", createdAt: now, updatedAt: now });
		await db.insert(narratorMessages).values({
			id: message,
			narratorId: other,
			role: "assistant",
			contentJson: [],
			createdAt: now,
		});
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId: other,
			messageId: message,
			toolUseId: ctx.currentToolUseId as string,
			toolName: "Write",
			status: "success",
			treeHashAfter: "b".repeat(40),
			createdAt: now,
		});
		await db
			.update(narratorToolCalls)
			.set({ treeHashAfter: "a".repeat(40) })
			.where(eq(narratorToolCalls.id, ctx.toolCallBinding?.toolCallId as string));
		await withLocalFileChangeRuntime(runtime, () =>
			writeTool.execute({ file_path: path, content: "real linked after\n" }, ctx),
		);
		const history = await getWorkspaceModificationView(workspace);
		expect(history.timeline?.[0]?.treeHashAfter).toBe("a".repeat(40));
	});

	test("real API exposes current evidence separately and pages history without losing equal timestamps", async () => {
		await aiWrite("api first\n");
		await human("api human\n");
		await aiEdit("human", "last");
		await db
			.update(fileAttributions)
			.set({ changedAt: "2026-01-01T00:00:00.000Z" })
			.where(eq(fileAttributions.workspacePath, workspace));
		const projectId = generateId();
		const chapterId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: projectId,
			name: "current api",
			gitPath: workspace,
			ownerUserId: userId,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(chapters).values({
			id: chapterId,
			projectId,
			title: "current api",
			branch: "main",
			baseBranch: "main",
			worktreePath: workspace,
			createdAt: now,
			updatedAt: now,
		});
		const app = new Hono<{ Variables: { user: JwtPayload } }>();
		app.use("*", async (c, next) => {
			c.set("user", { sub: userId, role: "admin", iat: 0, exp: 2_147_483_647 });
			await next();
		});
		app.route("/chapters", gitRoutes);
		const route = `http://localhost/chapters/${chapterId}/git/modifications`;
		const response = await app.request(`${route}?scope=uncommitted&projection=byFile`);
		expect(response.status).toBe(200);
		const combined = await response.json();
		expect(combined.source).toBe("history");
		expect(combined.currentDiff.source).toBe("current_diff");
		expect(combined.currentDiff.byFile[0].worktree.status).toBe("matching_evidence");
		expect(combined.currentDiff.byFile[0].worktree.continuity).toBe("unverified");
		expect(
			combined.byFile[0].actors.some((actor: { kind: string }) => actor.kind === "human"),
		).toBe(true);
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
			if (body.nextCursor) {
				expect(Object.keys(body.nextCursor).sort()).toEqual(["changedAt", "rowId"]);
				expect(body.nextCursor.rowId).toMatch(/^[1-9]\d*$/);
				expect(body.nextCursor.rowId).not.toBe(body.timeline[0].id);
				if (cursor) expect(Number(body.nextCursor.rowId)).toBeLessThan(Number(cursor.rowId));
			}
			cursor = body.nextCursor;
		}
		expect(seen.size).toBe(3);
		expect(cursor).toBeNull();
		for (const rowId of ["0", "-1", "1.5", "business-id", "9007199254740992"]) {
			await expect(
				getWorkspaceModificationView(workspace, {
					cursor: { changedAt: "2026-01-01T00:00:00.000Z", rowId },
				}),
			).rejects.toThrow("Invalid historical row cursor");
		}
		// Pagination order is not execution evidence: querying history cannot change
		// the independently verified current effect or its continuity caveat.
		const currentAfterPaging = await view();
		expect(currentAfterPaging.byFile[0]?.worktree.effectId).toBe(
			combined.currentDiff.byFile[0].worktree.effectId,
		);
		expect(currentAfterPaging.byFile[0]?.worktree.continuity).toBe("unverified");
		const snapshot = spyOn(gitCurrentBaselineReader, "snapshot");
		try {
			const cancelled = await app.request(
				new Request(`${route}?scope=uncommitted`, { signal: AbortSignal.abort() }),
			);
			const body = await cancelled.json();
			expect(body.currentDiff).toMatchObject({ baselineStatus: "unavailable", byFile: [] });
			expect(body.byFile).toEqual([]);
			expect(body.timeline).toEqual([]);
			expect(snapshot).not.toHaveBeenCalled();
		} finally {
			snapshot.mockRestore();
		}
	});
});
