import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { testEnvironment } from "../../../tests/preload";
import { cleanDb } from "../../../tests/setup";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { AppError } from "../../lib/errors";
import * as identity from "../../lib/git-identity";
import * as spawn from "../../lib/spawn";

const { db, sqlite } = await import("../../db");
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
await import("../../services/narrator-service");
const staging = await import("../../services/git-staging-lists-service");
const realStagingService = staging.getGitStagingListsService;
const management = await import("../../services/git-management-service");
const realValidateGitFileTargets = management.validateGitFileTargets;
const watch = await import("../../services/git-workspace-watch");
const auth = await import("../../lib/auth");
const oauthProvider = await import("../../lib/oauth-provider");
const { authSessionStore } = await import("../../services/auth/store");
const { serialGitStaging } = await import("../../services/git-staging-observation");
let liveSession = true;
let liveRole: "admin" | "user" = "user";
const { narratorGitRoutes } = await import("../git");
const root = await realpath(
	await mkdtemp(join(testEnvironment.isolatedHome, "git-changelist-http-")),
);
const realSafeSpawn = spawn.safeSpawn;
const initialized = await spawn.safeSpawn({
	cmd: ["git", "-C", root, "init", "--quiet", "--initial-branch=main"],
	timeout: 10_000,
	maxOutputBytes: 32_768,
});
if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
const BASE = "http://localhost/api/narrators/n1/git";
const NOW = "2026-11-10T00:00:00.000Z";
const version = { expectedGeneration: 2, observationId: "observation" };
const summary = {
	capability: { supported: true },
	workspaceKey: "fixture",
	initialized: true,
	generation: 2,
	observationId: "observation",
	activeListId: "A",
	scannedAt: 100,
	state: "ready",
	lists: [],
	stats: {},
};
const result = {
	outcome: "applied",
	listId: "B",
	generation: 3,
	observationId: "observation",
	affectedListIds: ["A", "B"],
};
let calls: {
	summary: ReturnType<typeof mock>;
	files: ReturnType<typeof mock>;
	diff: ReturnType<typeof mock>;
	action: ReturnType<typeof mock>;
};
beforeEach(() => {
	liveSession = true;
	liveRole = "user";
	spyOn(auth, "verifyToken").mockImplementation(async (token) => {
		if (!liveSession) throw new auth.SessionTokenRevokedError();
		return {
			sub: token.slice(4),
			role: liveRole,
			sid: `session-${token.slice(4)}`,
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		};
	});
	cleanDb(sqlite);
	for (const user of ["reader", "outsider"])
		sqlite.run(
			"INSERT INTO users (id,username,password_hash,role,created_at) VALUES (?,?,'test-only','user',?)",
			[user, user, NOW],
		);
	sqlite.run(
		"INSERT INTO narrators (id,owner_user_id,visibility,write_audience,cwd,traits,created_at,updated_at) VALUES ('n1','reader','private','owner',?,'[\"standalone\"]',?,?)",
		[root, NOW, NOW],
	);
	spyOn(spawn, "safeSpawn").mockImplementation(async ({ cmd }) => {
		if (cmd[0] !== "git" || !cmd.includes("rev-parse")) throw new Error("Unexpected fixture IO");
		return { exitCode: 0, stdout: `true\nfalse\n${root}\n${join(root, ".git")}\n`, stderr: "" };
	});
	calls = {
		summary: mock(async () => summary),
		files: mock(async () => ({
			workspaceKey: "fixture",
			listId: "A",
			files: [],
			nextCursor: null,
			complete: true,
			snapshotVersion: "snapshot",
			generation: 2,
			observationId: "observation",
			stats: { complete: true, total: {}, directories: [] },
		})),
		diff: mock(async () => ({
			path: "file",
			diff: "published",
			truncated: false,
			units: [],
			snapshotVersion: "snapshot",
			generation: 2,
			observationId: "observation",
		})),
		action: mock(async () => result),
	};
	spyOn(staging, "getGitStagingListsService").mockImplementation(
		async () => calls as unknown as Awaited<ReturnType<typeof staging.getGitStagingListsService>>,
	);
});
afterEach(() => mock.restore());
afterAll(async () => {
	mock.module("../../db", () => realDbModule);
	await rm(root, { recursive: true, force: true });
});
function appFor(user = "reader", role: "admin" | "user" = "user", oauthScopes?: string[]) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: user, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		c.req.raw.headers.set(
			"Authorization",
			oauthScopes ? "Bearer oauth-fixture" : `Bearer nfs_${user}`,
		);
		if (oauthScopes)
			c.set("oauth", {
				tokenId: "token",
				clientId: "client",
				oauthClientId: "oauth-client",
				grantId: "grant",
				refreshFamilyId: "family",
				expiresAt: "2999-01-01T00:00:00.000Z",
				scopes: oauthScopes,
			});
		await next();
	});
	app.onError(
		(error, c) =>
			buildAppErrorResponse(error, c) ?? c.json({ error: "Internal server error" }, 500),
	);
	app.route("/api/narrators", narratorGitRoutes);
	return app;
}
async function key(app: ReturnType<typeof appFor>) {
	const response = await app.request(`${BASE}/workspace`);
	expect(response.status).toBe(200);
	return (await response.json()).workspaceKey as string;
}
const post = (app: ReturnType<typeof appFor>, value: unknown) =>
	app.request(`${BASE}/staging-lists/action`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(value),
	});

