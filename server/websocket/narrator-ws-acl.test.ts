/**
 * WebSocket access control for narrator subscriptions.
 *
 * This was the widest hole before ACLs existed: `subscribe` only enforced a count
 * limit, so any authenticated socket could stream a private narrator's full
 * timeline by naming its id, and the catch-up path would replay history to it.
 *
 * Pinned here:
 *  - a denied subscribe never lands in `subscribedNarrators`, so later broadcasts
 *    cannot reach the connection;
 *  - the client is told (`subscribe_denied`) rather than left waiting;
 *  - a mixed batch subscribes the allowed ids and refuses the rest;
 *  - read access is not write access: buffered-input frames need write;
 *  - a connection with no user identity gets nothing;
 *  - the frames that name a request id instead of a narrator
 *    (`permission_decision`, `update_timeout`) are authorized too.
 *    Those were the second hole: a reader who could see a permission request could
 *    approve it, because the id was all the handler asked for.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { cleanDb } from "../../tests/setup";
import {
	aclGrants,
	chatRooms,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../db/schema";
import {
	closeRuntimeTestDb,
	drainRuntimeTestWork,
	getRuntimeTestDb,
} from "../services/__tests__/agent-runtime-test-database";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDbModule = { ...(await import("../db")) };
mock.module("../db", () => ({ db, sqlite }));

const { broadcastToNarrator, getNarratorConnections, handleNarratorWS } = await import(
	"./narrator-ws"
);

type SentMessage = Record<string, unknown>;
type FakeNarratorWS = Parameters<typeof handleNarratorWS.open>[0];

const OWNER = "acl-ws-owner";
const STRANGER = "acl-ws-stranger";
const VIEWER = "acl-ws-viewer";
const NOW = "2026-07-19T00:00:00.000Z";

const openedConnections: FakeNarratorWS[] = [];

function openWs(options: { userId?: string; userRole?: string } = {}) {
	const sent: SentMessage[] = [];
	const ws = {
		data: {
			channel: "narrator" as const,
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedNarrators: new Set<string>(),
			subscribedChatRooms: new Set<string>(),
			catchingUpNarrators: new Map(),
			catchUpBuffers: new Map(),
			userId: options.userId,
			userRole: options.userRole,
		},
		send(payload: string) {
			sent.push(JSON.parse(payload) as SentMessage);
		},
	} as unknown as FakeNarratorWS;
	handleNarratorWS.open(ws);
	openedConnections.push(ws);
	// ACL command responses are asserted independently from the initial revision hint.
	const initialFrames = sent.splice(0);
	return { ws, sent, initialFrames };
}

/**
 * Wait for an asynchronously sent frame.
 *
 * The handlers that pass the gate hand off to a resolver and reply from a `.then`,
 * so a single microtask flush is not enough and a fixed sleep would be flaky.
 */
