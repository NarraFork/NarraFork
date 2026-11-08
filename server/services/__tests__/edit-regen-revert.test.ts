/**
 * edit-and-regenerate's file rollback contract.
 *
 * Two properties are asserted here, and both used to be broken:
 *
 *  1. The caller's choice reaches `deleteMessagesAfter`. The old `rollback` flag was
 *     accepted and then ignored, so every edit reverted files while the UI offered a
 *     "keep my changes" button that did nothing.
 *  2. The truncation runs BEFORE this edit's attachments are written. A workspace
 *     rollback deletes paths the target tree does not contain, and a file just saved
 *     into `.narrafork/attached/` is exactly such a path — so the previous order let
 *     the rollback delete the attachment the user had only just added.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";

const DRIZZLE_DIR = join(import.meta.dir, "..", "..", "..", "drizzle");
const sqlite = new Database(":memory:");
sqlite.run("PRAGMA foreign_keys = OFF");
for (const file of readdirSync(DRIZZLE_DIR)
	.filter((f) => f.endsWith(".sql"))
	.sort()) {
	const sql = readFileSync(join(DRIZZLE_DIR, file), "utf-8");
	for (const stmt of sql
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter(Boolean)) {
		try {
			sqlite.run(stmt);
		} catch (err) {
			if (!String(err).includes("already exists")) throw err;
		}
	}
}
sqlite.run("PRAGMA foreign_keys = ON");
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

/**
 * Records what `deleteMessagesAfter` was asked to do, and when relative to the
 * attachment writes. The real implementation needs tree snapshots and a git
 * worktree, neither of which this harness has — and the question under test is the
 * arguments and the ordering, not the rollback mechanics (covered by
 * snapshot-revert-tree.test.ts).
 */
const deleteCalls: Array<{ messageId: string; opts?: Record<string, unknown> }> = [];
const eventLog: string[] = [];

const realNarratorService = { ...(await import("../narrator-service")).narratorService };
mock.module("../narrator-service", () => ({
	narratorService: {
		...realNarratorService,
		deleteMessagesAfter: mock(
			async (_narratorId: string, messageId: string, opts?: Record<string, unknown>) => {
				deleteCalls.push({ messageId, opts });
				eventLog.push("deleteMessagesAfter");
				return { deletedCount: 0, deletedMessageIds: [], revertWarnings: [] };
			},
		),
	},
}));

const realUploads = { ...(await import("../../lib/uploads")) };
mock.module("../../lib/uploads", () => ({
	...realUploads,
	saveTextFileToWorktree: mock(async (cwd: string, file: File) => {
		eventLog.push("saveTextFileToWorktree");
		return { filename: file.name, filePath: join(cwd, file.name), size: file.size };
	}),
}));

const { editAndRegenerate, rollbackToBlock } = await import("../narrator-session");
const { narratorMessages, narratorMessageRefs, narrators } = schema;
const scopedRevert = await import("../narrator-scoped-revert");
const { emptyRevertResult } = await import("../snapshot-revert");

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../narrator-service", () => ({ narratorService: realNarratorService }));
	mock.module("../../lib/uploads", () => realUploads);
	mock.restore();
});

const now = new Date().toISOString();

function seed(cwd: string) {
	db.insert(schema.users)
		.values({ id: "u1", username: "u1", role: "user", passwordHash: "test", createdAt: now })
		.onConflictDoNothing()
		.run();
	sqlite.run("DELETE FROM narrator_message_refs");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
	db.insert(narrators)
		.values({
			id: "n1",
			type: "primary",
			variant: "primary",
			inheritMode: "fresh",
			cwd,
			status: "idle",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: "m1",
			narratorId: "n1",
			role: "user",
			contentJson: [{ type: "text", text: "old" }],
			contentText: "old",
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: "ref-m1", narratorId: "n1", messageId: "m1", seq: 0, isCompact: 0 })
		.run();
}

const confirmedPlan = {
	planId: "confirmed-plan",
	planHash: "a".repeat(64),
	action: "edit_and_regenerate" as const,
};