test("read APIs expose published observation and bounded source-group filters without sync", async () => {
	const app = appFor();
	const workspaceKey = await key(app);
	expect((await app.request(`${BASE}/staging-lists?workspaceKey=${workspaceKey}`)).status).toBe(
		200,
	);
	const page = await app.request(
		`${BASE}/staging-lists/A/files?workspaceKey=${workspaceKey}&limit=100&filter=MA`,
	);
	expect(page.status).toBe(200);
	expect(await page.json()).toHaveProperty("snapshotVersion", "snapshot");
	expect(calls.files).toHaveBeenCalledWith("A", {
		cursor: undefined,
		limit: 100,
		filter: ["M", "A"],
	});
	expect(
		(
			await app.request(
				`${BASE}/staging-lists/A/diff?workspaceKey=${workspaceKey}&path=deleted.txt&oldPath=old.txt`,
			)
		).status,
	).toBe(200);
	expect(calls.diff).toHaveBeenCalledWith("A", { path: "deleted.txt", oldPath: "old.txt" });
	expect(calls.action).not.toHaveBeenCalled();
});

test("all dynamic actions forward explicit source selectors and versions", async () => {
	const app = appFor();
	const workspaceKey = await key(app);
	for (const action of [
		{ action: "init" },
		{ action: "sync" },
		{ ...version, action: "create", name: "A" },
		{ ...version, action: "rename", listId: "A", name: "B" },
		{ ...version, action: "activate", listId: "B" },
		{ ...version, action: "move", fromListId: "A", toListId: "B", unitIds: ["f:unit:1"] },
		{ ...version, action: "move", fromListId: "A", toListId: "B", all: true },
		{
			...version,
			action: "move",
			fromListId: "A",
			toListId: "B",
			scope: { filter: ["M"], directory: "src" },
		},
		{ ...version, action: "delete", listId: "A" },
		{ ...version, action: "recover", operationId: "operation" },
	]) {
		expect((await post(app, { workspaceKey, ...action })).status).toBe(200);
		expect(calls.action).toHaveBeenLastCalledWith(action);
	}
});

test("HTTP moves reject empty scopes before dispatch instead of implicitly selecting all files", async () => {
	const app = appFor();
	const workspaceKey = await key(app);
	for (const scope of [{}, { filter: [] }]) {
		const response = await post(app, {
			workspaceKey,
			...version,
			action: "move",
			fromListId: "A",
			toListId: "B",
			scope,
		});
		expect(response.status).toBe(400);
	}
	expect(calls.action).not.toHaveBeenCalled();
});

test("HTTP returns its covered target without waiting for a newer watch tail", async () => {
	const app = appFor();
	const workspaceKey = await key(app);
	const observation = {
		instanceId: "instance",
		stateSequence: 4,
		epoch: 3,
		completedEpoch: 2,
		round: 1,
		status: "pending",
		generation: 3,
		observationId: "observation",
	};
	calls.action.mockResolvedValue({ ...result, observation, observationTargetEpoch: 2 });
	const settle = spyOn(watch, "settleGitStagingWatch").mockImplementation(async () => {
		throw new Error("unrelated newer round");
	});
	const response = await post(app, { workspaceKey, action: "sync" });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ observation, observationTargetEpoch: 2 });
	expect(settle).not.toHaveBeenCalled();
});

