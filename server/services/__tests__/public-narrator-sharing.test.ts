import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createPublicShareClient } from "@frontend/lib/public-share-api";
import { PublicShareSession } from "@frontend/lib/public-share-session";
import type { CreatedPublicShare, PublicShareEvent } from "@shared/public-narrator-share";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import {
	aclGrants,
	narratorMessageRefs,
	narratorMessages,
	narratorPublicShares,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { createToken } from "../../lib/auth";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { requireSessionAuth } from "../../middleware/auth";
import {
	publicNarratorShareManagementRoutes,
	publicNarratorShareRoutes,
	readPublicShareJson,
} from "../../routes/public-narrator-shares";
import { PUBLIC_SHARE_LIMITS as L } from "../public-narrator-share-limits";
import { getPublicSharedTool, listPublicSharedMessages } from "../public-narrator-share-messages";
import {
	projectPublicLiveBlocks,
	projectPublicMessage,
	projectPublicToolDetail,
} from "../public-narrator-share-projection";
import { PublicShareRateLimiter } from "../public-narrator-share-rate-limit";
import {
	createPublicShare,
	hashPublicShareToken,
	listPublicShares,
	revalidatePublicShare,
	revokePublicShare,
	type VerifiedPublicShare,
	verifyPublicShare,
} from "../public-narrator-share-service";
import {
	PublicNarratorShareStreams,
	publicNarratorShareStreams,
} from "../public-narrator-share-stream";

// bunfig.toml's mandatory preload isolates NARRAFORK_HOME before these imports.
const now = "2026-09-08T00:00:00.000Z";
const owner = generateId();
const reader = generateId();
const admin = generateId();
const ownerPrincipal = { userId: owner, isAdmin: false };
const app = new Hono();
let sessionGateEntries = 0;
app.route("/api/public/narrator-shares", publicNarratorShareRoutes);
app.use("/api/*", async (_c, next) => {
	sessionGateEntries++;
	await next();
});
app.use("/api/*", requireSessionAuth);
app.route("/api/narrators", publicNarratorShareManagementRoutes);
app.get("/api/private", (c) => c.json({ private: true }));
app.onError((error, c) =>
	error instanceof AppError
		? c.json({ code: error.code }, error.statusCode as 400)
		: c.json({ error: String(error) }, 500),
);

beforeAll(() => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	for (const [id, role] of [
		[owner, "user"],
		[reader, "user"],
		[admin, "admin"],
	] as const)
		db.insert(users)
			.values({ id, username: `public-${id}`, passwordHash: "test", role, createdAt: now })
			.run();
});
afterEach(() => publicNarratorShareStreams.dispose());

function narrator(extra: Partial<typeof narrators.$inferInsert> = {}): string {
	const id = generateId();
	db.insert(narrators)
		.values({
			id,
			title: "A shared story",
			ownerUserId: owner,
			type: "primary",
			createdAt: now,
			updatedAt: now,
			...extra,
		})
		.run();
	return id;
}
function message(
	narratorId: string,
	seq: number,
	options: {
		role?: "user" | "assistant" | "system" | "sys" | "disp";
		origin?: "user" | "system" | "assistant";
		hidden?: boolean;
		compact?: boolean;
		parent?: string;
		text?: string;
		content?: unknown;
	} = {},
): string {
	const id = generateId();
	db.insert(narratorMessages)
		.values({
			id,
			narratorId,
			role: options.role ?? "assistant",
			origin: options.origin,
			parentToolUseId: options.parent,
			contentJson: options.content ?? [{ type: "text", text: options.text ?? `message-${seq}` }],
			contentText: "INTERNAL_FALLBACK_MUST_NOT_LEAK",
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: generateId(),
			narratorId,
			messageId: id,
			seq,
			isCompact: options.compact ? 1 : 0,
			segmentCompactId: options.hidden ? "compact-id" : null,
		})
		.run();
	return id;
}
function tool(
	narratorId: string,
	messageId: string,
	name = "Bash",
	output: unknown = {
		text: "safe result",
		credentialId: "PRIVATE-CREDENTIAL",
		resolvedFilePath: "PRIVATE-PATH",
	},
): string {
	const toolUseId = generateId();
	db.insert(narratorToolCalls)
		.values({
			id: generateId(),
			narratorId,
			messageId,
			toolUseId,
			toolName: name,
			status: "success",
			inputJson: { command: "pwd", device: "PRIVATE-DEVICE", credentialId: "PRIVATE-CREDENTIAL" },
			outputJson: output,
			createdAt: now,
		})
		.run();
	return toolUseId;
}
async function shared(narratorId = narrator()) {
	const created = await createPublicShare(narratorId, ownerPrincipal, { guestName: "Visitor" });
	const auth = verifyPublicShare(created.share.id, `Share ${created.token}`);
	return { ...created, auth, narratorId };
}
function request(
	share: CreatedPublicShare,
	suffix = "",
	options: { method?: string; body?: unknown; authorization?: string } = {},
) {
	return app.request(`/api/public/narrator-shares/${share.share.id}${suffix}`, {
		method: options.method ?? "GET",
		headers: {
			Authorization: options.authorization ?? `Share ${share.token}`,
			"Content-Type": "application/json",
		},
		...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
	});
}

