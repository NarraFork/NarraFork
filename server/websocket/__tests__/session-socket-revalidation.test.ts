/**
 * Long-lived session sockets follow their session: logout, a token-generation bump or a
 * role change reaches sockets that are already open, and a session that slid forward
 * keeps its socket instead of being dropped at the expiry captured on upgrade.
 *
 * ISOLATION: the session store runs on an isolated file/WAL database, mocked over
 * `server/db`, so its live reads execute in the production worker path.
 */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { authSessions, narrators, terminals, users } from "../../db/schema";
import { eventBus } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { getNarratorWorkerTestDb } from "../../services/__tests__/narrator-worker-fixture";

const previousWorker = process.env.NARRAFORK_DB_WORKER;
const previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
process.env.NARRAFORK_DB_WORKER = "on";
process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { createToken, revokeSessionToken, revokeUserSessions, verifyToken } = await import(
	"../../lib/auth"
);
const { authSessionStore } = await import("../../services/auth/store");
const { revalidateSessionSockets, startHeartbeat, stopHeartbeat } = await import("../ws-handler");

afterAll(async () => {
	stopHeartbeat();
	mock.module("../../db", () => realDbModule);
	mock.restore();
	await fixture.close();
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
});

beforeEach(() => {
	cleanDb(sqlite);
	startHeartbeat();
});

type Socket = Parameters<typeof revalidateSessionSockets>[0][number];

async function makeUser(role: "admin" | "user"): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `ws-${id.slice(0, 8)}`,
		passwordHash: "x",
		role,
		createdAt: new Date().toISOString(),
	});
	return id;
}

/** A terminal-channel socket stand-in: only what the re-check and its close path touch. */
function terminalSocket(userId: string, sessionId: string | undefined, sessionExp: number) {
	const close = mock(() => {});
	const ws = {
		readyState: 1,
		data: {
			channel: "terminal",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedTerminals: new Set<string>(),
			sessionId,
			sessionUserId: userId,
			sessionExp,
		},
		close,
	};
	return { ws: ws as unknown as Socket, close };
}

function narratorSocket(userId: string, sessionId: string, role: string) {
	const close = mock(() => {});
	const ws = {
		readyState: 1,
		data: {
			channel: "narrator",
			sessionId,
			sessionUserId: userId,
			sessionExp: 0,
			userRole: role,
		},
		close,
	};
	return { ws: ws as unknown as Socket, close };
}

