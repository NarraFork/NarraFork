import { describe, expect, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { settleWorkerRead } from "./__tests__/file-worker-database";
import {
	db,
	journalFiles,
	options,
	owner,
	test,
	twoFiles,
} from "./__tests__/revert-transaction.fixture";
import { RevertMutationJournal } from "./revert-mutation-journal";

async function fixture() {
	const { plan } = await twoFiles();
	const journal = new RevertMutationJournal(db, options.planOptions);
	const ctx = { owner, planId: plan.id, planHash: plan.planHash as string };
	const files = journalFiles(plan);
	return { journal, ctx, files, plan };
}
describe("revert result journal", () => {
	test("history failure only settles admitted execution and never certifies its files", async () => {
		const { journal, ctx, files } = await fixture();
		expect(journal.failHistory(ctx, "DB_READ_UNAVAILABLE").status).toBe("prepared");
		await journal.startExecution(ctx);
		journal.startFile(ctx, files[0].id);
		const failed = journal.failHistory(ctx, "DB_READ_UNAVAILABLE");
		expect(failed.status).toBe("partial");
		expect(failed.reason).toBe("DB_READ_UNAVAILABLE");
		expect(failed.appliedFileCount).toBe(0);
		expect((await journal.listFiles(ctx)).items.map((file) => file.status).sort()).toEqual([
			"applying",
			"prepared",
		]);
		expect(journal.failHistory(ctx, "another failure")).toEqual(failed);
		expect(() => journal.commit(ctx, { db, apply: () => {} })).toThrow("Every required file");
	});

	test("execution and each file dispatch are one-shot", async () => {
		const { journal, ctx, files } = await fixture();
		expect((await journal.startExecution(ctx)).started).toBe(true);
		expect((await journal.startExecution(ctx)).started).toBe(false);
		expect(journal.startFile(ctx, files[0].id)).toBe(true);
		expect(journal.startFile(ctx, files[0].id)).toBe(false);
	});
	test("partial success remains queryable and cannot commit messages", async () => {
		const { journal, ctx, files } = await fixture();
		await journal.startExecution(ctx);
		journal.startFile(ctx, files[0].id);
		journal.recordResult(ctx, files[0].id, {
			status: "applied",
			reason: null,
			historyStatus: "complete",
			observedAfter: files[0].desiredStateJson,
		});
		journal.recordResult(ctx, files[1].id, {
			status: "conflict",
			reason: "content_changed",
			historyStatus: "complete",
		});
		expect((await journal.finishFiles(ctx)).status).toBe("partial");
		expect((await journal.getOperation(ctx)).appliedFileCount).toBe(1);
		let called = false;
		expect(() =>
			journal.commit(ctx, {
				db,
				apply: () => {
					called = true;
				},
			}),
		).toThrow("Every required file");
		expect(called).toBe(false);
	});
	test("fingerprint-only before state cannot claim complete reversible materials", async () => {
		const { journal, ctx, files } = await fixture();
		db.update(schema.revertOperationFiles)
			.set({ beforeBlobDigest: null })
			.where(eq(schema.revertOperationFiles.id, files[0].id))
			.run();
		await journal.startExecution(ctx);
		const row = journal.recordResult(ctx, files[0].id, {
			status: "applied",
			reason: null,
			historyStatus: "complete",
			observedAfter: files[0].desiredStateJson,
		});
		expect(row.status).toBe("applied");
		expect(row.beforeBlobDigest).toBeNull();
		expect(row.receiptJson).toMatchObject({ historyStatus: "unavailable" });
	});
	test("optional before snapshots are complete only while their catalog material is ready", async () => {
		const { journal, ctx, files } = await fixture();
		await journal.startExecution(ctx);
		const result = {
			status: "applied" as const,
			reason: null,
			historyStatus: "complete" as const,
			observedAfter: files[0].desiredStateJson,
		};
		expect(journal.recordResult(ctx, files[0].id, result).receiptJson).toMatchObject({
			historyStatus: "complete",
		});
		db.update(schema.fileChangeBlobs)
			.set({ status: "missing" })
			.where(eq(schema.fileChangeBlobs.digest, files[1].beforeBlobDigest as string))
			.run();
		const recorded = journal.recordResult(ctx, files[1].id, {
			...result,
			observedAfter: files[1].desiredStateJson,
		});
		expect(recorded.status).toBe("applied");
		expect(recorded.receiptJson).toMatchObject({ historyStatus: "unavailable" });
	});
	test("immutable result cannot be upgraded by duplicate delivery", async () => {
		const { journal, ctx, files } = await fixture();
		await journal.startExecution(ctx);
		journal.startFile(ctx, files[0].id);
		journal.recordResult(ctx, files[0].id, {
			status: "unknown",
			reason: "timeout",
			historyStatus: "complete",
		});
		expect(
			journal.recordResult(ctx, files[0].id, {
				status: "applied",
				reason: null,
				historyStatus: "complete",
			}).status,
		).toBe("unknown");
		expect(journal.startFile(ctx, files[0].id)).toBe(false);
	});
	test("history writes and committed marker share one synchronous transaction", async () => {
		const { journal, ctx, files } = await fixture();
		await journal.startExecution(ctx);
		for (const file of files)
			journal.recordResult(ctx, file.id, {
				status: "unchanged",
				reason: null,
				historyStatus: "complete",
				observedAfter: file.desiredStateJson,
			});
		expect((await journal.finishFiles(ctx)).status).toBe("files_verified");
		expect(() =>
			journal.commit(ctx, {
				db,
				apply(tx) {
					tx.update(schema.narrators)
						.set({ title: "rolled back" })
						.where(eq(schema.narrators.id, "narrator"))
						.run();
					throw new Error("history failure");
				},
			}),
		).toThrow("history failure");
		expect(
			db.select().from(schema.narrators).where(eq(schema.narrators.id, "narrator")).get()?.title,
		).not.toBe("rolled back");
		let calls = 0;
		const apply = () => {
			calls++;
		};
		expect(journal.commit(ctx, { db, apply }).status).toBe("committed");
		journal.commit(ctx, { db, apply });
		expect(calls).toBe(1);
	});
	test("cancellation marks unstarted files without claiming IO", async () => {
		const { journal, ctx, files } = await fixture();
		await journal.startExecution(ctx);
		for (const file of files)
			journal.recordResult(ctx, file.id, {
				status: "not_attempted",
				reason: "cancelled",
				historyStatus: "complete",
			});
		expect((await journal.finishFiles(ctx, { cancelled: true })).status).toBe("cancelled");
	});
	test("authorized owner and plan hash are required for every query", async () => {
		const { journal, ctx } = await fixture();
		await expect(
			(
				await settleWorkerRead(
					journal.getOperation({ ...ctx, owner: { ...owner, subjectKey: "human:bob" } }),
				)
			).result(),
		).rejects.toThrow("authorized context");
		await expect(
			(await settleWorkerRead(journal.listFiles({ ...ctx, planHash: "0".repeat(64) }))).result(),
		).rejects.toThrow("Confirmed plan changed");
	});
	test("a Worker snapshot grants no authority after the confirmed plan hash changes", async () => {
		const { journal, ctx, files } = await fixture();
		expect((await journal.getOperation(ctx)).status).toBe("prepared");
		db.update(schema.revertOperations)
			.set({ planHash: "f".repeat(64) })
			.where(eq(schema.revertOperations.id, ctx.planId))
			.run();
		await expect((await settleWorkerRead(journal.startExecution(ctx))).result()).rejects.toThrow(
			"Confirmed plan changed",
		);
		expect(() => journal.startFile(ctx, files[0].id)).toThrow("Confirmed plan changed");
		expect(
			db
				.select()
				.from(schema.revertOperationFiles)
				.where(eq(schema.revertOperationFiles.id, files[0].id))
				.get()?.status,
		).toBe("prepared");
	});
	test("file result changes after the Worker page reject the final status transition", async () => {
		const { journal, ctx } = await fixture();
		await journal.startExecution(ctx);
		const list = journal.listFiles.bind(journal);
		const pageRead = spyOn(journal, "listFiles").mockImplementation(async (...args) => {
			const page = await list(...args);
			db.update(schema.revertOperations)
				.set({ updatedAt: "2099-01-01T00:00:00.000Z" })
				.where(eq(schema.revertOperations.id, ctx.planId))
				.run();
			return page;
		});
		try {
			await expect((await settleWorkerRead(journal.finishFiles(ctx))).result()).rejects.toThrow(
				"File results changed",
			);
			expect((await journal.getOperation(ctx)).status).toBe("applying");
		} finally {
			pageRead.mockRestore();
		}
	});
	test("legacy pending journals stay read-only and fresh plans stay writable", async () => {
		const { journal, ctx, plan } = await fixture();
		db.update(schema.revertOperations)
			.set({ protocolVersion: 2, status: "recovery_required" })
			.where(eq(schema.revertOperations.id, plan.id))
			.run();
		expect((await journal.getOperation(ctx)).status).toBe("recovery_required");
		expect((await journal.startExecution(ctx)).started).toBe(false);
		const next = await fixture();
		expect((await next.journal.startExecution(next.ctx)).started).toBe(true);
	});
	test("paginated files remain complete and expose no fabricated compensation identity", async () => {
		const { journal, ctx } = await fixture();
		const first = await journal.listFiles(ctx, { limit: 1 });
		expect(first.hasMore).toBe(true);
		const second = await journal.listFiles(ctx, { limit: 1, cursor: first.nextCursor as string });
		expect(second.hasMore).toBe(false);
		expect(first.items[0].id).not.toBe(second.items[0].id);
		for (const row of [...first.items, ...second.items]) {
			expect(row.compensateMutationId).toBeNull();
			expect(row.compensateRequestDigest).toBeNull();
		}
	});
});
