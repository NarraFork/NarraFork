import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { Worker as NodeWorker } from "node:worker_threads";
import { testEnvironment } from "../../../tests/preload";
import { db, sqlite } from "../../db";
import { oauthClients } from "../../db/schema";
import { sqliteAuthSessionStore } from "../../services/auth/sqlite-session-store";
import { resolveLiveSession, verifyToken } from "../auth";
import { drainDbWorkerPool, getDbWorkerPoolStats } from "../db-worker/pool";
import { logger } from "../logger";
import { generateSessionToken, hashSessionToken } from "../session-token-hash";

const userId = "auth-admission-user";
const tokens = [generateSessionToken(), generateSessionToken()];
const sessionIds = ["auth-admission-session-a", "auth-admission-session-b"];
const originalFind = sqliteAuthSessionStore.findSessionByTokenHash;
const previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
const previousWorker = process.env.NARRAFORK_DB_WORKER;
const oauthAuthorizePath = `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: "auth-admission-client", redirect_uri: "http://127.0.0.1:9876/callback", scope: "narrator.provision", code_challenge: "A".repeat(43), code_challenge_method: "S256" })}`;

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function outcome<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ value, error: undefined }),
		(error: unknown) => ({ value: undefined, error }),
	);
}

beforeAll(async () => {
	expect(sqlite.filename.startsWith(testEnvironment.narraforkHome)).toBe(true);
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "4";
	delete process.env.NARRAFORK_DB_WORKER;
	const now = Math.floor(Date.now() / 1000);
	sqlite.run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)", [
		userId,
		userId,
		"test-only",
		"admin",
		new Date().toISOString(),
	]);
	for (let i = 0; i < tokens.length; i++) {
		sqlite.run(
			"INSERT INTO auth_sessions(id,user_id,token_hash,token_version,session_start,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
			[sessionIds[i], userId, hashSessionToken(tokens[i]), 0, now, now, now + 604800],
		);
	}
	db.insert(oauthClients)
		.values({
			id: "auth-admission-client",
			clientId: "auth-admission-client",
			name: "Auth admission test",
			redirectUris: ["http://127.0.0.1:9876/callback"],
			scopes: ["narrator.provision"],
			grantTypes: ["authorization_code"],
			publicClient: true,
			createdBy: userId,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.run();
	await Promise.all(Array.from({ length: 4 }, () => originalFind(hashSessionToken(tokens[0]))));
});
beforeEach(() => {
	sqlite.run("UPDATE users SET role='admin',token_version=0 WHERE id=?", [userId]);
	sqlite.run(
		"UPDATE auth_sessions SET revoked_at=NULL,token_version=0,expires_at=? WHERE user_id=?",
		[Math.floor(Date.now() / 1000) + 604800, userId],
	);
});
afterAll(async () => {
	await drainDbWorkerPool({ timeoutMs: 20_000 });
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
});

test("64 same-session authentications perform 64 real Worker reads with bounded fanout", async () => {
	const label = "token";
	const read = () => verifyToken(tokens[0]);
	let posts = 0;
	let maximumBusy = 0;
	let overloadLogs = 0;
	const originalPost = NodeWorker.prototype.postMessage;
	const post = spyOn(NodeWorker.prototype, "postMessage").mockImplementation(function (
		this: NodeWorker,
		message: unknown,
		...rest: unknown[]
	) {
		if ((message as { type?: string }).type === "task") {
			posts++;
			maximumBusy = Math.max(maximumBusy, getDbWorkerPoolStats().busy);
		}
		return originalPost.call(this, message, ...(rest as []));
	});
	const warn = spyOn(logger, "warn").mockImplementation((message: string) => {
		if (message.includes("queue")) overloadLogs++;
	});
	const prepare = spyOn(sqlite, "prepare").mockImplementation(() => {
		throw new Error("Auth SELECT must stay in Worker");
	});
	const query = spyOn(sqlite, "query").mockImplementation(() => {
		throw new Error("Auth SELECT must stay in Worker");
	});
	const started = performance.now();
	let results: Awaited<ReturnType<typeof outcome>>[];
	try {
		results = await Promise.all(Array.from({ length: 64 }, () => outcome(read())));
	} finally {
		post.mockRestore();
		warn.mockRestore();
		prepare.mockRestore();
		query.mockRestore();
	}
	const failed = results.filter((result) => result.error);
	console.log(
		"AUTH_ADMISSION_BURST",
		JSON.stringify({
			label,
			requested: 64,
			completed: results.length - failed.length,
			failures: failed.length,
			posts,
			maximumBusy,
			overloadLogs,
			wallMs: performance.now() - started,
		}),
	);
	expect(failed).toEqual([]);
	expect(posts).toBe(64);
	expect(maximumBusy).toBeGreaterThan(0);
	expect(maximumBusy).toBeLessThanOrEqual(2);
	expect(overloadLogs).toBe(0);
}, 30_000);