describe("public share management and HTTP boundary", () => {
	test("only owner/admin manage, even a writer cannot reshare; subagents refuse", async () => {
		const id = narrator();
		db.insert(aclGrants)
			.values({
				id: generateId(),
				scopeType: "narrator",
				scopeId: id,
				principalType: "user",
				principalId: reader,
				capability: "write",
				grantedBy: owner,
				createdAt: now,
			})
			.run();
		for (const operation of [
			() => createPublicShare(id, { userId: reader, isAdmin: false }, { guestName: "Forged" }),
			() => listPublicShares(id, { userId: reader, isAdmin: false }, {}),
		])
			await expect(operation()).rejects.toMatchObject({ code: "PUBLIC_SHARE_UNAVAILABLE" });
		await expect(
			createPublicShare(id, { userId: admin, isAdmin: true }, { guestName: "Admin visitor" }),
		).resolves.toHaveProperty("token");
		const subagent = narrator({ type: "subagent", parentNarratorId: id, aclRootNarratorId: id });
		await expect(
			createPublicShare(subagent, ownerPrincipal, { guestName: "No" }),
		).rejects.toMatchObject({ code: "PUBLIC_SHARE_UNAVAILABLE" });
	});

	test("tokens are random, stored as SHA256 only; lists use stable cursor and never return hashes", async () => {
		const id = narrator();
		const a = await shared(id);
		const b = await shared(id);
		expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(a.share.id).toHaveLength(21);
		expect(a.token).not.toBe(b.token);
		const row = db
			.select()
			.from(narratorPublicShares)
			.where(eq(narratorPublicShares.id, a.share.id))
			.get();
		expect(row?.tokenHash).toBe(hashPublicShareToken(a.token));
		expect(JSON.stringify(row)).not.toContain(a.token);
		const first = await listPublicShares(id, ownerPrincipal, { limit: 1 });
		const second = await listPublicShares(id, ownerPrincipal, {
			limit: 1,
			cursor: first.nextCursor,
		});
		expect(first.hasMore).toBe(true);
		expect(second.hasMore).toBe(false);
		expect(new Set([...first.shares, ...second.shares].map((item) => item.id)).size).toBe(2);
		expect(JSON.stringify(first)).not.toContain("token");
	});

	test("missing, wrong, revoked, deleted and session credentials fail uniformly without SessionAuth fallback", async () => {
		const share = await shared();
		const jwt = await createToken(owner, "user");
		const baseline = sessionGateEntries;
		for (const authorization of ["", `Share ${"a".repeat(43)}`, `Bearer ${jwt}`, "Share short"]) {
			const response = await request(share, "", { authorization });
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				error: "Share link unavailable",
				code: "PUBLIC_SHARE_UNAVAILABLE",
			});
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}
		const missing = await app.request("/api/public/narrator-shares/not-a-share/unknown");
		expect(missing.status).toBe(404);
		const unknown = await request(share, "/not-real");
		expect(unknown.status).toBe(404);
		expect(sessionGateEntries).toBe(baseline);
		const privateResponse = await app.request("/api/private", {
			headers: { Authorization: `Share ${share.token}` },
		});
		expect(privateResponse.status).toBe(401);
		await revokePublicShare(share.narratorId, share.share.id, ownerPrincipal);
		await revokePublicShare(share.narratorId, share.share.id, ownerPrincipal);
		expect((await request(share)).status).toBe(404);
	});

	test("session DTO has no narrator/room/user ids; post rejects extra identity and oversized input", async () => {
		const share = await shared();
		const response = await request(share);
		expect(response.status).toBe(200);
		const info = await response.json();
		expect(Object.keys(info).sort()).toEqual([
			"guestName",
			"messageVersion",
			"shareId",
			"status",
			"title",
		]);
		expect(JSON.stringify(info)).not.toContain(share.narratorId);
		for (const body of [
			{ text: "hi", narratorId: share.narratorId },
			{ text: "hi", guestName: "Admin" },
			{ text: "x".repeat(L.discussionChars + 1) },
		])
			expect((await request(share, "/discussion", { method: "POST", body })).status).toBe(400);
		expect(
			(
				await request(share, "/discussion", {
					method: "POST",
					body: { text: "x".repeat(L.bodyBytes) },
				})
			).status,
		).toBe(413);
	});

	test("management routes require first-party auth and enforce owner checks", async () => {
		const share = await shared();
		const url = `/api/narrators/${share.narratorId}/public-shares`;
		expect(
			(await app.request(url, { headers: { Authorization: `Share ${share.token}` } })).status,
		).toBe(401);
		const ownerJwt = await createToken(owner, "user");
		const readerJwt = await createToken(reader, "user");
		expect(
			(await app.request(url, { headers: { Authorization: `Bearer ${ownerJwt}` } })).status,
		).toBe(200);
		expect(
			(await app.request(url, { headers: { Authorization: `Bearer ${readerJwt}` } })).status,
		).toBe(404);
	});
});

