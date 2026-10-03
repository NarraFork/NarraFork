import { Database } from "bun:sqlite";
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEXT_DOCUMENT_PACKET_BYTES } from "@shared/pretext-layout/text-document";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getTestDb } from "../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../db/schema";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";

// Import no runtime DB: all route/auth/persistence reads use this isolated in-memory fixture.
const { db, sqlite } = getTestDb();
const dbStub = {
	db,
	sqlite,
	activeDatabaseBackend: "sqlite" as const,
	startupShutdownState: { canSkipVerification: true },
	markDatabaseCleanShutdown: () => true,
	releaseDatabaseInstanceLockOnly: () => {},
};
mock.module("../db", () => dbStub);
mock.module("@server/db", () => dbStub);
const sourceModule = await import("./tool-input-stream-source");
const directory = await mkdtemp(join(tmpdir(), "nf-tool-source-transport-"));
const historyPath = join(directory, "isolated-history-fixture.sqlite");
const historyDatabase = new Database(historyPath);
historyDatabase.run(
	"CREATE TABLE history_inputs (id TEXT PRIMARY KEY, narrator_id TEXT, message_id TEXT, tool_use_id TEXT, execution_attempt INTEGER, tool_name TEXT, input_json TEXT)",
);
historyDatabase.run(
	"CREATE VIEW narrator_tool_calls AS SELECT *, json('FORBIDDEN_OTHER_COLUMN_READ') AS output_json FROM history_inputs",
);
let historyWorkers = 0;
let writeGate: Promise<void> | undefined;
const service = new sourceModule.ToolInputStreamSourceService({
	directory,
	memoryBytes: 16,
	streamHistorical: async (identity, sink, signal) => {
		historyWorkers++;
		await sourceModule.streamHistoricalWriteContent(historyPath, identity, sink, signal);
	},
	write: async (file, bytes, position) => {
		await writeGate;
		await file.write(bytes, 0, bytes.length, position);
	},
});
mock.module("./tool-input-stream-source", () => ({
	...sourceModule,
	toolInputStreamSource: service,
}));
const {
	ToolInputLaneSender,
	toolInputFrames,
	handleNarratorWS,
	dropNarratorSubscriptionsForUnauthorizedUsers,
	revalidateQueuedToolInputFrame,
} = await import("../websocket/narrator-ws");
const { narratorRoutes } = await import("../routes/narrators");
const { publicNarratorShareRoutes } = await import("../routes/public-narrator-shares");
const { createPublicShare, revokePublicShare } = await import("./public-narrator-share-service");

const owner = generateId();
const outsider = generateId();
const narratorId = generateId();
const childId = generateId();
const now = new Date().toISOString();
for (const id of [owner, outsider])
	db.insert(users)
		.values({ id, username: id, passwordHash: "unused", role: "user", createdAt: now })
		.run();
for (const id of [narratorId, childId])
	db.insert(narrators)
		.values({
			id,
			ownerUserId: owner,
			title: "range fixture",
			type: id === childId ? "subagent" : "primary",
			parentNarratorId: id === childId ? narratorId : null,
			createdAt: now,
			updatedAt: now,
		})
		.run();
const app = new Hono();
app.use("/api/narrators/*", async (c, next) => {
	// Simulate the principal installed by requireSessionAuth, not a route-supplied owner/query parameter.
	c.set("user", {
		sub: c.req.header("x-test-principal") ?? owner,
		role: "user",
		iat: 0,
		exp: 2147483647,
	});
	await next();
});
app.route("/api/narrators", narratorRoutes);
app.route("/api/public/narrator-shares", publicNarratorShareRoutes);
app.onError((error, c) =>
	c.json(
		{ code: error instanceof AppError ? error.code : "INTERNAL_ERROR" },
		(error instanceof AppError ? error.statusCode : 500) as 400,
	),
);
const refs: string[] = [];
afterAll(async () => {
	for (const ref of refs) await service.discard(ref);
	historyDatabase.close();
	await rm(directory, { recursive: true, force: true });
	mock.restore();
});

async function source(ownerId = narratorId, text = "raw\r\n\ud800") {
	const ref = service.create(
		{ narratorId: ownerId, toolUseId: "provider-id", field: "content" },
		generateId(),
	);
	refs.push(ref.id);
	await service.append(ref.id, text, 0);
	return service.descriptor(ref.id);
}