test("different tokens and successive requests each read the database; failures release admission", async () => {
	let calls = 0;
	const failure = new Error("test storage failure");
	const find = spyOn(sqliteAuthSessionStore, "findSessionByTokenHash").mockImplementation(
		async (hash) => {
			calls++;
			if (calls === 1) throw failure;
			return originalFind(hash);
		},
	);
	try {
		const first = await outcome(verifyToken(tokens[0]));
		expect(first.error).toBe(failure);
		const later = await Promise.all([verifyToken(tokens[0]), verifyToken(tokens[1])]);
		expect(later.map((payload) => payload.sid)).toEqual(sessionIds);
		await verifyToken(tokens[0]);
		expect(calls).toBe(4);
	} finally {
		find.mockRestore();
	}
});

test("HTTP abort removes queued authentication without an extra storage read or session-invalid response", async () => {
	const [{ Hono }, { requireAuth }, { buildAppErrorResponse }, { isSessionInvalidResponse }] =
		await Promise.all([
			import("hono"),
			import("../../middleware/auth"),
			import("../app-error-response"),
			import("@shared/session-auth"),
		]);
	const occupied = gate();
	const release = gate();
	let calls = 0;
	const find = spyOn(sqliteAuthSessionStore, "findSessionByTokenHash").mockImplementation(
		async (hash) => {
			const number = ++calls;
			const row = await originalFind(hash);
			if (number <= 2) {
				if (number === 2) occupied.resolve();
				await release.promise;
			}
			return row;
		},
	);
	const active = [outcome(verifyToken(tokens[0])), outcome(verifyToken(tokens[0]))];
	await occupied.promise;
	const app = new Hono();
	app.onError(
		(error, c) =>
			buildAppErrorResponse(error, c) ??
			c.json({ error: "Internal error", code: "INTERNAL_ERROR" }, 500),
	);
	app.get("/", requireAuth, (c) => c.text("authorized"));
	const controller = new AbortController();
	try {
		const request = app.request(
			new Request("http://local/", {
				headers: { Authorization: `Bearer ${tokens[1]}` },
				signal: controller.signal,
			}),
		);
		controller.abort();
		const response = await request;
		expect(response.status).toBeGreaterThanOrEqual(500);
		expect(isSessionInvalidResponse(await response.json())).toBe(false);
		expect(calls).toBe(2);
	} finally {
		release.resolve();
		await Promise.all(active);
		find.mockRestore();
	}
});

