/**
 * `attention-hook-bridge` flag pass-through.
 *
 * Notification channels suppress a `done` raised while non-service background
 * work is still running, but hooks KEEP firing — the bridge forwards the flag as
 * `background_work_active` in the hook input so the receiver decides what to do.
 */

import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import type { HookInput, HookResult } from "../hook-service";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
afterAll(() => fixture.close());
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const runHookCalls: Array<{
	event: string;
	input: HookInput;
	projectId?: string;
	toolName?: string;
}> = [];
const realHookServiceModule = { ...(await import("../hook-service")) };
mock.module("../hook-service", () => ({
	hookService: {
		runHooks: async (
			event: string,
			input: HookInput,
			projectId?: string,
			toolName?: string,
		): Promise<HookResult> => {
			runHookCalls.push({ event, input, projectId, toolName });
			return { outcome: "success" };
		},
	},
}));

// Registers the `narrator:attention` / `narrator:attention_resolved` listeners.
await import("../attention-hook-bridge");
const { eventBus } = await import("../../lib/event-bus");

const NOW = "2026-10-19T00:00:00.000Z";

function seedNarrator(): void {
	db.insert(narrators)
		.values({
			id: "hook-attention-narrator",
			title: "Hook attention narrator",
			status: "idle",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

/** The bridge handler is async (narrator lookup + runHooks). */
async function settleBridge(): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (runHookCalls.length === 0 && Date.now() < deadline) await Bun.sleep(5);
}

afterEach(() => {
	runHookCalls.length = 0;
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../hook-service", () => realHookServiceModule);
	mock.restore();
});

describe("attention-hook-bridge background_work_active", () => {
	it("forwards background_work_active=true on a flagged done event", async () => {
		seedNarrator();

		eventBus.emit({
			type: "narrator:attention",
			narratorId: "hook-attention-narrator",
			reason: "done",
			backgroundWorkActive: true,
		});
		await settleBridge();

		expect(runHookCalls).toHaveLength(1);
		expect(runHookCalls[0]?.event).toBe("Attention");
		expect(runHookCalls[0]?.input.attention_reason).toBe("done");
		expect(runHookCalls[0]?.input.background_work_active).toBe(true);
	});

	it("omits the field on an ordinary done event", async () => {
		seedNarrator();

		eventBus.emit({
			type: "narrator:attention",
			narratorId: "hook-attention-narrator",
			reason: "done",
		});
		await settleBridge();

		expect(runHookCalls).toHaveLength(1);
		expect(runHookCalls[0]?.input).not.toHaveProperty("background_work_active");
	});

	it("never sets the field on waiting_permission", async () => {
		seedNarrator();

		eventBus.emit({
			type: "narrator:attention",
			narratorId: "hook-attention-narrator",
			reason: "waiting_permission",
		});
		await settleBridge();

		expect(runHookCalls).toHaveLength(1);
		expect(runHookCalls[0]?.input.attention_reason).toBe("waiting_permission");
		expect(runHookCalls[0]?.input).not.toHaveProperty("background_work_active");
	});
});