describe("historical ensure source routes", () => {
	test("legacy attempt=0 is precisely readable and remains hidden from other users and Share scopes", async () => {
		const messageId = generateId();
		const toolCallId = generateId();
		const toolUseId = "legacy-zero-call";
		const raw = "legacy canonical full content\r\n\ud800";
		db.insert(narratorMessages)
			.values({
				id: messageId,
				narratorId,
				role: "assistant",
				contentJson: [{ type: "tool_use", id: toolUseId, name: "Write", input: {} }],
				createdAt: now,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId, messageId, seq: 1, isCompact: 0 })
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: toolCallId,
				narratorId,
				messageId,
				toolUseId,
				toolName: "Write",
				inputJson: { content: raw },
				outputJson: { _text: "x".repeat(33 * 1024 * 1024) },
				executionAttempt: 0,
				status: "success",
				createdAt: now,
			})
			.run();
		historyDatabase.run("INSERT INTO history_inputs VALUES (?, ?, ?, ?, ?, ?, ?)", [
			toolCallId,
			narratorId,
			messageId,
			toolUseId,
			0,
			"Write",
			JSON.stringify({ content: raw }),
		]);
		const query = new URLSearchParams({ toolCallId, messageId, executionAttempt: "0" });
		const root = `/api/narrators/${narratorId}/tool-calls/${toolUseId}`;
		expect((await app.request(`${root}?${query}`)).status).toBe(413);
		const response = await app.request(`${root}/input-document?${query}`);
		expect(response.status).toBe(200);
		const ref = (await response.json()) as { id: string; source: { executionAttempt: number } };
		refs.push(ref.id);
		expect(ref.source.executionAttempt).toBe(0);
		expect((await service.getTextDocumentRange(narratorId, ref.id)).text).toBe(raw);
		expect(
			(
				await app.request(`${root}/input-document?${query}`, {
					headers: { "x-test-principal": outsider },
				})
			).status,
		).toBe(404);
		const wrongNarratorId = generateId();
		db.insert(narrators)
			.values({
				id: wrongNarratorId,
				ownerUserId: owner,
				type: "primary",
				title: "other share scope",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		const wrongShare = await createPublicShare(
			wrongNarratorId,
			{ userId: owner, isAdmin: false },
			{ guestName: "different scope" },
		);
		expect(
			(
				await app.request(
					`/api/public/narrator-shares/${wrongShare.share.id}/tool-calls/${toolUseId}/input-document?${query}`,
					{
						headers: { Authorization: `Share ${wrongShare.token}` },
					},
				)
			).status,
		).toBe(404);
	});

	test("detail 413 and TTL expiry do not limit canonical content; metadata ACL precedes readonly extraction", async () => {
		const messageId = generateId();
		const toolCallId = generateId();
		const toolUseId = "history-provider:call";
		const raw = "完整代码\r\n\ud800".repeat(10000);
		const input = { content: raw, unrelatedMetadata: "m".repeat(1024 * 1024) };
		db.insert(narratorMessages)
			.values({
				id: messageId,
				narratorId,
				role: "assistant",
				contentJson: [
					{
						type: "tool_use",
						id: toolUseId,
						name: "Write",
						input: { content: "bounded projection" },
					},
				],
				createdAt: now,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId, messageId, seq: 0, isCompact: 0 })
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: toolCallId,
				narratorId,
				messageId,
				toolUseId,
				toolName: "Write",
				inputJson: input,
				outputJson: { _text: "output".repeat(6 * 1024 * 1024) },
				executionAttempt: 2,
				status: "success",
				createdAt: now,
			})
			.run();
		historyDatabase.run("INSERT INTO history_inputs VALUES (?, ?, ?, ?, ?, ?, ?)", [
			toolCallId,
			narratorId,
			messageId,
			toolUseId,
			2,
			"Write",
			JSON.stringify(input),
		]);
		const root = `/api/narrators/${narratorId}/tool-calls/${encodeURIComponent(toolUseId)}`;
		const query = new URLSearchParams({ toolCallId, messageId, executionAttempt: "2" });
		expect((await app.request(`${root}?${query}`)).status).toBe(413);
		const firstResponse = await app.request(`${root}/input-document?${query}`);
		expect(firstResponse.status).toBe(200);
		const first = (await firstResponse.json()) as {
			id: string;
			epoch: string;
			length: number;
			source: { toolCallId: string; messageId: string; executionAttempt: number };
		};
		refs.push(first.id);
		expect(first.length).toBe(raw.length);
		expect(first.source).toMatchObject({ toolCallId, messageId, executionAttempt: 2 });
		for (const offset of [0, Math.floor(raw.length / 2), raw.length - 32]) {
			const response = await app.request(
				`/api/narrators/${narratorId}/text-documents/${first.id}?offset=${offset}&limit=32`,
			);
			expect(((await response.json()) as { text: string }).text).toBe(
				raw.slice(offset, offset + 32),
			);
		}
		const forkId = generateId();
		db.insert(narrators)
			.values({
				id: forkId,
				ownerUserId: outsider,
				title: "shared-prefix reader",
				type: "primary",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId: forkId, messageId, seq: 0, isCompact: 0 })
			.run();
		const forkResponse = await app.request(
			`/api/narrators/${forkId}/tool-calls/${encodeURIComponent(toolUseId)}/input-document?${query}`,
			{
				headers: { "x-test-principal": outsider },
			},
		);
		expect(forkResponse.status).toBe(200);
		const fork = (await forkResponse.json()) as { id: string; source: { narratorId: string } };
		refs.push(fork.id);
		expect(fork.source.narratorId).toBe(forkId);
		expect((await service.getTextDocumentRange(forkId, fork.id, 0, 16)).text).toBe(
			raw.slice(0, 16),
		);
		const beforeDenied = historyWorkers;
		expect(
			(
				await app.request(`${root}/input-document?${query}`, {
					headers: { "x-test-principal": outsider },
				})
			).status,
		).toBe(404);
		expect(
			(
				await app.request(
					`${root}/input-document?${new URLSearchParams({ toolCallId, messageId, executionAttempt: "1" })}`,
				)
			).status,
		).toBe(404);
		expect(historyWorkers).toBe(beforeDenied);
		await service.cleanupExpired(Date.now() + 25 * 60 * 60 * 1000);
		expect(
			(await app.request(`/api/narrators/${narratorId}/text-documents/${first.id}`)).status,
		).toBe(404);
		const share = await createPublicShare(
			narratorId,
			{ userId: owner, isAdmin: false },
			{ guestName: "historical reader" },
		);
		const publicRoot = `/api/public/narrator-shares/${share.share.id}`;
		const rebuiltResponse = await app.request(
			`${publicRoot}/tool-calls/${encodeURIComponent(toolUseId)}/input-document?${query}`,
			{
				headers: { Authorization: `Share ${share.token}` },
			},
		);
		expect(rebuiltResponse.status).toBe(200);
		const rebuilt = (await rebuiltResponse.json()) as { id: string; epoch: string; length: number };
		refs.push(rebuilt.id);
		expect(rebuilt.epoch).not.toBe(first.epoch);
		expect(rebuilt.length).toBe(raw.length);
		const publicRange = await app.request(
			`${publicRoot}/text-documents/${rebuilt.id}?offset=${raw.length - 16}&limit=16`,
			{
				headers: { Authorization: `Share ${share.token}` },
			},
		);
		expect(((await publicRange.json()) as { text: string }).text).toBe(raw.slice(-16));
		await revokePublicShare(narratorId, share.share.id, { userId: owner, isAdmin: false });
		expect(
			(
				await app.request(
					`${publicRoot}/tool-calls/${encodeURIComponent(toolUseId)}/input-document?${query}`,
					{
						headers: { Authorization: `Share ${share.token}` },
					},
				)
			).status,
		).toBe(404);
	});
});

