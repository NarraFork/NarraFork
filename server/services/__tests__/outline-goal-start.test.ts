/**
 * `/goal` sent to an idle outline session through the HTTP route (outline P2 PR 5): the goal's
 * first turn starts at once, even when continuation is off, and takes up the goal (in progress,
 * held by the session); in plan mode the goal is written and nothing starts. A model stand-in
 * answers the turn (the provider module is replaced for this file, as in
 * `narrator-session-goal-continuation.test.ts`).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; each case makes its own session.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { modelInputText, requestInput, rowsAsHistory } from "../../../tests/fixtures/model-input";
import { narratorMessageRefs, narratorMessages, narrators, users } from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import { AppError } from "../../lib/errors";

const { db } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");

// Bun's mock.module is process-wide; the real module is put back after this file.
const realProviderModule = { ...(await import("../../lib/agent/provider")) };
const providerInputs: string[] = [];
const testProvider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: rowsAsHistory,
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerInputs.push(`${modelInputText(params as never)}\n${requestInput(params)}`);
		params.onRequestStart?.();
		yield { text: "goal turn ran" };
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
mock.module("../../lib/agent/provider", () => ({
	getProvider: () => testProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "openai",
		requestedModel: "openai:test-model",
		provider: "openai",
		adapter: testProvider,
		model: "test-model",
	}),
}));

const { narratorRoutes } = await import("../../routes/narrators");
const { settings } = await import("../../lib/settings");
const { closeNarrator } = await import("../narrator-session");
const { outlineStore } = await import("../outline/store");
const { OUTLINE_TASKS_PAGE_ALIAS } = await import("../outline/person-tasks");
const { invalidateTaskBackend } = await import("../task-source");

const NOW = "2026-11-03T00:00:00.000Z";
const OWNER = `goal-start-${Date.now()}`;

afterAll(async () => {
	await closePrefixSnapshotStore();
	mock.module("../../lib/agent/provider", () => realProviderModule);
	mock.restore();
});

beforeEach(async () => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	providerInputs.length = 0;
	if (!(await db.query.users.findFirst({ where: eq(users.id, OWNER) }))) {
		await db.insert(users).values({
			id: OWNER,
			username: OWNER,
			passwordHash: "x",
			role: "user",
			createdAt: NOW,
		});
	}
});

function app() {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: OWNER, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.onError((error) => {
		const status = error instanceof AppError ? error.statusCode : 500;
		return new Response(JSON.stringify({ error: error.message }), { status });
	});
	instance.route("/narrators", narratorRoutes);
	return instance;
}

async function session(options: { traits?: string[] } = {}): Promise<string> {
	const id = `goal-start-${crypto.randomUUID()}`;
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: options.traits ?? ["standalone"],
		model: "openai:test-model",
		permissionMode: "bypassPermissions",
		autoContinuationOverride: "off",
		status: "idle",
		taskBackend: "outline",
		ownerUserId: OWNER,
		visibility: "private",
		cwd: process.cwd(),
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function goals(narratorId: string) {
	const space = await outlineStore.findSpace({ kind: "session", narratorId });
	if (!space) return [];
	const [page] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	return page ? await outlineStore.listChildren(space.id, page.id, 10) : [];
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("timed out");
}

async function messageBlocks(narratorId: string): Promise<Array<Record<string, unknown>>> {
	const rows = await db
		.select({ json: narratorMessages.contentJson })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.flatMap((row) => (row.json ?? []) as Array<Record<string, unknown>>);
}

function send(narratorId: string, message: string) {
	return app().request(`http://localhost/narrators/${narratorId}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message }),
	});
}

describe("/goal to an idle outline session", () => {
	test("its first turn starts even when continuation is off, on the goal", async () => {
		const id = await session();
		const response = await send(id, "/goal ship the release");
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			specGoal: true,
			added: true,
			objective: "ship the release",
			started: true,
			taskBackend: "outline",
			locked: true,
		});
		await waitFor(async () => {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, id),
				columns: { status: true },
			});
			return providerInputs.length === 1 && row?.status === "idle";
		});
		const [goal] = await goals(id);
		expect(goal?.taskJson?.status).toBe("doing");
		expect(goal?.taskJson?.lock?.by).toEqual({ kind: "human", id: OWNER });
		// The turn was told about the goal, by its address; continuation is off: one turn only.
		expect(providerInputs[0]).toContain(`/${goal?.sid}`);
		expect(String(body.address)).toEndWith(`/${goal?.sid}`);
		const blocks = await messageBlocks(id);
		expect(blocks.some((block) => block.type === "spec_goal_added")).toBe(true);
		await Bun.sleep(100);
		expect(providerInputs).toHaveLength(1);
		closeNarrator(id);
	});

	test("in plan mode the goal is written and nothing starts", async () => {
		const id = await session({ traits: ["standalone", "plan"] });
		const response = await send(id, "/goal ship the release");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ added: true, started: false });
		const [goal] = await goals(id);
		expect(goal?.taskJson?.status).toBe("todo");
		await Bun.sleep(100);
		expect(providerInputs).toHaveLength(0);
	});
});