describe("read-only transcript projection", () => {
	test("fork ancestry respects exclusive cursor, compact visibility, local shadowing and no writes", async () => {
		const parent = narrator();
		message(parent, 1);
		const hidden = message(parent, 2, { hidden: true });
		message(parent, 3);
		message(parent, 4);
		message(parent, 5, { text: "PARENT-FUTURE" });
		const child = narrator({ refsInheritedFrom: parent, refsBackfillCursor: 5 });
		message(child, 3, { text: "LOCAL-COW" });
		message(child, 4, { hidden: true });
		message(child, 5, { text: "CHILD" });
		const share = await shared(child);
		const before = db
			.select({ value: sql<number>`count(*)` })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, child))
			.get()?.value;
		const page = listPublicSharedMessages(share.auth, {});
		expect(page.messages.map((item) => item.seq)).toEqual([1, 3, 5]);
		expect(page.messages.find((item) => item.seq === 3)?.text).toBe("LOCAL-COW");
		expect(JSON.stringify(page)).not.toContain("PARENT-FUTURE");
		expect(page.messages.map((item) => item.id)).not.toContain(hidden);
		expect(
			db
				.select({ value: sql<number>`count(*)` })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, child))
				.get()?.value,
		).toBe(before);
		expect(
			db
				.select({ version: narrators.messageVersion })
				.from(narrators)
				.where(eq(narrators.id, child))
				.get()?.version,
		).toBe(0);
	});

	test("three-generation lazy lineage narrows bounds and local hidden refs cannot reveal ancestor tools", async () => {
		const root = narrator();
		const a = message(root, 1);
		const visibleTool = tool(root, a);
		const b = message(root, 2);
		const hiddenTool = tool(root, b);
		message(root, 4, { text: "FUTURE" });
		const child = narrator({ refsInheritedFrom: root, refsBackfillCursor: 4 });
		message(child, 2, { hidden: true });
		const leaf = narrator({ refsInheritedFrom: child, refsBackfillCursor: 3 });
		const share = await shared(leaf);
		expect(listPublicSharedMessages(share.auth, {}).messages.map((item) => item.seq)).toEqual([1]);
		expect(getPublicSharedTool(share.auth, visibleTool).output).toBe("safe result");
		expect(() => getPublicSharedTool(share.auth, hiddenTool)).toThrow("Share link unavailable");
	});

	test("system/origin/team/subagent data stay hidden; bounded empty pages still advance", async () => {
		const share = await shared();
		message(share.narratorId, 1, { role: "user", text: "Human" });
		message(share.narratorId, 2, { role: "sys", text: "SYS" });
		message(share.narratorId, 3, { role: "user", origin: "system", text: "INJECT" });
		message(share.narratorId, 4, { role: "user", origin: "assistant", text: "TEAM" });
		message(share.narratorId, 5, { parent: "child-tool", text: "SUBAGENT" });
		message(share.narratorId, 6, { role: "system", compact: true, text: "COMPACT" });
		const first = listPublicSharedMessages(share.auth, { limit: 1 });
		expect(first.messages).toEqual([]);
		expect(first.hasMore).toBe(true);
		expect(first.nextBeforeSeq).toBe(5);
		const all = listPublicSharedMessages(share.auth, {});
		expect(all.messages.map((item) => item.text)).toEqual(["Human"]);
	});

	test("tools are tied to visible refs, allowlisted; details omit execution metadata", async () => {
		const share = await shared();
		const other = narrator();
		const m = message(share.narratorId, 1);
		const safe = tool(share.narratorId, m);
		const denied = tool(share.narratorId, m, "TeamStatus");
		const foreign = tool(other, message(other, 1));
		expect(
			listPublicSharedMessages(share.auth, {}).messages[0]?.tools.map((item) => item.id),
		).toEqual([safe]);
		const detail = getPublicSharedTool(share.auth, safe);
		expect(detail.input).toContain("pwd");
		expect(detail.output).toBe("safe result");
		expect(JSON.stringify(detail)).not.toContain("PRIVATE");
		for (const id of [foreign, denied]) expect(() => getPublicSharedTool(share.auth, id)).toThrow();
	});

	test("oversized structures are SQL-suppressed, response budget holds, version mismatch resets", async () => {
		const share = await shared();
		const giant = message(share.narratorId, 1, { text: "SECRET".repeat(L.messageJsonBytes) });
		const giantTool = tool(share.narratorId, giant, "Bash", {
			text: "RESULT".repeat(L.toolJsonBytes),
		});
		const page = listPublicSharedMessages(share.auth, {});
		expect(page.messages[0]).toMatchObject({ text: "", truncated: true });
		expect(getPublicSharedTool(share.auth, giantTool)).toMatchObject({
			output: "",
			truncated: true,
		});
		for (let seq = 2; seq <= 100; seq++)
			message(share.narratorId, seq, { text: "\u0001".repeat(4_000) });
		const bounded = listPublicSharedMessages(share.auth, { limit: 100 });
		expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(L.responseBytes);
		expect(bounded.hasMore).toBe(true);
		expect(bounded.nextBeforeSeq).not.toBeNull();
		db.update(narrators).set({ messageVersion: 1 }).where(eq(narrators.id, share.narratorId)).run();
		expect(() => listPublicSharedMessages(share.auth, { messageVersion: 0 })).toThrow(
			"Transcript changed",
		);
	});
});