describe("revalidateSessionSockets", () => {
	test("closes a socket whose session was logged out, and only that one", async () => {
		const userId = await makeUser("user");
		const loggedOut = await verifyToken(await createToken(userId));
		const other = await verifyToken(await createToken(userId));
		const a = terminalSocket(userId, loggedOut.sid, loggedOut.exp);
		const b = terminalSocket(userId, other.sid, other.exp);

		await revokeSessionToken(loggedOut);
		await revalidateSessionSockets([a.ws, b.ws]);

		expect(a.close).toHaveBeenCalledWith(4001, "session ended");
		expect(b.close).not.toHaveBeenCalled();
	});

	test("closes every socket of a user after a token-generation bump", async () => {
		const userId = await makeUser("user");
		const session = await verifyToken(await createToken(userId));
		const socket = terminalSocket(userId, session.sid, session.exp);

		await revokeUserSessions(userId);
		await revalidateSessionSockets([socket.ws]);

		expect(socket.close).toHaveBeenCalled();
	});

	test("keeps a socket whose session slid forward, refreshing its expiry", async () => {
		const userId = await makeUser("user");
		const session = await verifyToken(await createToken(userId));
		const stale = Math.floor(Date.now() / 1000) - 1;
		const socket = terminalSocket(userId, session.sid, stale);

		await revalidateSessionSockets([socket.ws]);

		expect(socket.close).not.toHaveBeenCalled();
		expect((socket.ws.data as { sessionExp: number }).sessionExp).toBe(session.exp);
	});

	test("refreshes the live role on narrator sockets", async () => {
		const userId = await makeUser("admin");
		const session = await verifyToken(await createToken(userId));
		const socket = narratorSocket(userId, session.sid as string, "admin");

		await db.update(users).set({ role: "user" }).where(eq(users.id, userId));
		await revalidateSessionSockets([socket.ws]);

		expect(socket.close).not.toHaveBeenCalled();
		expect((socket.ws.data as { userRole: string }).userRole).toBe("user");
	});

	test("refreshes the live role on terminal sockets and drops what it no longer opens", async () => {
		const adminId = await makeUser("admin");
		const ownerId = await makeUser("user");
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: "private-session",
			ownerUserId: ownerId,
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(terminals).values({
			id: "owner-shell",
			narratorId: "private-session",
			name: "shell",
			status: "running",
			createdAt: now,
		});
		const session = await verifyToken(await createToken(adminId));
		const sent: Array<{ type: string; code?: string }> = [];
		const socket = terminalSocket(adminId, session.sid as string, session.exp);
		Object.assign(socket.ws, { send: (payload: string) => sent.push(JSON.parse(payload)) });
		const data = socket.ws.data as { userRole?: string; subscribedTerminals: Set<string> };
		data.userRole = "admin";
		data.subscribedTerminals.add("owner-shell");

		// Still an admin: the subscription stays.
		await revalidateSessionSockets([socket.ws]);
		expect(data.subscribedTerminals.has("owner-shell")).toBe(true);

		await db.update(users).set({ role: "user" }).where(eq(users.id, adminId));
		await revalidateSessionSockets([socket.ws]);

		expect(socket.close).not.toHaveBeenCalled();
		expect(data.userRole).toBe("user");
		expect(data.subscribedTerminals.has("owner-shell")).toBe(false);
		expect(sent).toContainEqual(
			expect.objectContaining({ type: "error", code: "TERMINAL_NOT_FOUND" }),
		);
	});

	test("an expired session closes the socket", async () => {
		const userId = await makeUser("user");
		const session = await verifyToken(await createToken(userId));
		await db
			.update(authSessions)
			.set({ expiresAt: Math.floor(Date.now() / 1000) - 1 })
			.where(eq(authSessions.id, session.sid as string));
		const socket = terminalSocket(userId, session.sid, session.exp);

		await revalidateSessionSockets([socket.ws]);

		expect(socket.close).toHaveBeenCalled();
	});

	test("multiple explicit sockets and overlapping heartbeats perform one session read", async () => {
		const userId = await makeUser("admin");
		const session = await verifyToken(await createToken(userId));
		const a = terminalSocket(userId, session.sid, session.exp);
		const b = narratorSocket(userId, session.sid as string, "admin");
		const original = authSessionStore.findSessionById;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const find = spyOn(authSessionStore, "findSessionById").mockImplementation(
			async (id, options) => {
				await held;
				return original(id, options);
			},
		);
		const first = revalidateSessionSockets([a.ws, b.ws]);
		const overlap = revalidateSessionSockets([a.ws, b.ws]);
		try {
			expect(overlap).toBe(first);
			expect(find).toHaveBeenCalledTimes(1);
			release();
			await first;
			expect(a.close).not.toHaveBeenCalled();
			expect(b.close).not.toHaveBeenCalled();
		} finally {
			release();
			await first;
			find.mockRestore();
		}
	});

	test("auth changed rejects an in-flight admin snapshot and tail reads the live downgrade", async () => {
		const userId = await makeUser("admin");
		const session = await verifyToken(await createToken(userId));
		const socket = narratorSocket(userId, session.sid as string, "user");
		const original = authSessionStore.findSessionById;
		const stale = await original(session.sid as string);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const find = spyOn(authSessionStore, "findSessionById").mockImplementation(
			async (id, options) => {
				if (++calls === 1) {
					await held;
					return stale;
				}
				return original(id, options);
			},
		);
		const run = revalidateSessionSockets([socket.ws]);
		try {
			await db.update(users).set({ role: "user" }).where(eq(users.id, userId));
			for (let index = 0; index < 5; index++) eventBus.emit({ type: "auth:changed", userId });
			release();
			await run;
			expect(find).toHaveBeenCalledTimes(2);
			expect(socket.close).not.toHaveBeenCalled();
			expect((socket.ws.data as { userRole: string }).userRole).toBe("user");
		} finally {
			release();
			await run;
			find.mockRestore();
		}
	});

	test("identity changes during the session lookup do not close or update the replacement", async () => {
		const userId = await makeUser("admin");
		const session = await verifyToken(await createToken(userId));
		const socket = narratorSocket(userId, session.sid as string, "user");
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const find = spyOn(authSessionStore, "findSessionById").mockImplementation(async () => {
			await held;
			return null;
		});
		const run = revalidateSessionSockets([socket.ws]);
		socket.ws.data.sessionId = "replacement";
		try {
			release();
			await run;
			expect(socket.close).not.toHaveBeenCalled();
			expect(socket.ws.data.sessionExp).toBe(0);
		} finally {
			release();
			await run;
			find.mockRestore();
		}
	});

	test("a storage failure keeps the socket", async () => {
		const userId = await makeUser("user");
		const session = await verifyToken(await createToken(userId));
		const socket = terminalSocket(userId, session.sid, session.exp);
		const original = authSessionStore.findSessionById;
		authSessionStore.findSessionById = async () => {
			throw new Error("database unavailable");
		};
		try {
			await revalidateSessionSockets([socket.ws]);
		} finally {
			authSessionStore.findSessionById = original;
		}

		expect(socket.close).not.toHaveBeenCalled();
	});
});
