/**
 * Model card API.
 *
 * The properties worth pinning here are the ones a unit test on the merge/diff
 * functions cannot see, because they only hold if the route wires them up:
 *
 *  - a client PUTs a WHOLE card, but only the difference from builtin data may be
 *    persisted. If the route stored what it received, every field of every edited
 *    card would be pinned against future builtin updates — the exact thing the
 *    diff-storage design exists to prevent, and entirely invisible until a
 *    release changed a builtin value and the change failed to appear.
 *  - deleting a builtin card must leave a tombstone, or the next load resurrects it.
 *  - reset must REMOVE the delta, not write the builtin values back as a delta.
 *  - reads are open to any authenticated user (the reasoning-tier menu needs
 *    them) while writes are admin-only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { settings } from "../../lib/settings";
import { modelCardRoutes } from "../model-cards";

function app(role: "admin" | "user" = "admin"): Hono {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: "user-model-cards", role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.route("/api/model-cards", modelCardRoutes);
	instance.onError(
		(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
	);
	return instance;
}

let savedCards: typeof settings.agent.modelCards;

beforeEach(() => {
	savedCards = settings.agent.modelCards;
	settings.agent.modelCards = [];
});

afterEach(() => {
	settings.agent.modelCards = savedCards;
});

async function getCards(role: "admin" | "user" = "admin") {
	const res = await app(role).request("/api/model-cards");
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function putCard(card: Record<string, unknown>, role: "admin" | "user" = "admin") {
	const res = await app(role).request(
		`/api/model-cards/${encodeURIComponent(String(card.modelKey))}`,
		{
			method: "PUT",
			body: JSON.stringify(card),
			headers: { "content-type": "application/json" },
		},
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/model-cards", () => {
	test("returns builtin cards to a non-admin user", async () => {
		const { status, body } = await getCards("user");
		expect(status).toBe(200);
		const cards = body.cards as Array<{ modelKey: string }>;
		expect(cards.length).toBeGreaterThan(0);
		expect(cards.some((c) => c.modelKey === "gpt-5.5")).toBe(true);
	});

	test("provenance is empty when nothing has been edited", async () => {
		const { body } = await getCards();
		expect(body.provenance).toEqual({});
	});
});

describe("PUT /api/model-cards/:key stores only the difference", () => {
	test("a whole-card submission persists only the changed field", async () => {
		const { body: before } = await getCards();
		const original = (before.cards as Array<Record<string, unknown>>).find(
			(c) => c.modelKey === "gpt-5.5",
		);
		expect(original).toBeDefined();

		// Submit the card unchanged except for one field, exactly as the editor does.
		const { status } = await putCard({ ...original, contextWindow: 123_456 });
		expect(status).toBe(200);

		// Only that one field may reach settings.json.
		expect(settings.agent.modelCards).toEqual([{ modelKey: "gpt-5.5", contextWindow: 123_456 }]);
	});

	test("the edited value and the inherited ones both come back", async () => {
		const { body: before } = await getCards();
		const original = (before.cards as Array<Record<string, unknown>>).find(
			(c) => c.modelKey === "gpt-5.5",
		);
		await putCard({ ...original, contextWindow: 123_456 });

		const { body: after } = await getCards();
		const card = (after.cards as Array<Record<string, unknown>>).find(
			(c) => c.modelKey === "gpt-5.5",
		);
		expect(card?.contextWindow).toBe(123_456);
		expect(card?.maxCompletionTokens).toBe(original?.maxCompletionTokens);
		expect((after.provenance as Record<string, string[]>)["gpt-5.5"]).toEqual(["contextWindow"]);
	});

	test("submitting an unchanged card stores nothing", async () => {
		const { body } = await getCards();
		const original = (body.cards as Array<Record<string, unknown>>).find(
			(c) => c.modelKey === "gpt-5.5",
		);
		const { status } = await putCard({ ...original });
		expect(status).toBe(200);
		expect(settings.agent.modelCards).toEqual([]);
	});

	test("a new key is stored whole", async () => {
		const { status } = await putCard({
			modelKey: "my-own-model",
			contextWindow: 4096,
			family: "custom",
		});
		expect(status).toBe(200);
		expect(settings.agent.modelCards).toHaveLength(1);
		expect(settings.agent.modelCards?.[0]).toMatchObject({
			modelKey: "my-own-model",
			contextWindow: 4096,
			family: "custom",
		});
	});

	test("the path key wins over a mismatched body key", async () => {
		// Otherwise a mismatch would silently write a different card than the URL
		// names, and the client would look up the result under the wrong key.
		const res = await app().request("/api/model-cards/path-key", {
			method: "PUT",
			body: JSON.stringify({ modelKey: "body-key", contextWindow: 10 }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(settings.agent.modelCards?.[0]?.modelKey).toBe("path-key");
	});

	test("a tier list containing none is refused rather than silently trimmed", async () => {
		// `none` means thinking off. As a clamp target it could turn a requested
		// `low` into reasoning being disabled, so it must not be storable.
		const { status } = await putCard({
			modelKey: "tier-test",
			effortLevels: ["none", "high"],
		});
		expect(status).toBe(400);
		expect(settings.agent.modelCards).toEqual([]);
	});

	test("a non-admin cannot write", async () => {
		const { status } = await putCard({ modelKey: "nope", contextWindow: 1 }, "user");
		expect(status).toBe(403);
		expect(settings.agent.modelCards).toEqual([]);
	});
});

describe("DELETE /api/model-cards/:key", () => {
	test("deleting a builtin card records a tombstone", async () => {
		const res = await app().request("/api/model-cards/gpt-5.5", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(settings.agent.modelCards).toEqual([{ modelKey: "gpt-5.5", deleted: true }]);

		// And it must actually stay gone once merged back.
		const { body } = await getCards();
		const cards = body.cards as Array<{ modelKey: string }>;
		expect(cards.some((c) => c.modelKey === "gpt-5.5")).toBe(false);
	});

	test("deleting an unknown key reports that nothing was deleted", async () => {
		const res = await app().request("/api/model-cards/not-a-real-card", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, deleted: false });
		expect(settings.agent.modelCards).toEqual([]);
	});
});

describe("POST /api/model-cards/:key/reset", () => {
	test("reset removes the delta instead of writing builtin values back", async () => {
		const { body } = await getCards();
		const original = (body.cards as Array<Record<string, unknown>>).find(
			(c) => c.modelKey === "gpt-5.5",
		);
		await putCard({ ...original, contextWindow: 1 });
		expect(settings.agent.modelCards).toHaveLength(1);

		const res = await app().request("/api/model-cards/gpt-5.5/reset", { method: "POST" });
		expect(res.status).toBe(200);
		// An empty delta list is the point: storing the builtin values as a delta
		// would pin them against future builtin updates.
		expect(settings.agent.modelCards).toEqual([]);
		const restored = (await res.json()) as { card: { contextWindow: number } | null };
		expect(restored.card?.contextWindow).toBe(original?.contextWindow as number);
	});

	test("reset also lifts a tombstone", async () => {
		await app().request("/api/model-cards/gpt-5.5/reset", { method: "POST" });
		await app().request("/api/model-cards/gpt-5.5", { method: "DELETE" });
		expect(settings.agent.modelCards).toEqual([{ modelKey: "gpt-5.5", deleted: true }]);

		await app().request("/api/model-cards/gpt-5.5/reset", { method: "POST" });
		const { body } = await getCards();
		const cards = body.cards as Array<{ modelKey: string }>;
		expect(cards.some((c) => c.modelKey === "gpt-5.5")).toBe(true);
	});
});