test("full token admission leaves live-session revalidation independent and OAuth returns transient 503", async () => {
	const [{ Hono }, { oauthRoutes }, { buildAppErrorResponse }] = await Promise.all([
		import("hono"),
		import("../../routes/oauth"),
		import("../app-error-response"),
	]);
	const occupied = gate();
	const release = gate();
	let calls = 0;
	const find = spyOn(sqliteAuthSessionStore, "findSessionByTokenHash").mockImplementation(
		async (hash) => {
			const number = ++calls;
			const row = await originalFind(hash);
			if (number <= 2) {
				if (number === 2) occupied.resolve();
				await release.promise;
			}
			return row;
		},
	);
	const active = [outcome(verifyToken(tokens[0])), outcome(verifyToken(tokens[0]))];
	await occupied.promise;
	const queued = Array.from({ length: 64 }, () => outcome(verifyToken(tokens[0])));
	const app = new Hono();
	app.onError(
		(error, c) => buildAppErrorResponse(error, c) ?? c.json({ code: "INTERNAL_ERROR" }, 500),
	);
	app.route("/oauth", oauthRoutes);
	const path = oauthAuthorizePath;
	try {
		expect((await resolveLiveSession(sessionIds[0]))?.sub).toBe(userId);
		const response = await app.request(path, { headers: { Authorization: `Bearer ${tokens[1]}` } });
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "DB_READ_OVERLOADED",
			messageCode: "DATABASE_READ_UNAVAILABLE",
		});
		const anonymous = await app.request(path);
		expect(anonymous.status).toBe(401);
		expect(await anonymous.json()).toMatchObject({ error: "login_required" });
		expect(calls).toBe(2);
	} finally {
		release.resolve();
		await Promise.all([...active, ...queued]);
		find.mockRestore();
	}
});

test("OAuth consent forwards an aborted request before authentication storage admission", async () => {
	const [{ Hono }, { oauthRoutes }, { buildAppErrorResponse }] = await Promise.all([
		import("hono"),
		import("../../routes/oauth"),
		import("../app-error-response"),
	]);
	const find = spyOn(sqliteAuthSessionStore, "findSessionByTokenHash");
	const app = new Hono();
	app.onError(
		(error, c) => buildAppErrorResponse(error, c) ?? c.json({ code: "INTERNAL_ERROR" }, 500),
	);
	app.route("/oauth", oauthRoutes);
	const controller = new AbortController();
	try {
		const pending = app.request(
			new Request(`http://local${oauthAuthorizePath}`, {
				headers: { Authorization: `Bearer ${tokens[0]}` },
				signal: controller.signal,
			}),
		);
		controller.abort();
		expect((await pending).status).toBeGreaterThanOrEqual(500);
		expect(find).not.toHaveBeenCalled();
	} finally {
		find.mockRestore();
	}
});

for (const change of ["role", "revoke", "token-version", "expiry"] as const) {
	test(`queued authentication reads external SQL ${change} after admission`, async () => {
		const occupied = gate();
		const release = gate();
		let calls = 0;
		const find = spyOn(sqliteAuthSessionStore, "findSessionByTokenHash").mockImplementation(
			async (hash) => {
				const number = ++calls;
				const row = await originalFind(hash);
				if (number <= 2) {
					if (number === 2) occupied.resolve();
					await release.promise;
				}
				return row;
			},
		);
		const first = [outcome(verifyToken(tokens[0])), outcome(verifyToken(tokens[0]))];
		await occupied.promise;
		const later = outcome(verifyToken(tokens[1]));
		const external = new Database(sqlite.filename);
		try {
			expect(calls).toBe(2);
			if (change === "role") external.run("UPDATE users SET role='user' WHERE id=?", [userId]);
			else if (change === "revoke")
				external.run("UPDATE auth_sessions SET revoked_at=? WHERE id=?", [
					Math.floor(Date.now() / 1000),
					sessionIds[1],
				]);
			else if (change === "token-version")
				external.run("UPDATE users SET token_version=token_version+1 WHERE id=?", [userId]);
			else
				external.run("UPDATE auth_sessions SET expires_at=? WHERE id=?", [
					Math.floor(Date.now() / 1000) - 1,
					sessionIds[1],
				]);
			release.resolve();
			const result = await later;
			if (change === "role") expect(result.value?.role).toBe("user");
			else
				expect((result.error as Error)?.name).toBe(
					change === "expiry" ? "SessionTokenExpired" : "SessionTokenRevoked",
				);
			expect(calls).toBe(3);
		} finally {
			release.resolve();
			await Promise.all([...first, later]);
			external.close();
			find.mockRestore();
		}
	}, 10_000);
}