async function waitForSent(
	sent: SentMessage[],
	predicate: (m: SentMessage) => boolean,
): Promise<boolean> {
	for (let i = 0; i < 50; i++) {
		if (sent.some(predicate)) return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return false;
}

/** The owner column is a real FK, so the user rows have to exist first. */
function seedUsers() {
	for (const id of [OWNER, STRANGER, VIEWER]) {
		db.insert(users)
			.values({ id, username: id, passwordHash: "x", role: "user", createdAt: NOW })
			.run();
	}
}

function seedNarrator(id: string, visibility: "private" | "project" | "public") {
	db.insert(narrators)
		.values({
			id,
			status: "idle",
			substatus: "[]",
			ownerUserId: OWNER,
			visibility,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function grantRead(narratorId: string, userId: string) {
	db.insert(aclGrants)
		.values({
			id: `grant-${narratorId}-${userId}`,
			scopeType: "narrator",
			scopeId: narratorId,
			principalType: "user",
			principalId: userId,
			capability: "read",
			createdAt: NOW,
		})
		.run();
}

/**
 * A decided tool call, which is how a request id is resolved back to its narrator
 * once the in-memory pending entry is gone. The request id IS the row id.
 */
function seedToolCall(requestId: string, narratorId: string) {
	db.insert(narratorMessages)
		.values({
			id: `msg-${requestId}`,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: NOW,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: requestId,
			narratorId,
			messageId: `msg-${requestId}`,
			toolUseId: `tu-${requestId}`,
			toolName: "Bash",
			status: "pending",
			createdAt: NOW,
		})
		.run();
}

beforeEach(() => {
	seedUsers();
});

afterEach(async () => {
	for (const ws of openedConnections.splice(0)) handleNarratorWS.close(ws);
	getNarratorConnections().clear();
	await drainRuntimeTestWork();
	cleanDb(sqlite);
});

afterAll(async () => {
	await closeRuntimeTestDb(sqlite);
	mock.module("../db", () => realDbModule);
});

it("new-room discovery reaches only authorized subscribers of that narrator without joining chat", async () => {
	seedNarrator("created-target", "private");
	seedNarrator("created-other", "private");
	const target = openWs({ userId: OWNER });
	const other = openWs({ userId: OWNER });
	const denied = openWs({ userId: STRANGER });
	await handleNarratorWS.message(target.ws, {
		type: "subscribe",
		kind: "list",
		narratorIds: ["created-target"],
	});
	await handleNarratorWS.message(other.ws, {
		type: "subscribe",
		kind: "list",
		narratorIds: ["created-other"],
	});
	await handleNarratorWS.message(denied.ws, {
		type: "subscribe",
		kind: "list",
		narratorIds: ["created-target"],
	});
	const frame = {
		type: "chat:room_created" as const,
		narratorId: "created-target",
		roomId: "new-room",
	};
	broadcastToNarrator("created-target", frame);
	expect(target.sent).toContainEqual(frame);
	expect(other.sent).not.toContainEqual(frame);
	expect(denied.sent).not.toContainEqual(frame);
	expect(target.ws.data.subscribedChatRooms.size).toBe(0);
});

describe("chat subscribe acknowledgment", () => {
	function seedRoom() {
		seedNarrator("chat-private", "private");
		db.insert(chatRooms)
			.values({
				id: "chat-room",
				narratorId: "chat-private",
				kind: "narrator",
				nextSeq: 4,
				createdAt: NOW,
			})
			.run();
	}

	it("ACKs each authorized join, after joining, including repeated subscriptions", async () => {
		seedRoom();
		const { ws, sent } = openWs({ userId: OWNER });
		const chat = await import("../services/chat-service");
		const original = chat.readChatTailSeq;
		const tail = spyOn(chat, "readChatTailSeq").mockImplementation(async (roomId) => {
			expect(ws.data.subscribedChatRooms.has(roomId)).toBe(true);
			return original(roomId);
		});
		try {
			for (const requestId of ["first", "resumed"]) {
				await handleNarratorWS.message(ws, {
					type: "chat_subscribe",
					roomIds: ["chat-room"],
					requestId,
				});
				expect(sent).toContainEqual({
					type: "chat:subscribed",
					roomId: "chat-room",
					requestId,
					tailSeq: 3,
				});
			}
			expect(tail).toHaveBeenCalledTimes(2);
		} finally {
			tail.mockRestore();
		}
	});

	it("ACKs simultaneous owners of the same room independently", async () => {
		seedRoom();
		const { ws, sent } = openWs({ userId: OWNER });
		await Promise.all(
			["panel-one", "panel-two"].map((requestId) =>
				handleNarratorWS.message(ws, { type: "chat_subscribe", roomIds: ["chat-room"], requestId }),
			),
		);
		for (const requestId of ["panel-one", "panel-two"]) {
			expect(sent).toContainEqual({
				type: "chat:subscribed",
				roomId: "chat-room",
				requestId,
				tailSeq: 3,
			});
		}
	});

	it("denies private and nonexistent rooms identically without joining", async () => {
		seedRoom();
		const { ws, sent } = openWs({ userId: STRANGER });
		await handleNarratorWS.message(ws, {
			type: "chat_subscribe",
			roomIds: ["chat-room", "absent"],
			requestId: "denied",
		});
		for (const roomId of ["chat-room", "absent"]) {
			expect(sent).toContainEqual({
				type: "chat:subscription_denied",
				roomId,
				requestId: "denied",
				status: 403,
			});
		}
		expect(ws.data.subscribedChatRooms.size).toBe(0);
	});

	it("reports permission loss to every simultaneous waiting owner", async () => {
		seedRoom();
		const { ws, sent } = openWs({ userId: STRANGER });
		await Promise.all(
			["denied-one", "denied-two"].map((requestId) =>
				handleNarratorWS.message(ws, { type: "chat_subscribe", roomIds: ["chat-room"], requestId }),
			),
		);
		for (const requestId of ["denied-one", "denied-two"]) {
			expect(sent).toContainEqual({
				type: "chat:subscription_denied",
				roomId: "chat-room",
				requestId,
				status: 403,
			});
		}
	});

	it("reauthorizes a joined room after its read grant is revoked", async () => {
		seedRoom();
		grantRead("chat-private", VIEWER);
		const { ws, sent } = openWs({ userId: VIEWER });
		await handleNarratorWS.message(ws, {
			type: "chat_subscribe",
			roomIds: ["chat-room"],
			requestId: "before-revoke",
		});
		expect(ws.data.subscribedChatRooms.has("chat-room")).toBe(true);
		db.delete(aclGrants).run();
		await handleNarratorWS.message(ws, {
			type: "chat_subscribe",
			roomIds: ["chat-room"],
			requestId: "after-revoke",
		});
		expect(ws.data.subscribedChatRooms.has("chat-room")).toBe(false);
		expect(sent).toContainEqual({
			type: "chat:subscription_denied",
			roomId: "chat-room",
			requestId: "after-revoke",
			status: 403,
		});
	});

	it("keeps legacy batch subscriptions without ACK frames", async () => {
		seedRoom();
		const { ws, sent } = openWs({ userId: OWNER });
		await handleNarratorWS.message(ws, { type: "chat_subscribe", roomIds: ["chat-room"] });
		expect(ws.data.subscribedChatRooms.has("chat-room")).toBe(true);
		expect(sent.some((frame) => frame.type === "chat:subscribed")).toBe(false);
	});

	it("unsubscribe cancels an in-flight authorization and its ACK", async () => {
		seedRoom();
		const { ws, sent } = openWs({ userId: OWNER });
		const chat = await import("../services/chat-service");
		const access = await chat.assertCanRead("chat-room", OWNER);
		let release!: (value: typeof access) => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = spyOn(chat, "assertCanRead").mockImplementation(() => {
			entered();
			return new Promise((resolve) => {
				release = resolve;
			});
		});
		try {
			const joining = handleNarratorWS.message(ws, {
				type: "chat_subscribe",
				roomIds: ["chat-room"],
				requestId: "stale",
			});
			await started;
			await handleNarratorWS.message(ws, { type: "chat_unsubscribe", roomIds: ["chat-room"] });
			release(access);
			await joining;
			expect(ws.data.subscribedChatRooms.has("chat-room")).toBe(false);
			expect(sent.some((frame) => frame.type === "chat:subscribed")).toBe(false);
		} finally {
			gate.mockRestore();
		}
	});

	it("does not report operational read failure as permission loss", async () => {
		seedRoom();
		const { ws, sent } = openWs({ userId: OWNER });
		const chat = await import("../services/chat-service");
		const gate = spyOn(chat, "assertCanRead").mockRejectedValue(new Error("worker unavailable"));
		try {
			await handleNarratorWS.message(ws, {
				type: "chat_subscribe",
				roomIds: ["chat-room"],
				requestId: "retry",
			});
			expect(sent.some((frame) => frame.type === "chat:subscription_denied")).toBe(false);
			expect(sent.some((frame) => frame.type === "error")).toBe(true);
		} finally {
			gate.mockRestore();
		}
	});
});

describe("subscribe authorization", () => {
	it("does not subscribe a stranger to a private narrator", async () => {
		seedNarrator("private-1", "private");
		const { ws, sent } = openWs({ userId: STRANGER });

		await handleNarratorWS.message(ws, { type: "subscribe", narratorIds: ["private-1"] });

		expect(ws.data.subscribedNarrators.has("private-1")).toBe(false);
		expect(sent).toEqual([{ type: "subscribe_denied", narratorId: "private-1" }]);
	});

	it("subscribes the owner", async () => {
		seedNarrator("private-2", "private");
		const { ws, sent } = openWs({ userId: OWNER });

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["private-2"],
		});

		expect(ws.data.subscribedNarrators.has("private-2")).toBe(true);
		expect(sent.some((m) => m.type === "subscribe_denied")).toBe(false);
	});

	it("subscribes a read-granted user", async () => {
		seedNarrator("private-3", "private");
		grantRead("private-3", VIEWER);
		const { ws } = openWs({ userId: VIEWER });

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["private-3"],
		});

		expect(ws.data.subscribedNarrators.has("private-3")).toBe(true);
	});

	it("subscribes an admin to anyone's narrator", async () => {
		seedNarrator("private-4", "private");
		const { ws } = openWs({ userId: "an-admin", userRole: "admin" });

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["private-4"],
		});

		expect(ws.data.subscribedNarrators.has("private-4")).toBe(true);
	});

	it("accepts the allowed ids of a mixed batch and denies the rest", async () => {
		seedNarrator("mixed-public", "public");
		seedNarrator("mixed-private", "private");
		const { ws, sent } = openWs({ userId: STRANGER });

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			kind: "list",
			narratorIds: ["mixed-public", "mixed-private"],
		});

		expect(ws.data.subscribedNarrators.has("mixed-public")).toBe(true);
		expect(ws.data.subscribedNarrators.has("mixed-private")).toBe(false);
		expect(sent).toContainEqual({ type: "subscribe_denied", narratorId: "mixed-private" });
	});

	it("denies an unknown id with the same frame as a private one", async () => {
		// Identical response shapes: the frame must not double as an existence probe.
		const { ws, sent } = openWs({ userId: STRANGER });

		await handleNarratorWS.message(ws, { type: "subscribe", narratorIds: ["no-such-narrator"] });

		expect(sent).toEqual([{ type: "subscribe_denied", narratorId: "no-such-narrator" }]);
	});

	it("denies everything on a connection with no user identity", async () => {
		seedNarrator("public-anon", "public");
		const { ws, sent } = openWs({});

		await handleNarratorWS.message(ws, { type: "subscribe", narratorIds: ["public-anon"] });

		expect(ws.data.subscribedNarrators.size).toBe(0);
		expect(sent).toEqual([{ type: "subscribe_denied", narratorId: "public-anon" }]);
	});

	it("echoes the requestId so the client can settle the right pending request", async () => {
		seedNarrator("private-req", "private");
		const { sent, ws } = openWs({ userId: STRANGER });

		await handleNarratorWS.message(ws, {
			type: "subscribe",
			narratorIds: ["private-req"],
			requestId: "req-9",
		});

		expect(sent).toEqual([
			{ type: "subscribe_denied", narratorId: "private-req", requestId: "req-9" },
		]);
	});
});

