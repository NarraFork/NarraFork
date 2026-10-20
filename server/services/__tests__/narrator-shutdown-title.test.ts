import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const agent = await import("../../lib/agent");
const state = await import("../narrator-session-state");
const title = await import("../narrator-title");
const { narratorService } = await import("../narrator-service");
afterAll(() => mock.restore());

test("fire-and-forget title retains generation and final persistence after its starter settles", async () => {
	const id = "shutdown-title-fixture";
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({ id, type: "primary", variant: "primary", createdAt: now, updatedAt: now })
		.run();
	const generated = Promise.withResolvers<string>();
	const persistenceEntered = Promise.withResolvers<void>();
	const persisted = Promise.withResolvers<void>();
	spyOn(agent, "summaryGenerateWithHistory").mockImplementation(() => generated.promise);
	spyOn(narratorService, "updateTitle").mockImplementation(async () => {
		persistenceEntered.resolve();
		await persisted.promise;
	});
	let titleCompletion!: Promise<void>;
	await state.withNarratorWorkAdmission(id, async () => {
		titleCompletion = title.generateQuickTitle(id, "fixture request");
		// The foreground start stays non-blocking; the title owns its own tail.
	});
	expect(state.getNarratorShutdownPendingCount()).toBeGreaterThan(0);
	state.freezeNarratorAdmissionForShutdown();
	let settled = false;
	const draining = state.drainNarratorAdmissionWork(new AbortController().signal);
	void draining.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	generated.resolve("Fixture title");
	await persistenceEntered.promise;
	expect(settled).toBe(false);
	const failure = new Error("fixture title persistence failed");
	persisted.reject(failure);
	// Existing title API keeps its logged/non-throwing failure behavior.
	await titleCompletion;
	await expect(draining).rejects.toBe(failure);
	expect(state.getNarratorShutdownPendingCount()).toBe(0);
});
