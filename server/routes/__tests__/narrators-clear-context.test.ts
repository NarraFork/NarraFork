import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { narratorMessageRefs, narratorMessages, narrators, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import type { ActiveNarrator } from "../../services/narrator-session-state";

// Load the route/service graph before importing the request identity helper.
const { narratorRoutes } = await import("../narrators");
const { ensureConversationIdentityPersisted } = await import(
	"../../services/narrator-conversation-identity"
);
const { activeNarrators } = await import("../../services/narrator-session-state");

const ownerId = generateId();
const activeIds = new Set<string>();
const conversationId = "clear-context-cache-identity";

beforeAll(async () => {
	await db.insert(users).values({
		id: ownerId,
		username: ownerId,
		passwordHash: "fixture",
		role: "user",
		createdAt: new Date().toISOString(),
	});
});
afterEach(() => {
	for (const id of activeIds) activeNarrators.delete(id);
	activeIds.clear();
});

async function fixture() {
	const narratorId = generateId();
	const earlierMessageId = generateId();
	const anchorId = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: narratorId,
		ownerUserId: ownerId,
		visibility: "private",
		writeAudience: "owner",
		variant: "primary",
		status: "idle",
		apiConversationId: conversationId,
		createdAt: now,
		updatedAt: now,
	});
	for (const [index, id] of [earlierMessageId, anchorId].entries()) {
		await db.insert(narratorMessages).values({
			id,
			narratorId,
			role: "user",
			contentJson: [{ type: "text", text: `Message ${index + 1}` }],
			createdAt: now,
		});
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId,
			messageId: id,
			seq: index + 1,
		});
	}
	const active = {
		narratorId,
		alive: true,
		abortController: new AbortController(),
		conversationId,
		_persistedConversationId: conversationId,
	} as ActiveNarrator;
	activeIds.add(narratorId);
	activeNarrators.set(narratorId, active);
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: ownerId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		throw error;
	});
	app.route("/narrators", narratorRoutes);
	return { app, narratorId, earlierMessageId, anchorId, active };
}

async function storedConversationId(narratorId: string) {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { apiConversationId: true },
	});
	if (!row) throw new Error("Narrator missing");
	return row.apiConversationId;
}

for (const anchored of [false, true]) {
	describe(anchored ? "clear context before a message" : "clear the entire context", () => {
		for (const sameId of [true, false]) {
			const identity = sameId ? "retained" : "replacement";
			test(`persists the ${identity} conversation ID after clearing`, async () => {
				const { app, narratorId, earlierMessageId, anchorId, active } = await fixture();
				const response = await app.request(`/narrators/${narratorId}/clear-context`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(anchored ? { beforeMessageId: anchorId } : {}),
				});
				expect(response.status).toBe(200);
				const body = await response.json();
				expect(body).toEqual({ ok: true, messageId: expect.any(String) });
				expect(await storedConversationId(narratorId)).toBeNull();
				expect(active._resetUpstreamSessionOnNextRequest).toBe(true);
				expect(active.conversationId).toBe(conversationId);
				expect(active._persistedConversationId).toBeNull();

				const refs = await db.query.narratorMessageRefs.findMany({
					where: eq(narratorMessageRefs.narratorId, narratorId),
					orderBy: asc(narratorMessageRefs.seq),
				});
				expect(refs.map((ref) => ref.messageId)).toEqual(
					anchored
						? [earlierMessageId, body.messageId, anchorId]
						: [earlierMessageId, anchorId, body.messageId],
				);
				expect(refs.find((ref) => ref.messageId === body.messageId)?.isCompact).toBe(1);

				// Claim the request identity against the cleared durable baseline and history revision.
				const nextId = sameId ? conversationId : "clear-context-replacement-identity";
				active.conversationId = nextId;
				await ensureConversationIdentityPersisted(narratorId, active);
				expect(await storedConversationId(narratorId)).toBe(nextId);
				expect(active._persistedConversationId).toBe(nextId);
			});
		}
	});
}