describe("tool input range authorization and recovery", () => {
	test("JWT narrator read gate permits owner, hides outsiders, and keeps pages bounded", async () => {
		const ref = await source(narratorId, "\ud800".repeat(10000));
		const path = `/api/narrators/${narratorId}/text-documents/${ref.id}?offset=0&limit=100000`;
		const result = await app.request(path);
		expect(result.status).toBe(200);
		const packet = await result.text();
		expect(Buffer.byteLength(packet)).toBeLessThanOrEqual(TEXT_DOCUMENT_PACKET_BYTES);
		expect(JSON.parse(packet).text.length).toBe(8192);
		expect(packet).not.toContain(directory);
		const denied = await app.request(path, { headers: { "x-test-principal": outsider } });
		expect(denied.status).toBe(404);
		const bad = await app.request(`${path}&ignored=yes`.replace("offset=0", "offset=-1"));
		expect(bad.status).toBe(400);
	});

	test("share uses same source service, cannot reach child/unrelated source, and revoked credentials stop reading", async () => {
		const own = await source();
		const child = await source(childId, "child private");
		const share = await createPublicShare(
			narratorId,
			{ userId: owner, isAdmin: false },
			{ guestName: "visitor" },
		);
		const get = (id: string, credential = share.token) =>
			app.request(`/api/public/narrator-shares/${share.share.id}/text-documents/${id}`, {
				headers: { Authorization: `Share ${credential}` },
			});
		expect((await get(own.id)).status).toBe(200);
		expect((await get(child.id)).status).toBe(404);
		expect((await get(own.id, "invalid")).status).toBe(404);
		await revokePublicShare(narratorId, share.share.id, { userId: owner, isAdmin: false });
		expect((await get(own.id)).status).toBe(404);
	});

	test("share revocation during asynchronous source read prevents returning already-authorized bytes", async () => {
		const ref = await source();
		const share = await createPublicShare(
			narratorId,
			{ userId: owner, isAdmin: false },
			{ guestName: "visitor" },
		);
		let release!: () => void;
		writeGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const append = service.append(ref.id, "more bytes to force spill", ref.length);
		let began!: () => void;
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		const original = service.getTextDocumentRange.bind(service);
		const spy = spyOn(service, "getTextDocumentRange").mockImplementation((...args) => {
			began();
			return original(...args);
		});
		try {
			const request = app.request(
				`/api/public/narrator-shares/${share.share.id}/text-documents/${ref.id}`,
				{
					headers: { Authorization: `Share ${share.token}` },
				},
			);
			await started;
			await revokePublicShare(narratorId, share.share.id, { userId: owner, isAdmin: false });
			release();
			await append;
			const response = await request;
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain("raw");
		} finally {
			release();
			writeGate = undefined;
			spy.mockRestore();
		}
	});
});

