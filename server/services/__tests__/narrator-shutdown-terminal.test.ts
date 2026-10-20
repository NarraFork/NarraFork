import { afterAll, expect, mock, test } from "bun:test";
import { getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const state = await import("../narrator-session-state");
afterAll(() => mock.restore());

test("terminal rejection stays owned through final writes and fails shutdown drain", async () => {
	const id = "shutdown-terminal-fixture";
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({
			id,
			type: "primary",
			variant: "primary",
			status: "idle",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const terminal = Promise.withResolvers<void>();
	const ready = await state.withNarratorWorkAdmission(
		id,
		async () => ({ terminal: terminal.promise }),
		(run) => run.terminal,
	);
	state.freezeNarratorAdmissionForShutdown();
	expect(state.getNarratorShutdownPendingCount()).toBe(1);
	const draining = state.drainNarratorAdmissionWork(new AbortController().signal);
	const failure = new Error("owner release persistence failed");
	terminal.reject(failure);
	await expect(ready.terminal).rejects.toBe(failure);
	await expect(draining).rejects.toBe(failure);
	expect(state.getNarratorShutdownPendingCount()).toBe(0);
	// Failure evidence survives after its lease leaves the in-flight collection.
	await expect(state.drainNarratorAdmissionWork(new AbortController().signal)).rejects.toBe(
		failure,
	);
});