describe("frame authorization", () => {
	it("refuses to buffer input for a narrator the user may only read", async () => {
		seedNarrator("public-read", "public");
		const { ws, sent } = openWs({ userId: STRANGER });

		await handleNarratorWS.message(ws, {
			type: "buffer_message",
			narratorId: "public-read",
			text: "hello",
		});

		// Silently dropped: no state change, and no reply that would confirm the id.
		expect(sent).toEqual([]);
	});

	it("refuses presence on a private narrator", async () => {
		seedNarrator("private-presence", "private");
		const { ws, sent } = openWs({ userId: STRANGER });

		await handleNarratorWS.message(ws, {
			type: "presence_join",
			narratorId: "private-presence",
		});

		expect(sent).toEqual([]);
	});

	it("allows presence for the owner", async () => {
		seedNarrator("owned-presence", "private");
		const observer = openWs({ userId: OWNER });
		observer.ws.data.subscribedNarrators.add("owned-presence");
		observer.sent.length = 0;

		await handleNarratorWS.message(observer.ws, {
			type: "presence_join",
			narratorId: "owned-presence",
		});

		expect(observer.sent.some((m) => m.type === "presence_update")).toBe(true);
	});

	it("refuses to change a running tool's timeout on a read-only narrator", async () => {
		// `update_timeout` alters how someone else's session behaves and echoes a frame
		// to its subscribers, so read access must not be enough.
		seedNarrator("public-timeout", "public");
		const { ws, sent } = openWs({ userId: STRANGER });

		await handleNarratorWS.message(ws, {
			type: "update_timeout",
			narratorId: "public-timeout",
			toolUseId: "tu-1",
			timeoutMs: 1000,
		});

		expect(sent).toEqual([]);
	});
});

