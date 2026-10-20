import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { FileReference, FileReferenceSnapshot } from "@shared/file-reference";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTestDb } from "../../../tests/setup";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import {
	parseFileReferenceSnapshotsJson,
	projectFileReferenceText,
} from "../../lib/agent/file-reference-projection";

// Bun module mocks are process-global. Keep the fixture in a bounded child so a
// whole-directory test run never inherits this tiny database or its closed handle.
if (process.env.NARRAFORK_FILE_REFERENCE_FIXTURE !== "storage") {
	test("isolated file reference storage suite", async () => {
		// Asynchronous and bounded: a child that finishes its tests but stalls on exit must
		// fail this case with its output, not block the worker in a synchronous wait.
		const { safeSpawn } = await import("../../lib/spawn");
		const env: Record<string, string | undefined> = {
			...process.env,
			NARRAFORK_FILE_REFERENCE_FIXTURE: "storage",
		};
		delete env.NARRAFORK_HOME;
		const result = await safeSpawn({
			cmd: [process.execPath, "test", import.meta.path],
			env,
			timeout: 60_000,
			maxOutputBytes: 512 * 1024,
			killProcessTree: true,
		});
		if (result.exitCode !== 0)
			throw new Error(
				`Fixture failed (exit ${result.exitCode})\n${result.stdout}\n${result.stderr}`,
			);
		// The child really ran the suite (not an empty filter match).
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/\b10 pass\b/);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/\b0 fail\b/);
	}, 65_000);
} else {
	// Isolated in-memory schema includes the durable mailbox identity columns.
	const { sqlite } = getTestDb();
	const queries: string[] = [];
	const db = drizzle({
		client: sqlite,
		schema: { ...schema, ...relations },
		logger: {
			logQuery(query) {
				queries.push(query);
			},
		},
	});
	db.insert(schema.narrators)
		.values({ id: "n", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
		.run();
	db.insert(schema.users)
		.values({
			id: "u",
			username: "fixture",
			passwordHash: "fixture",
			createdAt: new Date().toISOString(),
		})
		.run();
	mock.module("../../db", () => ({ db, sqlite }));
	const drafts = await import("../narrator-draft-service");
	const buffer = await import("../narrator-buffer");
	const state = await import("../narrator-session-state");

	function reference(id = "ref-1"): FileReference {
		return {
			id,
			deviceId: "remote-A",
			path: "/missing/file.ts",
			label: "#file:file.ts",
			inputRange: [0, 13],
		};
	}
	function snapshot(id = "ref-1"): FileReferenceSnapshot {
		return {
			type: "file_reference",
			reference: reference(id),
			snapshotText: "accepted original contents",
			snapshotHash: "hash-original",
			capturedAt: "2026-09-01T00:00:00.000Z",
		};
	}
	function makeBusy() {
		state.compactLocks.set("n", {
			kind: "history",
			promise: Promise.resolve({ kind: "history", compacted: false }),
		});
	}
	function push(text: string, refs: FileReferenceSnapshot[], position: "front" | "back" = "back") {
		return buffer.pushBufferedMessage(
			"n",
			text,
			undefined,
			null,
			"u",
			null,
			undefined,
			position,
			null,
			refs,
		);
	}
	function queueRow(id: string) {
		return db
			.select()
			.from(schema.narratorBufferedMessages)
			.where(eq(schema.narratorBufferedMessages.id, id))
			.get();
	}

	beforeEach(() => {
		sqlite.exec("DELETE FROM narrator_drafts; DELETE FROM narrator_buffered_messages;");
		state.compactLocks.clear();
		queries.length = 0;
	});
	afterAll(() => {
		state.compactLocks.clear();
		sqlite.close();
	});

	describe("reference metadata draft sync", () => {
		test("reference-only drafts are present and clear leaves a revision tombstone", async () => {
			expect(await drafts.getNarratorDraft("u", "n")).toMatchObject({
				hasDraft: false,
				fileReferences: [],
			});
			const result = await drafts.updateNarratorDraft("u", "n", "", "device", [reference()]);
			expect(result).toMatchObject({ hasDraft: true, revision: 1, fileReferences: [reference()] });
			expect(await drafts.getNarratorDraft("u", "n")).toMatchObject({
				hasDraft: true,
				text: "",
				fileReferences: [reference()],
			});
			expect(await drafts.narratorHasDraft("u", "n")).toBe(true);
			expect(await drafts.getNarratorIdsWithDraft("u", ["n", "other"])).toEqual(new Set(["n"]));
			expect(await drafts.narratorHasDraft("other-user", "n")).toBe(false);
			const cleared = await drafts.updateNarratorDraft("u", "n", "", "device", []);
			expect(cleared).toMatchObject({
				previousHasDraft: true,
				hasDraft: false,
				revision: 2,
				fileReferences: [],
			});
			expect(await drafts.narratorHasDraft("u", "n")).toBe(false);
			expect(db.select().from(schema.narratorDrafts).get()?.fileReferencesJson).toBeNull();
		});

		test("text and references share one last-writer-wins revision", async () => {
			await drafts.updateNarratorDraft("u", "n", "first", "one", [reference("one")]);
			const [a, b] = await Promise.all([
				drafts.updateNarratorDraft("u", "n", "second", "two", [reference("two")]),
				drafts.updateNarratorDraft("u", "n", "stale", "three", []),
			]);
			// The lock serializes the race: one write lands at revision 2, the other
			// overwrites it at revision 3 and the replaced version stays restorable.
			const [winner, loser] = a.revision === 2 ? [a, b] : [b, a];
			expect(winner.revision).toBe(2);
			expect(loser).toMatchObject({ revision: 3, hasPrevious: true });
			expect(await drafts.getNarratorDraft("u", "n")).toMatchObject({
				revision: 3,
				text: loser.text,
			});
			expect(await drafts.restoreNarratorDraftPrevious("u", "n")).toMatchObject({
				text: winner.text,
			});
		});

		test("omitted legacy refs retain only tokens unchanged at their recorded range", async () => {
			const token = "#file:file.ts";
			const ref = reference();
			ref.inputRange = [0, token.length];
			await drafts.updateNarratorDraft("u", "n", `${token} hello`, "one", [
				ref,
				{ ...reference("chip"), inputRange: undefined },
			]);
			expect(
				await drafts.updateNarratorDraft("u", "n", `${token} updated`, undefined),
			).toMatchObject({ fileReferences: [ref], sourceId: "one" });
			expect(
				await drafts.updateNarratorDraft("u", "n", `prefix ${token} updated`, undefined),
			).toMatchObject({ fileReferences: [] });
			await drafts.updateNarratorDraft("u", "n", token, "one", [ref]);
			expect(await drafts.updateNarratorDraft("u", "n", "", "one")).toMatchObject({
				fileReferences: [],
				hasDraft: false,
			});
		});

		test("copies accepted draft metadata before a caller mutates it", async () => {
			const ref = reference();
			const promise = drafts.updateNarratorDraft("u", "n", "draft", undefined, [ref]);
			ref.path = "/changed";
			ref.inputRange?.splice(0, 1, 99);
			await promise;
			expect((await drafts.getNarratorDraft("u", "n")).fileReferences).toEqual([reference()]);
		});

		test("presence selects only ids, never materializing large draft columns", async () => {
			await drafts.updateNarratorDraft("u", "n", "", undefined, [reference()]);
			queries.length = 0;
			await drafts.narratorHasDraft("u", "n");
			await drafts.getNarratorIdsWithDraft("u", ["n"]);
			for (const query of queries) {
				const projection = query.split(/\sfrom\s/i)[0];
				expect(projection).toContain("narrator_id");
				expect(projection).not.toContain("file_references_json");
				expect(projection).not.toContain('"text"');
			}
		});
	});

	describe("accepted queue snapshot storage", () => {
		test("a failed DB edit or insert cannot replace accepted in-memory references", async () => {
			makeBusy();
			const pushed = await push("original", [snapshot()]);
			sqlite.exec(
				"CREATE TRIGGER fail_queue_update BEFORE UPDATE ON narrator_buffered_messages BEGIN SELECT RAISE(ABORT, 'fixture update failed'); END",
			);
			try {
				await expect(
					buffer.updateBufferedMessage("n", pushed.id, "changed", { fileReferences: [] }),
				).rejects.toThrow();
				expect((await buffer.getBufferedMessages("n"))[0]).toMatchObject({
					text: "original",
					fileReferences: [snapshot()],
				});
			} finally {
				sqlite.exec("DROP TRIGGER fail_queue_update");
			}
			sqlite.exec(
				"CREATE TRIGGER fail_queue_insert BEFORE INSERT ON narrator_buffered_messages BEGIN SELECT RAISE(ABORT, 'fixture insert failed'); END",
			);
			try {
				await expect(push("not accepted", [snapshot("new")])).rejects.toThrow();
				expect((await buffer.getBufferedMessages("n")).map((entry) => entry.id)).toEqual([
					pushed.id,
				]);
			} finally {
				sqlite.exec("DROP TRIGGER fail_queue_insert");
			}
		});

		test("128 KiB accepted material never appears in REST/WS summaries", async () => {
			makeBusy();
			const refs = Array.from({ length: 4 }, (_, index) => ({
				...snapshot(String(index)),
				snapshotText: "z".repeat(32 * 1024),
			}));
			await push("metadata only", refs);
			const json = JSON.stringify(buffer.toBufferSummary(await buffer.getBufferedMessages("n")));
			expect(json.length).toBeLessThan(2048);
			expect(json).not.toContain("zzzz");
			expect(json).not.toContain("snapshotText");
		});

		test("compaction admission stores snapshots once; summary carries only cloned locators", async () => {
			makeBusy();
			const input = snapshot();
			const expected = structuredClone(input);
			const result = await push("", [input]);
			expect(result.ok).toBe(true);
			input.snapshotText = "changed source";
			input.reference.path = "/changed-source";
			const [message] = await buffer.getBufferedMessages("n");
			expect(message.fileReferences).toEqual([expected]);
			expect(parseFileReferenceSnapshotsJson(queueRow(result.id)?.fileReferencesJson)).toEqual([
				expected,
			]);
			const [summary] = buffer.toBufferSummary([message]);
			expect(summary.fileReferences).toEqual([expected.reference]);
			expect(JSON.stringify(summary)).not.toContain(expected.snapshotText);
			expect(JSON.stringify(summary)).not.toContain("snapshotHash");
			summary.fileReferences[0].path = "/summary-mutated";
			expect(message.fileReferences?.[0].reference.path).toBe(expected.reference.path);
		});

		test("text-only edit keeps bytes, replacement swaps them, [] clears metadata and payload", async () => {
			makeBusy();
			const pushed = await push("initial", [snapshot()]);
			await buffer.updateBufferedMessage("n", pushed.id, "edited");
			expect(parseFileReferenceSnapshotsJson(queueRow(pushed.id)?.fileReferencesJson)).toEqual([
				snapshot(),
			]);
			const replacement = snapshot("new");
			await buffer.updateBufferedMessage("n", pushed.id, "new text", {
				fileReferences: [replacement],
			});
			replacement.snapshotText = "mutated caller";
			expect((await buffer.getBufferedMessages("n"))[0].fileReferences).toEqual([snapshot("new")]);
			await buffer.updateBufferedMessage("n", pushed.id, "no refs", { fileReferences: [] });
			expect(queueRow(pushed.id)?.fileReferencesJson).toBeNull();
			expect(
				buffer.toBufferSummary(await buffer.getBufferedMessages("n"))[0].fileReferences,
			).toEqual([]);
		});

		test("priority, recovery and failed dispatch preserve the exact accepted snapshot", async () => {
			makeBusy();
			const ordinary = await push("later", [snapshot("later")]);
			const priority = await push("first", [snapshot("first")], "front");
			expect((await buffer.getBufferedMessages("n")).map((message) => message.id)).toEqual([
				priority.id,
				ordinary.id,
			]);
			const row = queueRow(priority.id);
			expect(row).toBeDefined();
			// Same parser as recoverOnStartup, then the normal failed-dispatch restore.
			const accepted = parseFileReferenceSnapshotsJson(row?.fileReferencesJson);
			const { createMailboxStore } = await import("../agent-runtime/mailbox");
			const [claimed] = createMailboxStore(db).claimBatch(
				"n",
				{ token: "owner", epoch: "storage-test" },
				{ count: 1 },
			);
			const current = buffer.projectMailboxUserMessage(claimed);
			expect(current).toBeDefined();
			await buffer.restoreBufferedMessage("n", current);
			expect(parseFileReferenceSnapshotsJson(queueRow(priority.id)?.fileReferencesJson)).toEqual([
				snapshot("first"),
			]);
			expect(projectFileReferenceText(current.text, accepted)).toContain(
				"accepted original contents",
			);
			expect((await buffer.getBufferedMessages("n")).map((message) => message.id)).toEqual([
				priority.id,
				ordinary.id,
			]);
		});
	});
}
