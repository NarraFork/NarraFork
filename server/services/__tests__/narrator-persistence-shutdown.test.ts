import { expect, spyOn, test } from "bun:test";

// The service binds persistence methods during module initialization.
await import("../narrator-service");
const persistence = await import("../narrator-persistence");
const recovery = await import("../narrator-subagent-recovery");
const { sqlite } = await import("../../db");

test("status persistence owns the entire deferred recovery-card tail through shutdown", async () => {
	const id = "shutdown-recovery-card";
	const now = new Date().toISOString();
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run(id, now, now);
	let reject = (_error: Error) => {};
	const pending = new Promise<boolean>((_done, fail) => {
		reject = fail;
	});
	const persist = spyOn(recovery, "persistSubagentRecoveryCard").mockImplementation(() => pending);
	try {
		persistence.beginRecoveryCardShutdown();
		await persistence.narratorPersistence.updateStatus(id, "idle", {
			substatus: ["error"],
			errorMessage: "fixture failure",
		});
		expect(persistence.getRecoveryCardShutdownState().pending).toBe(1);
		const controller = new AbortController();
		const drain = persistence.drainRecoveryCardsForShutdown(controller.signal);
		controller.abort(new Error("deadline"));
		await expect(drain).rejects.toThrow("deadline");
		expect(persistence.getRecoveryCardShutdownState().pending).toBe(1);
		const error = new Error("recovery card failed");
		reject(error);
		await persistence.drainRecoveryCardsForShutdown(new AbortController().signal);
		expect(persist).toHaveBeenCalledWith(id);
		expect(persistence.getRecoveryCardShutdownState()).toEqual({
			pending: 0,
			failureCount: 1,
			firstError: error,
		});
	} finally {
		persist.mockRestore();
		sqlite.prepare("DELETE FROM narrator_message_refs WHERE narrator_id = ?").run(id);
		sqlite.prepare("DELETE FROM narrator_messages WHERE narrator_id = ?").run(id);
		sqlite.prepare("DELETE FROM narrators WHERE id = ?").run(id);
	}
});
