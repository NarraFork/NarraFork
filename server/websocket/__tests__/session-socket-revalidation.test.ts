/**
 * Long-lived session sockets follow their session: logout, a token-generation bump or a
 * role change reaches sockets that are already open, and a session that slid forward
 * keeps its socket instead of being dropped at the expiry captured on upgrade.
 *
 * ISOLATION: the session store runs on `tests/setup`'s in-memory database, mocked over
 * `server/db`.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { authSessions, users } from "../../db/schema";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { createToken, revokeSessionToken, revokeUserSessions, verifyToken } = await import(
	"../../lib/auth"
);
const { authSessionStore } = await import("../../services/auth/store");
const { revalidateSessionSockets } = await import("../ws-handler");

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

beforeEach(() => {
	cleanDb(sqlite);
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
