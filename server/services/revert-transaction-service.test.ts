import { describe, expect, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import {
	db,
	execution,
	failHistoryCommit,
	history,
	journalFiles,
	makeFixtureTransaction,
	namespace,
	operation,
	options,
	prepare,
	principal,
	service,
	setFileHook,
	setService,
	test,
	twoFiles,
	workspace,
	write,
} from "./__tests__/revert-transaction.fixture";

import { RevertSelectionService } from "./revert-selection-service";

describe("independent file restoration", () => {
	test("history-changing success uses five collector scans including preview and history.prepare", async () => {
		const collect = spyOn(RevertSelectionService.prototype, "collect");
		try {
			const { plan } = await twoFiles();
			expect((await execution(plan).whenSettled).historyCommitted).toBe(true);
			expect(collect).toHaveBeenCalledTimes(5);
		} finally {
			collect.mockRestore();
		}
	});
	test("a run budget above the queue admission ceiling still restores files", async () => {
		setService(makeFixtureTransaction(db, { ...options, timeoutMs: 120_000 }));
		const { plan } = await twoFiles();
		const result = await execution(plan).whenSettled;
		expect(result.status).toBe("committed");
		expect(result.files.map((file) => file.status)).toEqual(["applied", "applied"]);
	});
	test("file-only success keeps its post-IO collector because it does not prepare history", async () => {
		const path = join(workspace, "file-only.txt");
		await fs.writeFile(path, "before");
		await write(path, "after");
		const collect = spyOn(RevertSelectionService.prototype, "collect");
		try {
			const plan = await prepare({ kind: "revert" });
			const result = await execution(plan).whenSettled;
			expect(result.status).toBe("committed");
			expect(result.historyCommitted).toBe(false);
			expect(collect).toHaveBeenCalledTimes(4);
		} finally {
			collect.mockRestore();
		}
	});
	test("real A to A effect leaves unarchived external B unchanged while history commits", async () => {
		const path = join(workspace, "unchanged-effect.txt");
		await fs.writeFile(path, "A");
		await write(path, "A");
		const external = "external unarchived B";
		await fs.writeFile(path, external);
		const plan = await prepare({ kind: "history_delete" });
		expect(plan.coverageComplete).toBe(true);
		const [row] = journalFiles(plan);
		expect(row.expectedStateJson).toEqual(row.desiredStateJson);
		expect(row.desiredBlobDigest).toBeNull();
		const ref = row.desiredStateJson.kind === "regular" ? row.desiredStateJson.blob : null;
		if (!ref) throw new Error("Missing measured B");
		expect(
			namespace.catalog.getMetadata({ expectedGeneration: namespace.generation, ref }),
		).toBeNull();
		const result = await execution(plan).whenSettled;
		expect(result.status).toBe("committed");
		expect(result.historyCommitted).toBe(true);
		expect(result.historyStatus).toBe("complete");
		expect(result.files.map((file) => file.status)).toEqual(["unchanged"]);
		expect(await fs.readFile(path, "utf8")).toBe(external);
		expect(
			namespace.catalog.getMetadata({ expectedGeneration: namespace.generation, ref }),
		).toBeNull();
	});
	test("A to A no-op still conflicts if the target changes after preview", async () => {
		const path = join(workspace, "unchanged-conflict.txt");
		await fs.writeFile(path, "A");
		await write(path, "A");
		await fs.writeFile(path, "external unarchived B");
		const before = history();
		const plan = await prepare({ kind: "history_delete" });
		await fs.writeFile(path, "later external C");
		const result = await execution(plan).whenSettled;
		expect(result.status).toBe("failed");
		expect(result.historyCommitted).toBe(false);
		expect(result.files.map((file) => file.status)).toEqual(["conflict"]);
		expect(await fs.readFile(path, "utf8")).toBe("later external C");
		expect(history()).toBe(before);
	});
	test("manifest-only free quota still restores unarchived current and reports unavailable history", async () => {
		const path = join(workspace, "unarchived-current.txt");
		await fs.writeFile(path, "before");
		await write(path, "after");
		const current = Buffer.from("human content".repeat(32 * 1024));
		await fs.writeFile(path, current);
		const budget = namespace.catalog.getBudget();
		if (!budget) throw new Error("Missing budget");
		db.update(schema.fileChangeStorageBudgets)
			.set({ quotaBytes: budget.usedBytes + 32 * 1024 })
			.run();
		await expect(
			namespace.store.putBytes(current, { expectedSize: current.byteLength }),
		).rejects.toThrow();
		const plan = await prepare({
			kind: "revert",
			uiAction: "revert_files",
			recoveryMode: "snapshot",
		});
		const execute = () =>
			service.execute({
				principal,
				narratorId: "narrator",
				planId: plan.id,
				planHash: plan.planHash as string,
				action: "revert_files",
				acceptSnapshotRestore: true,
			}).whenSettled;
		const result = await execute();
		expect(result.status).toBe("committed");
		expect(result.files.map((file) => file.status)).toEqual(["applied"]);
		expect(result.historyStatus).toBe("unavailable");
		expect(await fs.readFile(path, "utf8")).toBe("before");
		for (const file of journalFiles(plan)) {
			expect(file.beforeBlobDigest).toBeNull();
			expect(file.receiptJson).toMatchObject({ historyStatus: "unavailable" });
		}
		expect((await execute()).historyStatus).toBe("unavailable");
	});
	test("edit consent rejects a plan for another message or block before file dispatch", async () => {
		const path = join(workspace, "edit-boundary.txt");
		await fs.writeFile(path, "before");
		const { messageId } = await write(path, "after");
		const selector = { kind: "after_block" as const, messageId, keepThroughBlockIndex: 0 };
		const plan = await prepare({
			kind: "rollback_to_block",
			uiAction: "edit_and_regenerate",
			selector,
		});
		for (const wrong of [
			{ ...selector, messageId: "different-message" },
			{ ...selector, keepThroughBlockIndex: -1 },
		]) {
			const result = service.execute({
				principal,
				narratorId: "narrator",
				planId: plan.id,
				planHash: plan.planHash as string,
				action: "edit_and_regenerate",
				expectedSelector: wrong,
			});
			// Mutating the caller's object after dispatch must not change its captured consent.
			Object.assign(wrong, selector);
			await expect(result.whenSettled).rejects.toMatchObject({
				code: "REVERT_TRANSACTION_ACTION_MISMATCH",
			});
			expect(operation(plan)?.status).toBe("prepared");
			expect(await fs.readFile(path, "utf8")).toBe("after");
		}
		const run = (
			expectedSelector = selector,
			action: "edit_and_regenerate" | "rollback_to_block" = "edit_and_regenerate",
		) =>
			service.execute({
				principal,
				narratorId: "narrator",
				planId: plan.id,
				planHash: plan.planHash as string,
				action,
				expectedSelector,
			}).whenSettled;
		const first = await run();
		expect(first.historyCommitted).toBe(true);
		const terminalHistory = history();
		await fs.writeFile(path, "after terminal response");
		setFileHook(() => {
			throw new Error("terminal replay must not dispatch target IO");
		});
		const replay = await run();
		expect(replay).toMatchObject({ status: "committed", historyCommitted: true });
		expect(replay.files.map((file) => file.status)).toEqual(first.files.map((file) => file.status));
		expect(history()).toBe(terminalHistory);
		expect(await fs.readFile(path, "utf8")).toBe("after terminal response");
		for (const [wrongSelector, action] of [
			[{ ...selector, messageId: "different-message" }, "edit_and_regenerate"],
			[selector, "rollback_to_block"],
		] as const)
			await expect(run(wrongSelector, action)).rejects.toMatchObject({
				code: "REVERT_TRANSACTION_ACTION_MISMATCH",
			});
		expect(history()).toBe(terminalHistory);
		expect(await fs.readFile(path, "utf8")).toBe("after terminal response");
	});
	for (const snapshot of [false, true]) {
		test(`${snapshot ? "snapshot" : "selective"} pending file tool retains settled file recovery without history commit`, async () => {
			const settledPath = join(workspace, "settled.txt");
			const pendingPath = join(workspace, "pending.txt");
			await fs.writeFile(settledPath, "settled before");
			await fs.writeFile(pendingPath, "pending before");
			const settled = await write(settledPath, "settled after");
			const pending = await write(pendingPath, "pending after");
			// A still-running multi-step tool may already have a settled file effect;
			// that prefix is not proof that its complete disk work has finished.
			db.update(schema.narratorToolCalls)
				.set({ status: "running" })
				.where(eq(schema.narratorToolCalls.id, pending.toolCallId))
				.run();
			const originalHistory = history();
			const plan = await prepare({
				kind: "rollback_to_block",
				uiAction: "rollback_to_block",
				selector: { kind: "after_block", messageId: settled.messageId, keepThroughBlockIndex: 0 },
				...(snapshot ? { recoveryMode: "snapshot" as const } : {}),
			});
			expect(plan.status).toBe("prepared");
			expect(plan.coverageComplete).toBe(false);
			expect(plan.expectedFileCount).toBe(1);
			const result = await service.execute({
				principal,
				narratorId: "narrator",
				planId: plan.id,
				planHash: plan.planHash as string,
				action: "rollback_to_block",
				...(snapshot ? { acceptSnapshotRestore: true as const } : {}),
			}).whenSettled;
			expect(result.status).toBe("partial");
			expect(result.files.map((file) => file.status)).toEqual(["applied"]);
			expect(result.historyCommitted).toBe(false);
			expect(await fs.readFile(settledPath, "utf8")).toBe("settled before");
			expect(await fs.readFile(pendingPath, "utf8")).toBe("pending after");
			expect(history()).toBe(originalHistory);
		});
	}
	test("all files succeed before message history commits", async () => {
		const { a, b, plan } = await twoFiles();
		const result = await execution(plan).whenSettled;
		expect(result.status).toBe("committed");
		expect(result.historyCommitted).toBe(true);
		expect(result.historyStatus).toBe("complete");
		for (const file of journalFiles(plan)) {
			expect(file.beforeBlobDigest).toBe(
				file.expectedStateJson.kind === "regular" ? file.expectedStateJson.blob.digest : null,
			);
			expect(file.receiptJson).toMatchObject({ historyStatus: "complete" });
		}
		expect((await execution(plan).whenSettled).historyStatus).toBe("complete");
		expect(result.files.map((file) => file.status)).toEqual(["applied", "applied"]);
		expect(await fs.readFile(a, "utf8")).toBe("original");
		expect(await fs.readFile(b, "utf8")).toBe("original");
		expect(db.select().from(schema.narratorMessageRefs).all()).toHaveLength(0);
	});
	test("second-file conflict keeps the first success and original message history", async () => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		await fs.writeFile(b, "external edit");
		const result = await execution(plan).whenSettled;
		expect(result.status).toBe("partial");
		expect(result.historyCommitted).toBe(false);
		expect(result.files.map((file) => file.status)).toEqual(["applied", "conflict"]);
		expect(await fs.readFile(a, "utf8")).toBe("original");
		expect(await fs.readFile(b, "utf8")).toBe("external edit");
		expect(history()).toBe(before);
	});
	test("message commit failure keeps successful files", async () => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		failHistoryCommit();
		const result = await execution(plan).whenSettled;
		expect(result.status).toBe("partial");
		expect(result.historyCommitted).toBe(false);
		expect(history()).toBe(before);
		for (const path of [a, b]) expect(await fs.readFile(path, "utf8")).toBe("original");
	});
	test("terminal retry reports prior outcomes without writing again", async () => {
		const { a, b, plan } = await twoFiles();
		await fs.writeFile(b, "external edit");
		expect((await execution(plan).whenSettled).status).toBe("partial");
		await fs.writeFile(a, "later user work");
		setFileHook(() => {
			throw new Error("replay must not authorize target IO");
		});
		const replay = await execution(plan).whenSettled;
		expect(replay.files.map((file) => file.status)).toEqual(["applied", "conflict"]);
		expect(await fs.readFile(a, "utf8")).toBe("later user work");
	});
	test("archived scope health and recovery flags cannot block a fresh plan", async () => {
		const path = join(workspace, "legacy.txt");
		await fs.writeFile(path, "before");
		await write(path, "after");
		db.update(schema.fileChangeScopes)
			.set({ status: "needs_verification", activeLeaseId: "old-owner", activeMutationCount: 1 })
			.run();
		const plan = await prepare({ kind: "revert" });
		expect((await execution(plan).whenSettled).status).toBe("committed");
		expect(await fs.readFile(path, "utf8")).toBe("before");
	});
	test("a version-only change does not veto a structurally identical confirmed plan", async () => {
		const { a, plan } = await twoFiles();
		db.update(schema.narrators)
			.set({ messageVersion: 8, status: "working" })
			.where(eq(schema.narrators.id, "narrator"))
			.run();
		const result = await execution(plan).whenSettled;
		expect(result.historyCommitted).toBe(true);
		expect(result.status).toBe("committed");
		expect(await fs.readFile(a, "utf8")).toBe("original");
	});
	for (const kind of ["revert", "history_delete"] as const)
		test(`${kind} ignores new unrelated same-narrator messages for a single selected tool`, async () => {
			const path = join(workspace, "stable-point.txt");
			await fs.writeFile(path, "original");
			const target = await write(path, "changed");
			const plan = await prepare({
				kind,
				selector: { kind: "tool_calls", toolCallIds: [target.toolCallId] },
			});
			db.insert(schema.narratorMessages)
				.values({
					id: "unrelated-message",
					narratorId: "narrator",
					role: "user",
					contentJson: [{ type: "text", text: "unrelated" }],
					createdAt: new Date().toISOString(),
				})
				.run();
			db.insert(schema.narratorMessageRefs)
				.values({
					id: "unrelated-ref",
					narratorId: "narrator",
					messageId: "unrelated-message",
					seq: 999,
				})
				.run();
			db.update(schema.narrators)
				.set({ messageVersion: 8, status: "working" })
				.where(eq(schema.narrators.id, "narrator"))
				.run();
			const result = await execution(plan).whenSettled;
			expect(result.status).toBe("committed");
			expect(result.historyCommitted).toBe(kind === "history_delete");
			expect(await fs.readFile(path, "utf8")).toBe("original");
			expect(
				db
					.select()
					.from(schema.narratorMessageRefs)
					.where(eq(schema.narratorMessageRefs.id, "unrelated-ref"))
					.get()?.messageId,
			).toBe("unrelated-message");
		});
	test("a version bump inside the initial collector preserves original header consent and still executes", async () => {
		const path = join(workspace, "initial-collect-drift.txt");
		await fs.writeFile(path, "original");
		const target = await write(path, "changed");
		const realCollect = RevertSelectionService.prototype.collect;
		let scheduled = false;
		const collect = spyOn(RevertSelectionService.prototype, "collect").mockImplementation(function (
			this: RevertSelectionService,
			request,
		) {
			if (!scheduled && request.expectedMessageVersion !== undefined) {
				scheduled = true;
				queueMicrotask(() =>
					db
						.update(schema.narrators)
						.set({ messageVersion: 8, status: "working" })
						.where(eq(schema.narrators.id, "narrator"))
						.run(),
				);
			}
			return realCollect.call(this, request);
		});
		try {
			const plan = await prepare({
				selector: { kind: "tool_calls", toolCallIds: [target.toolCallId] },
			});
			expect(plan.expectedMessageVersion).toBe(7);
			expect((await execution(plan).whenSettled).status).toBe("committed");
			expect(await fs.readFile(path, "utf8")).toBe("original");
		} finally {
			collect.mockRestore();
		}
	});
	test("a selected message change still rejects before file dispatch", async () => {
		const { a, plan } = await twoFiles();
		db.update(schema.narratorMessages).set({ contentJson: [] }).run();
		db.update(schema.narrators)
			.set({ messageVersion: 8 })
			.where(eq(schema.narrators.id, "narrator"))
			.run();
		await expect(execution(plan).whenSettled).rejects.toThrow();
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(operation(plan)?.status).toBe("prepared");
	});
	for (const mutation of ["body", "same-length body", "ref", "tool", "suffix"] as const)
		test(`the last collection ACL cannot permit ${mutation} changes before file dispatch`, async () => {
			const { a, plan } = await twoFiles();
			const selected = db.select().from(schema.narratorMessages).limit(1).get();
			if (!selected || !Array.isArray(selected.contentJson))
				throw new Error("Missing selected message");
			const selectedBody = selected.contentJson;
			const originalAuthorize = options.access.authorizeNarrator;
			let calls = 0;
			let fileReads = 0;
			setFileHook(() => {
				fileReads++;
			});
			const authorize = spyOn(options.access, "authorizeNarrator").mockImplementation(
				async (...args) => {
					await originalAuthorize(...args);
					if (++calls !== 3) return;
					if (mutation === "body")
						db.update(schema.narratorMessages)
							.set({ contentJson: [] })
							.where(eq(schema.narratorMessages.id, selected.id))
							.run();
					if (mutation === "same-length body")
						db.update(schema.narratorMessages)
							.set({ contentJson: [{ type: "text", text: "mutate" }, ...selectedBody.slice(1)] })
							.where(eq(schema.narratorMessages.id, selected.id))
							.run();
					if (mutation === "ref")
						db.update(schema.narratorMessageRefs)
							.set({ seq: 999 })
							.where(eq(schema.narratorMessageRefs.messageId, selected.id))
							.run();
					if (mutation === "tool")
						db.update(schema.narratorToolCalls)
							.set({ executionAttempt: 2 })
							.where(eq(schema.narratorToolCalls.messageId, selected.id))
							.run();
					if (mutation === "suffix") {
						db.insert(schema.narratorMessages)
							.values({
								id: "acl-late-suffix",
								narratorId: "narrator",
								role: "user",
								contentJson: [],
								createdAt: new Date().toISOString(),
							})
							.run();
						db.insert(schema.narratorMessageRefs)
							.values({
								id: "acl-late-suffix-ref",
								narratorId: "narrator",
								messageId: "acl-late-suffix",
								seq: 999,
							})
							.run();
					}
					db.update(schema.narrators)
						.set({ messageVersion: 8 })
						.where(eq(schema.narrators.id, "narrator"))
						.run();
				},
			);
			try {
				setService(makeFixtureTransaction(db, options));
				const error = await execution(plan).whenSettled.catch((error) => error);
				expect(error).toMatchObject({ code: "REVERT_SELECTION_STALE" });
				expect(calls).toBe(3);
				expect(fileReads).toBe(0);
				expect(await fs.readFile(a, "utf8")).toBe("changed");
				expect(operation(plan)?.status).toBe("prepared");
			} finally {
				authorize.mockRestore();
			}
		});
	test("a newly appended rollback member invalidates the complete suffix plan", async () => {
		const { a, plan } = await twoFiles();
		db.insert(schema.narratorMessages)
			.values({
				id: "new-suffix",
				narratorId: "narrator",
				role: "user",
				contentJson: [],
				createdAt: new Date().toISOString(),
			})
			.run();
		db.insert(schema.narratorMessageRefs)
			.values({ id: "new-suffix-ref", narratorId: "narrator", messageId: "new-suffix", seq: 999 })
			.run();
		db.update(schema.narrators)
			.set({ messageVersion: 8 })
			.where(eq(schema.narrators.id, "narrator"))
			.run();
		await expect(execution(plan).whenSettled).rejects.toThrow();
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("concurrent duplicate returns current file results while the first attempt runs", async () => {
		const { b, plan } = await twoFiles();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let waiting = true;
		setFileHook(async (path) => {
			if (path === b && waiting) {
				waiting = false;
				entered.resolve();
				await release.promise;
			}
		});
		const first = execution(plan);
		await entered.promise;
		try {
			const duplicate = await execution(plan).whenSettled;
			expect(duplicate.status).toBe("executing");
			expect(duplicate.settling).toBe(true);
			expect(duplicate.files[0].status).toBe("applied");
			expect(duplicate.historyCommitted).toBe(false);
		} finally {
			release.resolve();
		}
		expect((await first.whenSettled).status).toBe("committed");
		const replay = await execution(plan).whenSettled;
		expect(replay.files.map((file) => file.status)).toEqual(["applied", "applied"]);
		expect(replay.status).toBe("committed");
		expect(replay.settling).toBe(false);
	});

	test("lost-result pending attempt is read-only after a new service request", async () => {
		const { a, plan } = await twoFiles();
		db.update(schema.revertOperations)
			.set({ status: "applying" })
			.where(eq(schema.revertOperations.id, plan.id))
			.run();
		db.update(schema.revertOperationFiles)
			.set({ status: "applying" })
			.where(eq(schema.revertOperationFiles.id, journalFiles(plan)[0].id))
			.run();
		const result = await execution(plan).whenSettled;
		expect(result.files[0].status).toBe("unknown");
		expect(result.historyCommitted).toBe(false);
		expect(await fs.readFile(a, "utf8")).toBe("changed");
	});
});
