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

test("an optional title network failure drains without becoming a persistence failure", async () => {
	const id = "shutdown-title-network-fixture";
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({ id, type: "primary", variant: "primary", createdAt: now, updatedAt: now })
		.run();
	const generated = Promise.withResolvers<string>();
	spyOn(agent, "summaryGenerateWithHistory").mockImplementation(() => generated.promise);
	const update = spyOn(narratorService, "updateTitle");
	let completion!: Promise<void>;
	await state.withNarratorWorkAdmission(id, async () => {
		completion = title.generateQuickTitle(id, "fixture request");
	});
	state.freezeNarratorAdmissionForShutdown();
	const draining = state.drainNarratorAdmissionWork(new AbortController().signal);
	generated.reject(new Error("fixture provider offline"));
	await completion;
	await draining;
	expect(update).not.toHaveBeenCalled();
	expect(state.getNarratorShutdownPendingCount()).toBe(0);
});