/**
 * The decision frames carry a request/session id and no narrator id, so they are the
 * ones most easily left unauthorized — and the ids are broadcast to every reader.
 */
describe("decision frame authorization", () => {
	it("refuses a permission decision from a user who may only read the narrator", async () => {
		seedNarrator("public-perm", "public");
		seedToolCall("req-public-perm", "public-perm");
		const { ws, sent } = openWs({ userId: STRANGER });

		await handleNarratorWS.message(ws, {
			type: "permission_decision",
			requestId: "req-public-perm",
			decision: "allow",
		});

		// Dropped before reaching the resolver: no "Permission request not found"
		// reply either, since that would confirm the id exists.
		expect(sent).toEqual([]);
	});

	it("refuses a permission decision for an unknown request id", async () => {
		const { ws, sent } = openWs({ userId: STRANGER });

		await handleNarratorWS.message(ws, {
			type: "permission_decision",
			requestId: "req-nonexistent",
			decision: "allow",
		});

		expect(sent).toEqual([]);
	});

	it("lets the narrator owner decide a permission request", async () => {
		seedNarrator("owned-perm", "private");
		seedToolCall("req-owned-perm", "owned-perm");
		const { ws, sent } = openWs({ userId: OWNER });

		await handleNarratorWS.message(ws, {
			type: "permission_decision",
			requestId: "req-owned-perm",
			decision: "deny",
		});

		// Reaches the resolver, which finds nothing pending in memory and says so.
		// The point is that it got that far rather than being dropped by the gate.
		expect(await waitForSent(sent, (m) => m.type === "error")).toBe(true);
	});
});
