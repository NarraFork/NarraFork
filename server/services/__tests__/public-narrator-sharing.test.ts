import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createPublicShareClient } from "@frontend/lib/public-share-api";
import { PublicShareSession } from "@frontend/lib/public-share-session";
import type { CreatedPublicShare } from "@shared/public-narrator-share";
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

	test("session DTO carries the ids the client needs but no user ids; post rejects extras", async () => {
		const share = await shared();
		const response = await request(share);
		expect(response.status).toBe(200);
		const info = await response.json();
		expect(Object.keys(info).sort()).toEqual([
			"guestName",
			"messageVersion",
			"narratorId",
			"roomId",
			"shareId",
			"status",
			"title",
		]);
		expect(JSON.stringify(info)).not.toMatch(/"ownerId"|"userId"|"creatorId"/);
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