describe("projection whitelist and independent budgets", () => {
	test("text/reasoning/media only, no system blocks, references, payloads or replay metadata", () => {
		const projected = projectPublicMessage({
			id: "m",
			seq: 1,
			role: "assistant",
			createdAt: now,
			json: JSON.stringify([
				{ type: "text", text: "Hello", fileReferenceContext: { cwd: "PRIVATE" } },
				{ type: "thinking", thinking: "Reason", signature: "PRIVATE" },
				{ type: "image", source: { data: "PRIVATE" } },
				{ type: "system", text: "PRIVATE" },
				{ type: "permission_request", text: "PRIVATE" },
			]),
		});
		expect(projected).toMatchObject({ text: "Hello", reasoning: "Reason", mediaOmitted: true });
		expect(JSON.stringify(projected)).not.toContain("PRIVATE");
		const snapshot = projectPublicLiveBlocks([
			{ type: "text", text: "hello", fileReferenceContext: "PRIVATE" },
			{ type: "image_generation", result: "PRIVATE" },
		]);
		expect(snapshot.blocks).toHaveLength(1);
		expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
		expect(
			projectPublicLiveBlocks([{ type: "text", text: "x".repeat(L.liveTextChars + 1) }]).truncated,
		).toBe(true);
		const detail = projectPublicToolDetail({
			toolUseId: "task",
			toolName: "Task",
			status: "pending",
			input: JSON.stringify({ description: "Summary", prompt: "PRIVATE", device: "PRIVATE" }),
			output: JSON.stringify({ result: "Done", subagentNarratorId: "PRIVATE" }),
			inputOmitted: false,
			outputOmitted: false,
		});
		expect(detail).toMatchObject({ output: "Done", status: "waiting" });
		expect(JSON.stringify(detail)).not.toContain("PRIVATE");
	});

	test("IP, link read, post and connect limits are independent, bounded and reclaimed", () => {
		const limiter = new PublicShareRateLimiter();
		for (let i = 0; i < 20; i++) limiter.consume("post", "link-A", 1000);
		expect(() => limiter.consume("post", "link-A", 1000)).toThrow();
		expect(() => limiter.consume("post", "link-B", 1000)).not.toThrow();
		expect(() => limiter.consume("read", "link-A", 1000)).not.toThrow();
		for (let i = 0; i < 120; i++) limiter.consume("ip", "ip-A", 1000);
		expect(() => limiter.consume("ip", "ip-A", 1000)).toThrow();
		for (let i = 0; i < 30; i++) limiter.consume("connect", "link-A", 1000);
		expect(() => limiter.consume("connect", "link-A", 1000)).toThrow();
		const bounded = new PublicShareRateLimiter();
		for (let i = 0; i < L.rateKeys + 500; i++) {
			try {
				bounded.consume("ip", `ip-${i}`, 1000);
			} catch {
				/* Overflow bucket exhausts. */
			}
		}
		expect(bounded.size).toBeLessThanOrEqual(L.rateKeys);
		bounded.consume("ip", "new", L.rateExpiryMs + 1001);
		expect(bounded.size).toBe(1);
	});
});