async function queuedCredentialWrite(app: ReturnType<typeof appFor>, revoke: () => void) {
	const workspaceKey = await key(app);
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const predecessor = serialGitStaging(root, async () => held);
	let queued = false;
	let writes = 0;
	spyOn(staging, "getGitStagingListsService").mockImplementation(
		async (target, actorId, signal, grantId) => {
			const service = staging.createGitStagingListsService(
				{
					rootPath: root,
					workspaceKey,
					signal,
					authorizationKey: JSON.stringify([actorId, grantId]),
					beforeWrite: async () => {
						if (!target.beforeWrite) throw new Error("Missing fresh write guard");
						await target.beforeWrite();
					},
					authorizePaths: async () => {},
				},
				{
					execute: async <T>(
						request: import("../../services/git-staging-worker").GitStagingWork,
					) => {
						if (request.method === "actionPaths") return [] as T;
						if (request.method === "baseline") return summary as T;
						writes++;
						return result as T;
					},
				},
			);
			return {
				...service,
				action: async (action) => {
					queued = true;
					return service.action(action);
				},
			};
		},
	);
	const response = Promise.resolve(post(app, { workspaceKey, action: "sync" }));
	try {
		const deadline = Date.now() + 5000;
		while (!queued && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
		expect(queued).toBe(true);
		revoke();
		release();
		return { response: await response, writes };
	} finally {
		release();
		await predecessor;
	}
}

test("queued ChangeList observations revalidate revoked session credentials before any Worker write", async () => {
	const { response, writes } = await queuedCredentialWrite(appFor(), () => {
		liveSession = false;
	});
	expect(response.status).toBe(401);
	expect(writes).toBe(0);
});

test("queued ChangeList observations apply the live downgraded role instead of cached admin access", async () => {
	const { response, writes } = await queuedCredentialWrite(appFor("outsider", "admin"), () => {
		liveRole = "user";
	});
	expect(response.status).toBe(404);
	expect(writes).toBe(0);
});

for (const revoke of ["token", "scopes"] as const)
	test(`queued OAuth observation revalidates live ${revoke} authority`, async () => {
		let revoked = false;
		spyOn(oauthProvider, "validateAccessToken").mockImplementation(async () =>
			revoked && revoke === "token"
				? null
				: {
						tokenId: "token",
						userId: "reader",
						clientId: "client",
						oauthClientId: "oauth-client",
						grantId: "grant",
						refreshFamilyId: "family",
						expiresAt: "2999-01-01T00:00:00.000Z",
						scopes: revoked ? [] : ["narrators:write"],
					},
		);
		spyOn(authSessionStore, "findSessionState").mockResolvedValue({
			id: "reader",
			role: "user",
			tokenVersion: 0,
		});
		const { response, writes } = await queuedCredentialWrite(
			appFor("reader", "user", ["narrators:write"]),
			() => {
				revoked = true;
			},
		);
		expect(response.status).toBe(revoke === "token" ? 401 : 403);
		expect(writes).toBe(0);
	});

test("permissions and worktree identity precede reads and writes", async () => {
	const app = appFor();
	const workspaceKey = await key(app);
	expect((await app.request(`${BASE}/staging-lists?workspaceKey=wrong`)).status).toBe(409);
	expect(
		(await appFor("outsider").request(`${BASE}/staging-lists?workspaceKey=${workspaceKey}`)).status,
	).toBe(404);
	expect(
		(await post(appFor("outsider"), { workspaceKey, ...version, action: "delete", listId: "A" }))
			.status,
	).toBe(404);
	expect(
		(await post(app, { workspaceKey: "wrong", ...version, action: "delete", listId: "A" })).status,
	).toBe(409);
	expect(calls.summary).not.toHaveBeenCalled();
	expect(calls.action).not.toHaveBeenCalled();
});

test("read-only users cannot mutate the ownership database", async () => {
	sqlite.run(
		"UPDATE narrators SET owner_user_id = 'outsider', visibility = 'public' WHERE id = 'n1'",
	);
	const app = appFor();
	const workspaceKey = await key(app);
	expect((await app.request(`${BASE}/staging-lists?workspaceKey=${workspaceKey}`)).status).toBe(
		200,
	);
	for (const action of [
		{ action: "init" },
		{ action: "sync" },
		{ ...version, action: "delete", listId: "A" },
	])
		expect([403, 404]).toContain((await post(app, { workspaceKey, ...action })).status);
	expect(calls.action).not.toHaveBeenCalled();
});

test("commit attribution comes from the authenticated user and invalidates native facts only for a real commit", async () => {
	const app = appFor();
	const workspaceKey = await key(app);
	spyOn(identity, "resolveUserGitIdentityEnv").mockResolvedValue({
		GIT_AUTHOR_NAME: "Reader",
		GIT_AUTHOR_EMAIL: "reader@example.test",
	});
	const invalidate = spyOn(management, "invalidateGitWorkspace");
	const action = { ...version, action: "commit", listId: "A", message: "Commit" };
	expect((await post(app, { workspaceKey, ...action, identity: { name: "forged" } })).status).toBe(
		400,
	);
	expect((await post(app, { workspaceKey, ...action })).status).toBe(200);
	expect(calls.action).toHaveBeenLastCalledWith({
		...action,
		identity: { name: "Reader", email: "reader@example.test" },
	});
	expect(invalidate).not.toHaveBeenCalled();
	calls.action.mockResolvedValueOnce({
		...result,
		outcome: "partial",
		operationId: "op",
		commitOid: "committed",
		reason: "recovery required",
	});
	expect((await post(app, { workspaceKey, ...action })).status).toBe(200);
	expect(invalidate).toHaveBeenCalledTimes(1);
});

test("obsolete actions, missing CAS, unsafe paths and payload limits fail before service access", async () => {
	const app = appFor();
	const workspaceKey = await key(app);
	for (const action of ["stage", "unstage", "retrySave"])
		expect(
			(await post(app, { workspaceKey, ...version, action, listId: "A", paths: ["f"] })).status,
		).toBe(400);
	expect((await post(app, { workspaceKey, action: "create", name: "A" })).status).toBe(400);
	for (const paths of [["../outside"], [".git/config"], []])
		expect(
			(
				await post(app, {
					workspaceKey,
					...version,
					action: "move",
					fromListId: "A",
					toListId: "B",
					paths,
				})
			).status,
		).toBe(400);
	expect(
		(await app.request(`${BASE}/staging-lists/A/files?workspaceKey=${workspaceKey}&limit=201`))
			.status,
	).toBe(400);
	expect(
		(await app.request(`${BASE}/staging-lists/A/diff?workspaceKey=${workspaceKey}`)).status,
	).toBe(400);
	expect(
		(await post(app, { workspaceKey, ...version, action: "create", name: "x".repeat(1024 * 1024) }))
			.status,
	).toBe(413);
	expect(calls.action).not.toHaveBeenCalled();
});

test("real HTTP unit selection validates complete resolved paths and preserves ownership on denial", async () => {
	spyOn(spawn, "safeSpawn").mockImplementation(realSafeSpawn);
	spyOn(staging, "getGitStagingListsService").mockImplementation(realStagingService);
	await writeFile(join(root, "visible.txt"), "visible\n");
	await writeFile(join(root, "hidden.txt"), "hidden\n");
	const app = appFor();
	const workspaceKey = await key(app);
	const invoke = async (action: unknown) => {
		const response = await post(app, { workspaceKey, ...(action as object) });
		if (response.status !== 200) throw new Error(JSON.stringify(await response.json()));
		return response.json();
	};
	await invoke({ action: "init" });
	const getSummary = async () =>
		(await app.request(`${BASE}/staging-lists?workspaceKey=${workspaceKey}`)).json();
	let current = await getSummary();
	const fromListId = current.activeListId;
	const created = await invoke({
		action: "create",
		name: "B",
		expectedGeneration: current.generation,
		observationId: current.observationId,
	});
	current = await getSummary();
	const diffResponse = await app.request(
		`${BASE}/staging-lists/${fromListId}/diff?workspaceKey=${workspaceKey}&path=hidden.txt`,
	);
	expect(diffResponse.status).toBe(200);
	const diff = await diffResponse.json();
	const validate = spyOn(management, "validateGitFileTargets").mockImplementation(
		async (_target, paths) => {
			if (paths.includes("hidden.txt")) throw new AppError("Hidden path denied", 403, "FORBIDDEN");
		},
	);
	const action = {
		action: "move",
		fromListId,
		toListId: created.listId,
		unitIds: diff.units.map((u: { id: string }) => u.id),
		expectedGeneration: current.generation,
		observationId: current.observationId,
	};
	expect((await post(app, { workspaceKey, ...action })).status).toBe(403);
	expect(validate.mock.calls.some(([, paths]) => paths.includes("hidden.txt"))).toBe(true);
	expect((await getSummary()).generation).toBe(current.generation);
	for (const selection of [
		{ all: true },
		{ scope: { filter: ["A"] } },
		{ paths: ["visible.txt", "hidden.txt"] },
	]) {
		const { unitIds: _units, ...baseAction } = action;
		expect((await post(app, { workspaceKey, ...baseAction, ...selection })).status).toBe(403);
		expect((await getSummary()).generation).toBe(current.generation);
	}
	validate.mockRestore();
	expect((await post(app, { workspaceKey, ...action })).status).toBe(200);
	expect((await post(app, { workspaceKey, ...action })).status).toBe(409);
}, 30_000);

test.skipIf(process.platform === "win32")(
	"real HTTP observations exceed 1000 paths and Unix colon files support preview and moves",
	async () => {
		const largeRoot = await realpath(
			await mkdtemp(join(testEnvironment.isolatedHome, "large-git-")),
		);
		try {
			const initialized = await realSafeSpawn({
				cmd: ["git", "-C", largeRoot, "init", "--quiet", "--initial-branch=main"],
				timeout: 10_000,
				maxOutputBytes: 32_768,
			});
			expect(initialized.exitCode).toBe(0);
			sqlite.query("UPDATE narrators SET cwd=? WHERE id='n1'").run(largeRoot);
			await Promise.all(
				Array.from({ length: 1000 }, (_, index) => writeFile(join(largeRoot, `file-${index}`), "")),
			);
			await writeFile(join(largeRoot, "a:b.txt"), "colon content\n");
			spyOn(spawn, "safeSpawn").mockImplementation(realSafeSpawn);
			spyOn(staging, "getGitStagingListsService").mockImplementation(realStagingService);
			const app = appFor();
			const workspaceKey = await key(app);
			const oldBudget = spyOn(management, "validateGitFileTargets").mockImplementation(
				(target, paths) => realValidateGitFileTargets(target, paths),
			);
			expect((await post(app, { workspaceKey, action: "init" })).status).toBe(400);
			oldBudget.mockRestore();
			for (const action of ["init", "sync"]) {
				const response = await post(app, { workspaceKey, action });
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ outcome: "applied" });
			}
			const getSummary = async () =>
				(await app.request(`${BASE}/staging-lists?workspaceKey=${workspaceKey}`)).json();
			let current = await getSummary();
			const fromListId = current.activeListId;
			const preview = await app.request(
				`${BASE}/staging-lists/${fromListId}/diff?workspaceKey=${workspaceKey}&path=a%3Ab.txt`,
			);
			expect(preview.status).toBe(200);
			expect((await preview.json()).diff).toContain("+colon content");
			const created = await post(app, {
				workspaceKey,
				action: "create",
				name: "B",
				expectedGeneration: current.generation,
				observationId: current.observationId,
			});
			expect(created.status).toBe(200);
			const { listId } = await created.json();
			current = await getSummary();
			const moved = await post(app, {
				workspaceKey,
				action: "move",
				fromListId,
				toListId: listId,
				paths: ["a:b.txt"],
				expectedGeneration: current.generation,
				observationId: current.observationId,
			});
			expect(moved.status).toBe(200);
			expect(await moved.json()).toMatchObject({ outcome: "applied" });
		} finally {
			await rm(largeRoot, { recursive: true, force: true });
		}
	},
	30_000,
);
