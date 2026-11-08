/**
 * A plugin's `task_add` with `start` (outline P2 PR 12a): on an idle outline session it starts a
 * turn on that task, as the task board's "Add and start" does (the task in progress, held by the
 * session, named to the turn); without `start`, or in plan mode, nothing runs. A model stand-in
 * answers the turn (the provider module is replaced for this file, as in
 * `outline-goal-start.test.ts`).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; each case makes its own session.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { modelInputText, requestInput, rowsAsHistory } from "../../../tests/fixtures/model-input";
import { narrators, users } from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";

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
		yield { text: "plugin task turn ran" };
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

const { settings } = await import("../../lib/settings");
const { addOutlineTaskForPlugin, closeNarrator } = await import("../narrator-session");
const { outlineStore } = await import("../outline/store");
const { invalidateTaskBackend } = await import("../task-source");

const NOW = "2026-11-08T00:00:00.000Z";
const OWNER = `plugin-start-${Date.now()}`;

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

async function session(options: { traits?: string[] } = {}): Promise<string> {
	const id = `plugin-start-${crypto.randomUUID()}`;
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

async function idleAfterTurns(narratorId: string, turns: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { status: true },
		});
		if (providerInputs.length >= turns && row?.status === "idle") return;
		await Bun.sleep(10);
	}
	throw new Error("timed out waiting for the turn");
}

describe("task_add with start", () => {
	test("an idle session starts a turn on the task, which it holds", async () => {
		const id = await session();
		const added = await addOutlineTaskForPlugin(id, {
			pluginId: "com.example.lead",
			text: "Review the parser",
			start: true,
		});
		expect(added).toMatchObject({ added: true, started: true });
		await idleAfterTurns(id, 1);
		const task = await outlineStore.getBlock(added.blockId);
		expect(task?.taskJson?.status).toBe("doing");
		const [claim] = await outlineStore.getTaskClaims([added.blockId]);
		expect(claim?.holderNarratorId).toBe(id);
		expect(providerInputs[0]).toContain(added.address.split("/")[1] as string);
		closeNarrator(id);
	});

	test("without start, or in plan mode, nothing runs", async () => {
		const quiet = await session();
		expect(
			await addOutlineTaskForPlugin(quiet, { pluginId: "com.example.lead", text: "Later" }),
		).toMatchObject({ added: true, started: false });
		const planning = await session({ traits: ["standalone", "plan"] });
		expect(
			await addOutlineTaskForPlugin(planning, {
				pluginId: "com.example.lead",
				text: "Later",
				start: true,
			}),
		).toMatchObject({ added: true, started: false });
		await Bun.sleep(100);
		expect(providerInputs).toHaveLength(0);
	});
});
