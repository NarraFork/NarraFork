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
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
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

const { closeNarrator, editAndRegenerate } = await import("../narrator-session");
const { narratorMessages, narratorMessageRefs, narrators } = schema;

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../narrator-service", () => ({ narratorService: realNarratorService }));
	mock.module("../../lib/uploads", () => realUploads);
	mock.restore();
});

const now = new Date().toISOString();

function seed(cwd: string) {
	sqlite.run("DELETE FROM narrator_message_refs");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
	db.insert(narrators)
		.values({
			id: "n1",
			chapterId: null,
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

/** The agent loop cannot run in this harness; everything asserted happens before it. */
async function runEdit(opts?: Parameters<typeof editAndRegenerate>[5]) {
	try {
		await editAndRegenerate("n1", "m1", "new", "en", false, opts);
	} catch {
		/* expected: no provider is reachable */
	}
	closeNarrator("n1");
}

describe("edit-and-regenerate file rollback", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "nf-edit-revert-"));
		deleteCalls.length = 0;
		eventLog.length = 0;
		seed(cwd);
	});

	test("reverts files by default, matching the behaviour every edit had", async () => {
		await runEdit({ userId: null });
		expect(deleteCalls).toHaveLength(1);
		expect(deleteCalls[0]?.opts?.skipRevert).toBeFalsy();
		expect(deleteCalls[0]?.opts?.preserveConversationId).toBe(true);
	});

	test("skips the file rollback when the caller keeps its changes", async () => {
		await runEdit({ userId: null, revertFiles: false });
		expect(deleteCalls[0]?.opts?.skipRevert).toBe(true);
	});

	test("forwards the requested scope", async () => {
		await runEdit({ userId: null, revertFiles: true, revertScope: "workspace" });
		expect(deleteCalls[0]?.opts?.scope).toBe("workspace");
	});

	test("omits scope entirely when the caller did not choose one", async () => {
		// Absent, not null: the server's own default has to stay in charge.
		await runEdit({ userId: null });
		expect(deleteCalls[0]?.opts && "scope" in deleteCalls[0].opts).toBe(false);
	});

	test("truncates the tail at the original message id", async () => {
		// Copy-on-write may hand the row a new id, but the ref keeps its seq — so the
		// boundary must be the id the caller passed, not the post-COW one.
		await runEdit({ userId: null });
		expect(deleteCalls[0]?.messageId).toBe("m1");
	});

	test("reverts before writing this edit's attachments", async () => {
		// The ordering IS the fix: reversed, a workspace rollback deletes the file
		// that was just saved into the worktree.
		await runEdit({
			userId: null,
			keepTextFilePaths: [],
			newTextFiles: [new File(["notes"], "added.txt", { type: "text/plain" })],
		});
		expect(eventLog).toEqual(["deleteMessagesAfter", "saveTextFileToWorktree"]);
	});
});