describe("tool input websocket lane", () => {
	test("ACL revocation clears subscription and revalidates queued source identities before drain", async () => {
		const ref = await source(narratorId, "private raw body");
		const sent: string[] = [];
		let buffered = 16;
		let first = true;
		const ws = {
			data: {
				channel: "narrator",
				connectedAt: Date.now(),
				lastPongAt: Date.now(),
				userId: owner,
				userRole: "user",
				subscribedNarrators: new Set([narratorId]),
				catchingUpNarrators: new Map(),
				catchUpBuffers: new Map(),
			},
			getBufferedAmount: () => buffered,
			close: () => {},
			send: (payload: string) => {
				sent.push(payload);
				if (first) {
					first = false;
					return -1;
				}
				return payload.length;
			},
		} as unknown as Parameters<typeof handleNarratorWS.open>[0];
		handleNarratorWS.open(ws);
		let drained!: () => void;
		const completed = new Promise<void>((resolve) => {
			drained = resolve;
		});
		const sender = new ToolInputLaneSender(256 * 1024, async (socket, identity) => {
			const allowed = await revalidateQueuedToolInputFrame(socket, identity);
			drained();
			return allowed;
		});
		const identity = { narratorId, refId: ref.id, epoch: ref.epoch };
		try {
			expect(sender.send(ws, "accepted-before-revocation", identity)).toBe(true);
			expect(sender.send(ws, "queued-private-tail", identity)).toBe(true);
			await db.update(narrators).set({ ownerUserId: outsider }).where(eq(narrators.id, narratorId));
			await dropNarratorSubscriptionsForUnauthorizedUsers(narratorId);
			buffered = 0;
			await completed;
			expect(ws.data.subscribedNarrators.has(narratorId)).toBe(false);
			expect(sent).not.toContain("queued-private-tail");
		} finally {
			sender.close(ws);
			handleNarratorWS.close(ws);
			await db.update(narrators).set({ ownerUserId: owner }).where(eq(narrators.id, narratorId));
		}
	});

	test("unsubscription and source epoch replacement drop queued plaintext without retrying accepted frames", async () => {
		const ref = await source(narratorId, "old body");
		let subscribed = true;
		const sent: string[] = [];
		let buffered = 16;
		let first = true;
		let checked!: () => void;
		const flushed = new Promise<void>((resolve) => {
			checked = resolve;
		});
		const sender = new ToolInputLaneSender(256 * 1024, async (_socket, identity) => {
			const allowed =
				subscribed &&
				service.isCurrentInputLane(identity.narratorId, identity.refId, identity.epoch);
			checked();
			return allowed;
		});
		const socket = {
			getBufferedAmount: () => buffered,
			close: () => {},
			send: (payload: unknown) => {
				sent.push(String(payload));
				if (first) {
					first = false;
					return -1;
				}
				return 1;
			},
		} as unknown as Parameters<InstanceType<typeof ToolInputLaneSender>["send"]>[0];
		const identity = { narratorId, refId: ref.id, epoch: ref.epoch };
		sender.send(socket, "already-accepted", identity);
		sender.send(socket, "old-private-tail", identity);
		subscribed = false;
		await source(narratorId, "replacement body");
		buffered = 0;
		await flushed;
		expect(sent).toEqual(["already-accepted"]);
		sender.close(socket);
	});

	test("escaped Unicode frames fit 64KiB, share text once, and preserve exact UTF16 offsets", async () => {
		const text = "\ud800中\r\n".repeat(12000);
		const ref = await source(narratorId, text);
		const frames = [
			...toolInputFrames({
				type: "tool_use_chunk",
				narratorId,
				toolCallId: null,
				toolUseId: "provider-id",
				toolName: "Write",
				inputCharsTotal: text.length * 2,
				inputDocument: { ref: { ...ref, complete: true, preview: "never repeated" }, offset: 0 },
				streamingField: {
					name: "content",
					delta: text,
					offset: 0,
					startsField: true,
					complete: true,
				},
			}),
		];
		let actual = "";
		for (const [index, frame] of frames.entries()) {
			expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(TEXT_DOCUMENT_PACKET_BYTES);
			const parsed = JSON.parse(frame);
			expect(parsed.inputDocument.offset).toBe(actual.length);
			expect(parsed.streamingField.offset).toBe(actual.length);
			expect(parsed.streamingField.startsField).toBe(index === 0);
			expect(parsed.inputDocument.ref.preview).toBeUndefined();
			expect(parsed.streamingField.complete).toBe(index === frames.length - 1);
			actual += parsed.streamingField.delta;
		}
		expect(actual).toBe(text);
	});

	test("send(-1) is never repeated; only unsent later frames wait for drain", async () => {
		const sender = new ToolInputLaneSender();
		const sent: string[] = [];
		let buffered = 10;
		let first = true;
		let drained!: () => void;
		const finished = new Promise<void>((resolve) => {
			drained = resolve;
		});
		const socket = {
			getBufferedAmount: () => buffered,
			close: () => {
				throw new Error("unexpected close");
			},
			send: (data: unknown) => {
				sent.push(String(data));
				if (first) {
					first = false;
					return -1;
				}
				drained();
				return 10;
			},
		} as unknown as Parameters<InstanceType<typeof ToolInputLaneSender>["send"]>[0];
		expect(sender.send(socket, "accepted-by-bun")).toBe(true);
		expect(sender.send(socket, "unsent-later")).toBe(true);
		expect(sent).toEqual(["accepted-by-bun"]);
		buffered = 0;
		await finished;
		expect(sent).toEqual(["accepted-by-bun", "unsent-later"]);
		sender.close(socket);
	});

	test("bounded backlog disconnects slow socket only after complete source is recoverable", async () => {
		const ref = await source(narratorId, "full recoverable source");
		const sender = new ToolInputLaneSender(64);
		let closed = 0;
		const socket = {
			getBufferedAmount: () => 60,
			close: (code: number) => {
				closed = code;
			},
			send: () => -1,
		} as unknown as Parameters<InstanceType<typeof ToolInputLaneSender>["send"]>[0];
		expect(sender.send(socket, "exceeds backlog")).toBe(false);
		expect(closed).toBe(1013);
		expect((await service.getTextDocumentRange(narratorId, ref.id)).text).toBe(
			"full recoverable source",
		);
	});
});