describe("edit-and-regenerate file rollback", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "nf-edit-revert-"));
		deleteCalls.length = 0;
		eventLog.length = 0;
		seed(cwd);
	});
	const edit = (opts: Parameters<typeof editAndRegenerate>[5] = {}) =>
		editAndRegenerate("n1", "m1", "new", "en", false, {
			userId: "u1",
			deferContinuation: true,
			...opts,
		});

	test("file recovery requires a reviewed plan instead of silently replanning", async () => {
		await expect(edit()).rejects.toThrow("Review a fresh edit preview");
		expect(deleteCalls).toHaveLength(0);
		expect(eventLog).toHaveLength(0);
	});
	test("missing requester cannot borrow narrator ownership", async () => {
		await expect(edit({ userId: null, revertPlan: confirmedPlan })).rejects.toThrow(
			"authenticated",
		);
		expect(deleteCalls).toHaveLength(0);
	});
	test("keep-files explicitly truncates at the original message and does not execute a plan", async () => {
		const restore = spyOn(scopedRevert, "revertNarratorScopedForEdit");
		try {
			await edit({ revertFiles: false });
			expect(deleteCalls).toEqual([
				{ messageId: "m1", opts: { preserveConversationId: true, skipRevert: true } },
			]);
			expect(restore).not.toHaveBeenCalled();
		} finally {
			restore.mockRestore();
		}
	});
	test("retired workspace scope is rejected even for history-only requests", async () => {
		await expect(edit({ revertFiles: false, revertScope: "workspace" })).rejects.toThrow("retired");
		expect(deleteCalls).toHaveLength(0);
	});
	test("executes the confirmed plan before attachments and retains the history advisory", async () => {
		const revertResult = {
			...emptyRevertResult(),
			planId: confirmedPlan.planId,
			historyCommitted: true,
			historyStatus: "unavailable" as const,
		};
		const restore = spyOn(scopedRevert, "revertNarratorScopedForEdit").mockImplementation(
			async () => {
				eventLog.push("confirmedRestore");
				return revertResult;
			},
		);
		try {
			const result = await edit({
				revertPlan: confirmedPlan,
				keepTextFilePaths: [],
				newTextFiles: [new File(["notes"], "added.txt", { type: "text/plain" })],
			});
			expect(result).toEqual({ ok: true, revertResult });
			expect(restore).toHaveBeenCalledWith("n1", "m1", 0, {
				principal: { userId: "u1", isAdmin: false },
				revertPlan: confirmedPlan,
			});
			expect(eventLog).toEqual(["confirmedRestore", "saveTextFileToWorktree"]);
			expect(deleteCalls).toHaveLength(0);
		} finally {
			restore.mockRestore();
		}
	});
	test("partial restore does not save attachments or rewrite the user prompt", async () => {
		const restore = spyOn(scopedRevert, "revertNarratorScopedForEdit").mockResolvedValue({
			...emptyRevertResult(),
			status: "partial",
			historyCommitted: false,
		});
		try {
			await expect(
				edit({ revertPlan: confirmedPlan, newTextFiles: [new File(["notes"], "added.txt")] }),
			).rejects.toThrow();
			expect(eventLog).toHaveLength(0);
			expect(
				sqlite.query("SELECT content_text FROM narrator_messages WHERE id = ?").get("m1"),
			).toEqual({ content_text: "old" });
		} finally {
			restore.mockRestore();
		}
	});
	test("a confirmed restore of available files finishes the edit history-only", async () => {
		const revertResult = {
			...emptyRevertResult(),
			planId: confirmedPlan.planId,
			status: "partial" as const,
			journalStatus: "partial" as const,
			reason: "SELECTED_HISTORY_UNAVAILABLE",
			historyCommitted: false,
			files: [{ deviceId: "local", filePath: "a.ts", status: "applied" as const }],
		};
		const restore = spyOn(scopedRevert, "revertNarratorScopedForEdit").mockImplementation(
			async () => {
				eventLog.push("confirmedRestore");
				return revertResult;
			},
		);
		try {
			const result = await edit({
				revertPlan: confirmedPlan,
				keepTextFilePaths: [],
				newTextFiles: [new File(["notes"], "added.txt", { type: "text/plain" })],
			});
			expect(result).toEqual({ ok: true, revertResult });
			expect(deleteCalls).toEqual([
				{ messageId: "m1", opts: { preserveConversationId: true, skipRevert: true } },
			]);
			expect(eventLog).toEqual([
				"confirmedRestore",
				"deleteMessagesAfter",
				"saveTextFileToWorktree",
			]);
		} finally {
			restore.mockRestore();
		}
	});
	test("a partial-coverage restore with a failed file still refuses the edit", async () => {
		const restore = spyOn(scopedRevert, "revertNarratorScopedForEdit").mockResolvedValue({
			...emptyRevertResult(),
			status: "partial",
			journalStatus: "partial",
			reason: "SELECTED_HISTORY_UNAVAILABLE",
			historyCommitted: false,
			files: [{ deviceId: "local", filePath: "a.ts", status: "failed", reason: "EACCES" }],
		});
		try {
			await expect(edit({ revertPlan: confirmedPlan })).rejects.toThrow();
			expect(deleteCalls).toHaveLength(0);
			expect(
				sqlite.query("SELECT content_text FROM narrator_messages WHERE id = ?").get("m1"),
			).toEqual({ content_text: "old" });
		} finally {
			restore.mockRestore();
		}
	});
});

describe("right-click rollback uses one fixed block-boundary plan", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "nf-rollback-path-"));
		deleteCalls.length = 0;
		eventLog.length = 0;
		seed(cwd);
	});

	test("rollbackToBlock freezes the effective block boundary with the requester", async () => {
		const restore = spyOn(scopedRevert, "revertNarratorScopedToBlock").mockResolvedValue({
			...emptyRevertResult(),
			historyCommitted: true,
		});
		const principal = { userId: "u1", isAdmin: false };
		try {
			await rollbackToBlock("n1", "m1", 0, { principal });
			expect(restore).toHaveBeenCalledWith("n1", "m1", 0, { principal });
			expect(deleteCalls).toHaveLength(0);
		} finally {
			restore.mockRestore();
		}
	});
});