function fakeAuth(shareId = "share", narratorId = "narrator"): VerifiedPublicShare {
	return { shareId, narratorId, tokenHash: "hash", roomId: "room", guestName: "Visitor" };
}
function streamHarness(snapshot: readonly unknown[] = [], lineage: readonly string[] = []) {
	let clock = 1_000;
	let subscriptions = 0;
	let snapshots = 0;
	let validates = 0;
	const revoked = new Set<string>();
	const streams = new PublicNarratorShareStreams({
		lineage: () => lineage,
		snapshot: () => {
			snapshots++;
			return snapshot;
		},
		validate: (auth) => {
			validates++;
			if (revoked.has(auth.shareId)) throw new Error("revoked");
			return auth;
		},
		subscribe: () => {
			subscriptions++;
			return () => {
				subscriptions--;
			};
		},
		subscribeRevoked: () => () => {},
		now: () => clock,
	});
	return {
		streams,
		revoked,
		advance: (ms: number) => {
			clock += ms;
			streams.tick();
		},
		counters: () => ({ subscriptions, snapshots, validates }),
	};
}
async function nextEvent(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<PublicShareEvent> {
	const result = await reader.read();
	if (result.done) throw new Error("Unexpected stream end");
	expect(result.value.byteLength).toBeLessThanOrEqual(L.frameBytes);
	return JSON.parse(
		new TextDecoder()
			.decode(result.value)
			.replace(/^data: /, "")
			.trim(),
	);
}
function delta(
	streams: PublicNarratorShareStreams,
	text: string,
	extra: Record<string, unknown> = {},
) {
	streams.accept({
		type: "narrator:message_broadcast",
		narratorId: "narrator",
		message: {
			type: "stream_event",
			event: {
				type: "content_block_delta",
				delta: { type: "text_delta", id: "block", text },
				...extra,
			},
		},
	});
}

describe("SSE lifecycle, consistency and backpressure", () => {
	test("real HTTP/SSE and the real public frontend agree on startup, discussion and revocation", async () => {
		const a = await shared();
		const b = await shared(a.narratorId);
		message(a.narratorId, 1, { text: "wire-boundary transcript" });
		const originalFetch = globalThis.fetch;
		const paths: string[] = [];
		globalThis.fetch = Object.assign(
			((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const req =
					input instanceof Request
						? new Request(input, init)
						: new Request(new URL(String(input), "http://share.test"), init);
				paths.push(new URL(req.url).pathname);
				return Promise.resolve(app.request(req));
			}) as typeof fetch,
			{ preconnect: originalFetch.preconnect },
		);
		const first = new PublicShareSession(createPublicShareClient(a.share.id, a.token));
		const second = new PublicShareSession(createPublicShareClient(b.share.id, b.token));
		const until = (store: PublicShareSession, predicate: () => boolean) =>
			new Promise<void>((resolve, reject) => {
				let unsubscribe = () => {};
				const timer = setTimeout(() => {
					unsubscribe();
					reject(new Error(`Public wire state did not settle: ${store.getSnapshot().phase}`));
				}, 2500);
				const inspect = () => {
					if (!predicate()) return;
					clearTimeout(timer);
					unsubscribe();
					resolve();
				};
				unsubscribe = store.subscribe(inspect);
				inspect();
			});
		try {
			first.start();
			second.start();
			for (const store of [first, second]) {
				await until(
					store,
					() =>
						store.getSnapshot().phase === "live" &&
						!!store.getSnapshot().discussion &&
						store.getSnapshot().messages?.messages[0]?.text === "wire-boundary transcript",
				);
			}
			expect(await first.post("wire-boundary discussion")).toBe(true);
			await until(
				second,
				() =>
					second
						.getSnapshot()
						.discussion?.messages.some((row) => row.text === "wire-boundary discussion") === true,
			);
			expect(second.getSnapshot().discussion?.messages.at(-1)?.author).toMatchObject({
				isGuest: true,
				isSelf: false,
			});
			await revokePublicShare(a.narratorId, a.share.id, ownerPrincipal);
			await until(first, () => first.getSnapshot().phase === "unavailable");
			expect(first.getSnapshot().messages).toBeNull();
			expect(second.getSnapshot().phase).toBe("live");
			expect(paths.every((path) => path.startsWith("/api/public/narrator-shares/"))).toBe(true);
		} finally {
			first.stop();
			second.stop();
			globalThis.fetch = originalFetch;
		}
	});

	test("snapshot registration and late subscribers do not replay buffered deltas; no per-chunk DB checks", async () => {
		const h = streamHarness([
			{ type: "text", id: "block", text: "A", fileReferenceContext: "PRIVATE" },
		]);
		try {
			const a = h.streams.open(fakeAuth(), "ip1").getReader();
			expect(await nextEvent(a)).toMatchObject({
				type: "snapshot",
				blocks: [{ id: "block", kind: "text", text: "A" }],
			});
			const checks = h.counters().validates;
			for (let i = 0; i < 10; i++) delta(h.streams, "B");
			expect(h.counters().validates).toBe(checks);
			const b = h.streams.open(fakeAuth("other"), "ip2").getReader();
			expect(await nextEvent(b)).toMatchObject({
				type: "snapshot",
				blocks: [{ id: "block", kind: "text", text: `A${"B".repeat(10)}` }],
			});
			h.streams.flush();
			expect(await nextEvent(a)).toEqual({
				type: "delta",
				blockId: "block",
				kind: "text",
				text: "B".repeat(10),
				offset: 1,
			});
			expect(h.counters().snapshots).toBe(1);
			expect(h.counters().subscriptions).toBe(1);
			delta(h.streams, "C");
			h.streams.flush();
			expect(await nextEvent(b)).toMatchObject({ type: "delta", offset: 11, text: "C" });
			await a.cancel();
			await b.cancel();
			expect(h.streams.stats).toMatchObject({
				connections: 0,
				hubs: 0,
				shares: 0,
				ips: 0,
				listening: false,
				queuedBytes: 0,
			});
		} finally {
			h.streams.dispose();
		}
	});

	test("closed whitelist ignores permissions, subagents and foreign discussion rooms", async () => {
		const h = streamHarness();
		try {
			const reader = h.streams.open(fakeAuth(), "ip").getReader();
			expect((await nextEvent(reader))?.type).toBe("snapshot");
			delta(h.streams, "PRIVATE", { subagentToolUseId: "child" });
			h.streams.accept({
				type: "narrator:message_broadcast",
				narratorId: "narrator",
				message: { type: "permission_request", request: "PRIVATE" },
			});
			h.streams.accept({
				type: "chat:message_created",
				narratorId: "narrator",
				roomId: "foreign",
				text: "PRIVATE",
			});
			h.streams.flush();
			expect(h.streams.stats.queuedBytes).toBe(0);
			h.streams.accept({
				type: "chat:message_deleted",
				narratorId: "narrator",
				roomId: "room",
				messageId: "PRIVATE",
			});
			h.streams.flush();
			expect(await nextEvent(reader)).toEqual({ type: "invalidate", scope: "discussion" });
			await reader.cancel();
		} finally {
			h.streams.dispose();
		}
	});

	test("committed revoke clears queued payloads for A while B remains usable", async () => {
		const h = streamHarness();
		try {
			const a = h.streams.open(fakeAuth("A"), "ip-A").getReader();
			const b = h.streams.open(fakeAuth("B"), "ip-B").getReader();
			expect((await nextEvent(a))?.type).toBe("snapshot");
			expect((await nextEvent(b))?.type).toBe("snapshot");
			delta(h.streams, "queued");
			h.streams.flush();
			h.revoked.add("A");
			h.streams.revoke("A");
			expect(await nextEvent(a)).toEqual({ type: "revoked" });
			expect((await a.read()).done).toBe(true);
			expect(await nextEvent(b)).toMatchObject({ type: "delta", text: "queued" });
			expect(() => h.streams.open(fakeAuth("A"), "another-ip")).toThrow();
			await b.cancel();
		} finally {
			h.streams.dispose();
		}
	});

	test("revalidates queued data on pull even without an in-process revocation event", async () => {
		const h = streamHarness();
		try {
			const reader = h.streams.open(fakeAuth(), "ip").getReader();
			expect((await nextEvent(reader))?.type).toBe("snapshot");
			delta(h.streams, "PRIVATE queued");
			h.streams.flush();
			h.revoked.add("share");
			expect(await nextEvent(reader)).toEqual({ type: "revoked" });
			expect(h.streams.stats.connections).toBe(0);
		} finally {
			h.streams.dispose();
		}
	});

	test("per-link/per-IP/global limits and aborted/stalled/expired streams release resources", () => {
		const h = streamHarness();
		try {
			for (let i = 0; i < L.connectionsPerShare; i++) h.streams.open(fakeAuth(), `ip-${i}`);
			expect(() => h.streams.open(fakeAuth(), "fresh-ip")).toThrow();
			h.streams.dispose();
			for (let i = 0; i < L.connectionsPerIp; i++) h.streams.open(fakeAuth(`s-${i}`), "same-ip");
			expect(() => h.streams.open(fakeAuth("fresh"), "same-ip")).toThrow();
			h.streams.dispose();
			for (let i = 0; i < L.connectionsTotal; i++) h.streams.open(fakeAuth(`s-${i}`), `ip-${i}`);
			expect(() => h.streams.open(fakeAuth("fresh"), "fresh-ip")).toThrow();
			h.streams.dispose();
			const signal = new AbortController();
			h.streams.open(fakeAuth(), "ip", signal.signal);
			signal.abort();
			expect(h.streams.stats.connections).toBe(0);
			h.streams.open(fakeAuth(), "ip");
			h.advance(L.stallMs);
			expect(h.streams.stats.connections).toBe(0);
			h.streams.open(fakeAuth(), "ip");
			h.advance(L.connectionMs);
			expect(h.streams.stats.connections).toBe(0);
			expect(h.counters().subscriptions).toBe(0);
		} finally {
			h.streams.dispose();
		}
	});

	test("real SSE root revalidates DB and synchronously kills only the revoked share", async () => {
		const a = await shared();
		const b = await shared(a.narratorId);
		const responseA = await request(a, "/events");
		const responseB = await request(b, "/events");
		expect(responseA.headers.get("Content-Type")).toContain("text/event-stream");
		if (!responseA.body || !responseB.body) throw new Error("Missing SSE body");
		const readerA = responseA.body.getReader();
		const readerB = responseB.body.getReader();
		expect((await nextEvent(readerA))?.type).toBe("snapshot");
		expect((await nextEvent(readerB))?.type).toBe("snapshot");
		await revokePublicShare(a.narratorId, a.share.id, ownerPrincipal);
		expect(await nextEvent(readerA)).toEqual({ type: "revoked" });
		expect(publicNarratorShareStreams.stats.connections).toBe(1);
		expect(revalidatePublicShare(b.auth).shareId).toBe(b.share.id);
		await readerB.cancel();
	});
});

describe("sharing adversarial resource and concurrency boundaries", () => {
	test("dishonest/chunked content length is bounded and an aborted body cancels upstream", async () => {
		let cancelled = false;
		const giant = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(new Uint8Array(L.bodyBytes + 1));
				},
				cancel() {
					cancelled = true;
				},
			},
			{ highWaterMark: 0 },
		);
		await expect(
			readPublicShareJson(
				new Request("http://localhost", {
					method: "POST",
					headers: { "Content-Length": "2" },
					body: giant,
				}),
			),
		).rejects.toMatchObject({ code: "PUBLIC_SHARE_BODY_LIMIT" });
		expect(cancelled).toBe(true);
		let interrupted = false;
		const abort = new AbortController();
		const pending = readPublicShareJson(
			new Request("http://localhost", {
				method: "POST",
				signal: abort.signal,
				body: new ReadableStream({
					cancel() {
						interrupted = true;
					},
				}),
			}),
		);
		abort.abort();
		await expect(pending).rejects.toMatchObject({ code: "PUBLIC_SHARE_BODY_TIMEOUT" });
		expect(interrupted).toBe(true);
	});

	test("revocation while a guest request waits for its body prevents the write", async () => {
		const share = await shared();
		let began: () => void = () => {};
		const reading = new Promise<void>((resolve) => {
			began = resolve;
		});
		let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					bodyController = controller;
				},
				pull() {
					began();
				},
			},
			{ highWaterMark: 0 },
		);
		const response = app.request(`/api/public/narrator-shares/${share.share.id}/discussion`, {
			method: "POST",
			headers: { Authorization: `Share ${share.token}`, "Content-Type": "application/json" },
			body,
		});
		await reading;
		await revokePublicShare(share.narratorId, share.share.id, ownerPrincipal);
		if (!bodyController) throw new Error("Missing body controller");
		bodyController.enqueue(new TextEncoder().encode(JSON.stringify({ text: "Must not persist" })));
		bodyController.close();
		expect((await response).status).toBe(404);
	});

	test("narrator deletion invalidates capability and queued SSE without restart", async () => {
		const share = await shared();
		const stream = publicNarratorShareStreams.open(share.auth, "delete-test").getReader();
		expect((await nextEvent(stream))?.type).toBe("snapshot");
		db.delete(narrators).where(eq(narrators.id, share.narratorId)).run();
		expect(() => revalidatePublicShare(share.auth)).toThrow();
		publicNarratorShareStreams.accept({
			type: "narrator:message_broadcast",
			narratorId: share.narratorId,
			message: { type: "message_updated", message: "PRIVATE" },
		});
		publicNarratorShareStreams.flush();
		expect(await nextEvent(stream)).toMatchObject({ type: "reset" });
		expect(publicNarratorShareStreams.stats.connections).toBe(0);
	});

	test("ancestor version changes reset cross-page requests and match the session version", async () => {
		const parent = narrator();
		message(parent, 1);
		message(parent, 2);
		const child = narrator({ refsInheritedFrom: parent, refsBackfillCursor: 3 });
		const share = await shared(child);
		const first = listPublicSharedMessages(share.auth, { limit: 1 });
		expect((await (await request(share)).json()).messageVersion).toBe(first.messageVersion);
		db.update(narrators).set({ messageVersion: 1 }).where(eq(narrators.id, parent)).run();
		expect(() =>
			listPublicSharedMessages(share.auth, {
				beforeSeq: first.nextBeforeSeq,
				messageVersion: first.messageVersion,
			}),
		).toThrow("Transcript changed");
		expect(listPublicSharedMessages(share.auth, {}).messageVersion).not.toBe(first.messageVersion);
	});

	test("ancestor events invalidate only virtual history, never expose ancestor live output", async () => {
		const h = streamHarness([], ["narrator", "ancestor"]);
		try {
			const reader = h.streams.open(fakeAuth(), "ip").getReader();
			expect((await nextEvent(reader))?.type).toBe("snapshot");
			h.streams.accept({
				type: "narrator:message_broadcast",
				narratorId: "ancestor",
				message: {
					type: "stream_event",
					event: { type: "content_block_delta", delta: { type: "text_delta", text: "PRIVATE" } },
				},
			});
			h.streams.flush();
			expect(h.streams.stats.queuedBytes).toBe(0);
			h.streams.accept({
				type: "narrator:message_broadcast",
				narratorId: "ancestor",
				message: { type: "compact_done", summary: "PRIVATE" },
			});
			h.streams.flush();
			expect(await nextEvent(reader)).toEqual({ type: "invalidate", scope: "messages" });
			expect(await nextEvent(reader)).toEqual({ type: "invalidate", scope: "session" });
			await reader.cancel();
		} finally {
			h.streams.dispose();
		}
	});

	test("queue overflow drops all pending transcript content and emits a bounded reset", async () => {
		const h = streamHarness([
			{ type: "text", id: "block", text: "\u0001".repeat(L.liveTextChars) },
		]);
		try {
			const reader = h.streams.open(fakeAuth(), "ip").getReader();
			expect((await nextEvent(reader))?.type).toBe("snapshot");
			for (let i = 0; i < 12; i++) {
				h.streams.accept({
					type: "narrator:message_broadcast",
					narratorId: "narrator",
					message: { type: "message_updated" },
				});
				h.streams.flush();
				expect(h.streams.stats.queuedBytes).toBeLessThanOrEqual(L.queueBytes);
			}
			expect(await nextEvent(reader)).toEqual({ type: "reset" });
			expect((await reader.read()).done).toBe(true);
			expect(h.streams.stats).toMatchObject({ connections: 0, queuedBytes: 0, listening: false });
		} finally {
			h.streams.dispose();
		}
	});
});
