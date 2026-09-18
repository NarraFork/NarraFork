/**
 * A real SQLite archive file, exported and imported back.
 *
 * WHY A REAL FILE
 * ---------------
 * The archive's whole purpose is being a file someone copies to another machine. A test that
 * mocked the file would verify the code talks to itself correctly and prove nothing about the
 * artifact. So every test here runs `fullSync` into an actual `project.db` under a `mkdtemp`
 * directory, then imports it back through `importProject`, and inspects the file with its own
 * SQLite handle in between.
 *
 * WHAT IS COVERED
 * ---------------
 *   - a round trip preserves the conversation graph: messages, refs (with `seq`), tool calls,
 *     subagent parentage, chapter and narrator lineage
 *   - JSON, boolean and `seq` values survive with their types intact
 *   - an OLD archive missing columns still imports, and a RETIRED column in one is not resurrected
 *   - a failed import leaves the main database with nothing partial
 *   - the source file is byte-identical after both a successful and a failed import
 *
 * ISOLATION
 * ---------
 * `tests/preload.ts` repoints NARRAFORK_HOME at a temp directory, so the "main database" here is
 * an isolated one and `server/db/connection.ts` refuses to open the developer's real file. Every
 * row this test creates is deleted in `afterEach`, and every temp directory is removed.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@server/db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
} from "@server/db/schema";
import { ValidationError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import { getProjectDbPath, projectDbManager } from "@server/lib/project-db";
import { ProjectArchiveFile } from "@server/services/project-archive/archive-file";
import { fullSync } from "@server/services/project-db-sync";
import { importProject } from "@server/services/project-import";
import { eq, inArray } from "drizzle-orm";

const tempDirs: string[] = [];
const createdProjects: string[] = [];
const createdNarrators: string[] = [];
const createdMessages: string[] = [];

afterEach(async () => {
	// Order matters: message-level rows reference narrators, which reference chapters.
	if (createdMessages.length > 0) {
		await db.delete(narratorToolCalls).where(inArray(narratorToolCalls.messageId, createdMessages));
		await db
			.delete(narratorMessageRefs)
			.where(inArray(narratorMessageRefs.messageId, createdMessages));
		await db.delete(narratorMessages).where(inArray(narratorMessages.id, createdMessages));
		createdMessages.length = 0;
	}
	if (createdNarrators.length > 0) {
		await db.delete(narrators).where(inArray(narrators.id, createdNarrators));
		createdNarrators.length = 0;
	}
	for (const projectId of createdProjects.splice(0)) {
		projectDbManager.close(projectId);
		await db.delete(chapters).where(eq(chapters.projectId, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A project with one chapter, one narrator, and a small conversation with a subagent call. */
interface Fixture {
	gitPath: string;
	projectId: string;
	chapterId: string;
	narratorId: string;
	userMessageId: string;
	assistantMessageId: string;
	subagentMessageId: string;
	toolCallId: string;
	toolUseId: string;
}

async function createFixture(prefix: string): Promise<Fixture> {
	const gitPath = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(gitPath);
	const now = new Date().toISOString();
	const projectId = generateId();
	const chapterId = generateId();
	const narratorId = generateId();
	const userMessageId = generateId();
	const assistantMessageId = generateId();
	const subagentMessageId = generateId();
	const toolCallId = generateId();
	const toolUseId = `toolu_${generateId()}`;

	createdProjects.push(projectId);
	createdNarrators.push(narratorId);
	createdMessages.push(userMessageId, assistantMessageId, subagentMessageId);

	await db.insert(projects).values({
		id: projectId,
		name: "Round trip",
		description: "carried through the archive",
		gitPath,
		defaultBranch: "main",
		// A parsed JSON column: Drizzle hands this back as an object, so the export must
		// re-serialize it rather than store "[object Object]".
		chapterSettings: { autoStart: true, ports: [3000, 3001] },
		createdAt: now,
		updatedAt: now,
	});

	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "merged without a commit",
		branch: "chapter/roundtrip",
		baseBranch: "main",
		status: "merged",
		role: "branch",
		// Null on purpose: a snapshot merge leaves it null, and the snapshot coordinates below
		// are then the only description of what happened.
		mergeCommitSha: null,
		snapshotCommitSha: "a".repeat(40),
		// Contains a NUL byte, exactly as the real shadow key does.
		snapshotShadowKey: "local\u0000/tmp/some/worktree",
		mergeSnapshotCommitSha: "d".repeat(40),
		mergedSourceSnapshotSha: "f".repeat(40),
		isRoot: 0,
		commitCount: 7,
		pinned: 1,
		axisOffset: 12.5,
		forkPoint: { sha: "b".repeat(40), branch: "main" },
		createdAt: now,
		updatedAt: now,
	});

	await db.insert(narrators).values({
		id: narratorId,
		chapterId,
		title: "Round-trip narrator",
		// A parsed JSON array column.
		traits: ["plan", "standalone"],
		// A plain TEXT column that happens to hold JSON text — must NOT be double-encoded.
		substatus: '["unread"]',
		isBackground: true,
		messageVersion: 3,
		totalCostUsd: 1.25,
		createdAt: now,
		updatedAt: now,
	});

	await db.insert(narratorMessages).values([
		{
			id: userMessageId,
			narratorId,
			role: "user",
			contentJson: [{ type: "text", text: "do the thing" }],
			contentText: "do the thing",
			createdAt: now,
		},
		{
			id: assistantMessageId,
			narratorId,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: "Task", input: {} }],
			outputTokens: 42,
			createdAt: now,
		},
		{
			// A subagent message: its parentage is what makes the tree reconstructable.
			id: subagentMessageId,
			narratorId,
			role: "assistant",
			parentToolUseId: toolUseId,
			contentJson: [{ type: "text", text: "subagent said this" }],
			createdAt: now,
		},
	]);

	await db.insert(narratorMessageRefs).values([
		// seq 0 is deliberately first: a truthiness-based mapping would drop it.
		{ id: generateId(), narratorId, messageId: userMessageId, seq: 0, isCompact: 0 },
		{ id: generateId(), narratorId, messageId: assistantMessageId, seq: 1, isCompact: 1 },
		{ id: generateId(), narratorId, messageId: subagentMessageId, seq: 2, isCompact: 0 },
	]);

	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		narratorId,
		messageId: assistantMessageId,
		toolUseId,
		toolName: "Task",
		inputJson: { prompt: "explore" },
		outputJson: { result: "done" },
		status: "success",
		durationMs: 1234,
		executionDeviceId: "local",
		createdAt: now,
	});

	return {
		gitPath,
		projectId,
		chapterId,
		narratorId,
		userMessageId,
		assistantMessageId,
		subagentMessageId,
		toolCallId,
		toolUseId,
	};
}

/** Open the archive read-only, run `fn`, and always close the handle. */
function withArchive<T>(gitPath: string, fn: (conn: Database) => T): T {
	const conn = new Database(getProjectDbPath(gitPath), { readonly: true });
	try {
		return fn(conn);
	} finally {
		conn.close();
	}
}

/** Delete the project from the main database, leaving the archive on disk. */
async function forgetProject(fixture: Fixture): Promise<void> {
	projectDbManager.close(fixture.projectId);
	await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, fixture.narratorId));
	await db
		.delete(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, fixture.narratorId));
	await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, fixture.narratorId));
	await db.delete(narrators).where(eq(narrators.id, fixture.narratorId));
	await db.delete(chapters).where(eq(chapters.projectId, fixture.projectId));
	await db.delete(projects).where(eq(projects.id, fixture.projectId));
}

/** size + sha256, to prove a file was not modified. */
function fingerprint(path: string): { size: number; hash: string } {
	return {
		size: statSync(path).size,
		hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
	};
}

describe("export writes a real, self-describing SQLite file", () => {
	test("the archive is a plain SQLite database on disk", async () => {
		const fixture = await createFixture("nf-arc-file-");
		await fullSync(fixture.projectId);
		const path = getProjectDbPath(fixture.gitPath);

		// The magic header is what makes this file portable: any SQLite, on any machine, in any
		// language, can open it. That is the property the whole design rests on.
		const header = readFileSync(path).subarray(0, 16).toString("latin1");
		expect(header).toBe("SQLite format 3\u0000");

		withArchive(fixture.gitPath, (conn) => {
			const tables = (
				conn
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
					.all() as Array<{ name: string }>
			).map((row) => row.name);
			// No foreign keys in the archive, deliberately: it must be writable in any order and
			// readable in any state.
			expect(tables).toContain("projects");
			expect(tables).toContain("chapters");
			expect(tables).toContain("narrator_messages");
			expect(tables).toContain("narrator_message_refs");
			expect(tables).toContain("narrator_tool_calls");
		});
	});

	test("JSON, boolean and seq values land with the right on-disk types", async () => {
		const fixture = await createFixture("nf-arc-types-");
		await fullSync(fixture.projectId);

		withArchive(fixture.gitPath, (conn) => {
			const project = conn
				.prepare(
					"SELECT chapter_settings, typeof(chapter_settings) AS t FROM projects WHERE id = ?",
				)
				.get(fixture.projectId) as { chapter_settings: string; t: string };
			// A parsed JSON column re-serialized to TEXT — not "[object Object]", and not double
			// encoded either.
			expect(project.t).toBe("text");
			expect(JSON.parse(project.chapter_settings)).toEqual({
				autoStart: true,
				ports: [3000, 3001],
			});

			const narrator = conn
				.prepare(
					"SELECT traits, substatus, is_background, typeof(is_background) AS bt, " +
						"message_version, plan_mode, total_cost_usd, typeof(total_cost_usd) AS ct " +
						"FROM narrators WHERE id = ?",
				)
				.get(fixture.narratorId) as Record<string, unknown>;
			expect(JSON.parse(narrator.traits as string)).toEqual(["plan", "standalone"]);
			// The one that would break silently: `substatus` is TEXT holding JSON text, so
			// stringifying it again would store "\"[\\\"unread\\\"]\"".
			expect(narrator.substatus).toBe('["unread"]');
			// Booleans stored as INTEGER, so the archive's type is the format's rather than the
			// driver's coercion.
			expect(narrator.bt).toBe("integer");
			expect(narrator.is_background).toBe(1);
			expect(narrator.message_version).toBe(3);
			// Derived from `traits`, not copied from the main column: `traits` is what the product
			// actually reads at runtime.
			expect(narrator.plan_mode).toBe(1);
			expect(narrator.ct).toBe("real");
			expect(narrator.total_cost_usd).toBeCloseTo(1.25, 5);

			const refs = conn
				.prepare(
					"SELECT message_id, seq, is_compact FROM narrator_message_refs " +
						"WHERE narrator_id = ? ORDER BY seq",
				)
				.all(fixture.narratorId) as Array<{ message_id: string; seq: number; is_compact: number }>;
			// seq 0 present and first: a truthiness filter anywhere in the pipeline drops it.
			expect(refs.map((r) => r.seq)).toEqual([0, 1, 2]);
			expect(refs[0].message_id).toBe(fixture.userMessageId);
			expect(refs[1].is_compact).toBe(1);

			const chapter = conn
				.prepare(
					"SELECT merge_commit_sha, snapshot_commit_sha, snapshot_shadow_key, " +
						"merged_source_snapshot_sha, pinned, axis_offset, commit_count, fork_point " +
						"FROM chapters WHERE id = ?",
				)
				.get(fixture.chapterId) as Record<string, unknown>;
			// The state that used to lose all its context on import.
			expect(chapter.merge_commit_sha).toBeNull();
			expect(chapter.snapshot_commit_sha).toBe("a".repeat(40));
			// A NUL byte inside TEXT must survive: a truncating path would corrupt the key the
			// orphan sweep matches on.
			expect(chapter.snapshot_shadow_key).toBe("local\u0000/tmp/some/worktree");
			expect(chapter.merged_source_snapshot_sha).toBe("f".repeat(40));
			expect(chapter.pinned).toBe(1);
			expect(chapter.axis_offset).toBeCloseTo(12.5, 5);
			expect(chapter.commit_count).toBe(7);
			expect(JSON.parse(chapter.fork_point as string)).toEqual({
				sha: "b".repeat(40),
				branch: "main",
			});

			const toolCall = conn
				.prepare(
					"SELECT input_json, output_json, duration_ms, status FROM narrator_tool_calls WHERE id = ?",
				)
				.get(fixture.toolCallId) as Record<string, unknown>;
			expect(JSON.parse(toolCall.input_json as string)).toEqual({ prompt: "explore" });
			expect(JSON.parse(toolCall.output_json as string)).toEqual({ result: "done" });
			expect(toolCall.duration_ms).toBe(1234);
			expect(toolCall.status).toBe("success");
		});
	});

	test("the machine-local coordinates are absent from the file, not merely null", async () => {
		const fixture = await createFixture("nf-arc-parked-");
		await db
			.update(chapters)
			.set({
				parkedSnapshotCommitSha: "1".repeat(40),
				parkedSnapshotBaseTree: "2".repeat(40),
			})
			.where(eq(chapters.id, fixture.chapterId));
		await fullSync(fixture.projectId);

		withArchive(fixture.gitPath, (conn) => {
			const columns = (
				conn.prepare('PRAGMA table_info("chapters")').all() as Array<{ name: string }>
			).map((c) => c.name);
			// Absent from the schema entirely. They name commits in THIS machine's shadow
			// repository for a rebase still in flight; imported elsewhere the next rebase settles
			// them, resolves nothing, and reports work lost that was never there.
			expect(columns).not.toContain("parked_snapshot_commit_sha");
			expect(columns).not.toContain("parked_snapshot_base_tree");
			// The merge coordinates, which legitimately travel, are still there — so removing the
			// parked ones did not shift anything.
			expect(columns).toContain("merge_snapshot_commit_sha");
		});
	});

	test("archive pages report exact bytes and enforce row and batch byte ceilings", async () => {
		const fixture = await createFixture("nf-arc-read-bounds-");
		await fullSync(fixture.projectId);
		const archive = ProjectArchiveFile.open(fixture.gitPath);
		try {
			const columns = archive.columnsFor("narrator_messages");
			const one = archive.readTable("narrator_messages", columns, { limit: 1 });
			expect(one.rows).toHaveLength(1);
			expect(one.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(one.rows), "utf8"));

			const rowLimit = one.serializedBytes - 3;
			try {
				archive.readTable("narrator_messages", columns, {
					limit: 1,
					maxRowSerializedBytes: rowLimit,
				});
				throw new Error("expected row byte limit rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(ValidationError);
				expect((error as ValidationError).code).toBe("PROJECT_ARCHIVE_LIMIT_EXCEEDED");
				expect((error as Error).message).toContain("serialized row limit");
			}

			try {
				archive.readTable("narrator_messages", columns, {
					limit: 2,
					maxBatchSerializedBytes: one.serializedBytes,
				});
				throw new Error("expected batch byte limit rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(ValidationError);
				expect((error as ValidationError).code).toBe("PROJECT_ARCHIVE_LIMIT_EXCEEDED");
				expect((error as Error).message).toContain("serialized batch limit");
			}
		} finally {
			archive.close();
		}
	});
});

describe("import reads the archive back into the main database", () => {
	test("a full round trip restores the conversation graph", async () => {
		const fixture = await createFixture("nf-arc-round-");
		await fullSync(fixture.projectId);
		await forgetProject(fixture);

		// Nothing left to restore from except the file.
		expect(
			await db.query.projects.findFirst({ where: eq(projects.id, fixture.projectId) }),
		).toBeUndefined();

		const result = await importProject(fixture.gitPath);
		expect(result.skipped).toBe(false);
		expect(result.projectId).toBe(fixture.projectId);
		expect(result.projectName).toBe("Round trip");
		expect(result.tables.narrators).toBe(1);
		expect(result.tables.narrator_messages).toBe(3);
		expect(result.tables.narrator_message_refs).toBe(3);
		expect(result.tables.narrator_tool_calls).toBe(1);

		const project = await db.query.projects.findFirst({
			where: eq(projects.id, fixture.projectId),
		});
		// The project may have moved since the archive was written, so the current path wins.
		expect(project?.gitPath).toBe(fixture.gitPath);
		// A parsed JSON column survives as a parsed object, not as a string of a string.
		expect(project?.chapterSettings).toEqual({ autoStart: true, ports: [3000, 3001] });

		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, fixture.chapterId),
		});
		expect(chapter?.status).toBe("merged");
		expect(chapter?.mergeCommitSha).toBeNull();
		// Without these the chapter reads as "merged, no merge commit" and both `unmerge` and
		// `wake` reject it.
		expect(chapter?.snapshotCommitSha).toBe("a".repeat(40));
		expect(chapter?.snapshotShadowKey).toBe("local\u0000/tmp/some/worktree");
		expect(chapter?.mergedSourceSnapshotSha).toBe("f".repeat(40));
		expect(chapter?.commitCount).toBe(7);
		expect(chapter?.forkPoint).toEqual({ sha: "b".repeat(40), branch: "main" });
		// Never carried, so it takes the importing install's default rather than a stale value.
		expect(chapter?.parkedSnapshotCommitSha).toBeNull();

		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, fixture.narratorId),
		});
		expect(narrator?.title).toBe("Round-trip narrator");
		expect(narrator?.traits).toEqual(["plan", "standalone"]);
		expect(narrator?.substatus).toBe('["unread"]');
		// An INTEGER 0/1 in the archive read back through a `{ mode: "boolean" }` column.
		expect(narrator?.isBackground).toBe(true);
		expect(narrator?.messageVersion).toBe(3);

		// The refs are what make messages visible at all: a message without one shows up in the
		// frontend as "Message not found".
		const refs = await db
			.select()
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, fixture.narratorId));
		expect(refs.map((r) => r.seq).sort((a, b) => a - b)).toEqual([0, 1, 2]);
		expect(refs.find((r) => r.seq === 1)?.isCompact).toBe(1);
		expect(new Set(refs.map((r) => r.messageId))).toEqual(
			new Set([fixture.userMessageId, fixture.assistantMessageId, fixture.subagentMessageId]),
		);

		const messages = await db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, fixture.narratorId));
		expect(messages).toHaveLength(3);
		const subagent = messages.find((m) => m.id === fixture.subagentMessageId);
		// The subagent's parentage: lose it and the message detaches from the tool call it
		// belongs to, which is how a subagent's whole transcript disappears from the UI.
		expect(subagent?.parentToolUseId).toBe(fixture.toolUseId);
		const assistant = messages.find((m) => m.id === fixture.assistantMessageId);
		expect(assistant?.contentJson).toEqual([
			{ type: "tool_use", id: fixture.toolUseId, name: "Task", input: {} },
		]);
		expect(assistant?.outputTokens).toBe(42);

		const toolCalls = await db
			.select()
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.narratorId, fixture.narratorId));
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].messageId).toBe(fixture.assistantMessageId);
		expect(toolCalls[0].toolUseId).toBe(fixture.toolUseId);
		expect(toolCalls[0].inputJson).toEqual({ prompt: "explore" });
		expect(toolCalls[0].outputJson).toEqual({ result: "done" });
		expect(toolCalls[0].durationMs).toBe(1234);
		// An enum column: it round-trips as text, and a value outside the enum would make the
		// imported call unrenderable. `success`/`fail` are the terminal states — not "completed",
		// which is what this fixture said until tsgo rejected it.
		expect(toolCalls[0].status).toBe("success");
	});

	test("importing a project that already exists changes nothing", async () => {
		const fixture = await createFixture("nf-arc-skip-");
		await fullSync(fixture.projectId);

		await db
			.update(projects)
			.set({ name: "Renamed after the backup" })
			.where(eq(projects.id, fixture.projectId));

		const result = await importProject(fixture.gitPath);
		expect(result.skipped).toBe(true);
		expect(result.tables).toEqual({});

		// The live row wins: an import must not silently revert the user's current state to a
		// backup they did not ask to restore.
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, fixture.projectId),
		});
		expect(project?.name).toBe("Renamed after the backup");
	});

	test("the source archive is byte-identical after a successful import", async () => {
		const fixture = await createFixture("nf-arc-readonly-");
		await fullSync(fixture.projectId);
		await forgetProject(fixture);

		const path = getProjectDbPath(fixture.gitPath);
		const before = fingerprint(path);
		await importProject(fixture.gitPath);
		const after = fingerprint(path);

		// The user's archive is often their only backup. An import that also mutated it would
		// destroy the thing they would retry from — so the handle is opened read-only and this
		// asserts the consequence rather than the intent.
		expect(after).toEqual(before);
	});
});

describe("compatibility with archives this version did not write", () => {
	test("an archive missing columns still imports", async () => {
		const fixture = await createFixture("nf-arc-oldfile-");
		await fullSync(fixture.projectId);
		await forgetProject(fixture);

		// Rebuild `narrator_tool_calls` without the four target columns, reproducing an archive
		// written before `ensureProjectToolCallTargetColumns` existed. `ALTER TABLE … DROP COLUMN`
		// is the honest way to produce that file: the resulting schema is what an older version
		// actually wrote.
		const writable = new Database(getProjectDbPath(fixture.gitPath));
		for (const column of [
			"execution_path_flavor",
			"canonical_file_path",
			"runtime_generation",
			"execution_targets_json",
		]) {
			writable.run(`ALTER TABLE narrator_tool_calls DROP COLUMN ${column}`);
		}
		const remaining = (
			writable.prepare("PRAGMA table_info(narrator_tool_calls)").all() as Array<{ name: string }>
		).map((c) => c.name);
		expect(remaining).not.toContain("execution_path_flavor");
		writable.close();

		const result = await importProject(fixture.gitPath);
		expect(result.skipped).toBe(false);
		expect(result.tables.narrator_tool_calls).toBe(1);

		const toolCalls = await db
			.select()
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.narratorId, fixture.narratorId));
		expect(toolCalls).toHaveLength(1);
		// The columns the file lacked take the main database's defaults rather than blocking the
		// row or shifting the ones that were present.
		expect(toolCalls[0].executionPathFlavor).toBeNull();
		expect(toolCalls[0].toolName).toBe("Task");
		expect(toolCalls[0].inputJson).toEqual({ prompt: "explore" });
	});

	test("a retired column sitting in an old archive is not resurrected", async () => {
		const fixture = await createFixture("nf-arc-retired-");
		await fullSync(fixture.projectId);

		const writable = new Database(getProjectDbPath(fixture.gitPath));
		// These three existed, were removed from the product, and may still sit in an old file.
		// An import that copied whatever both databases happened to share would bring them back.
		for (const definition of [
			"prune_enabled INTEGER",
			"prune_boundary_message_id TEXT",
			"pruned_percent INTEGER",
		]) {
			writable.run(`ALTER TABLE narrators ADD COLUMN ${definition}`);
		}
		writable.run(
			"UPDATE narrators SET prune_enabled = 1, prune_boundary_message_id = 'obsolete', pruned_percent = 75",
		);
		writable.close();

		await forgetProject(fixture);
		const result = await importProject(fixture.gitPath);
		expect(result.skipped).toBe(false);
		expect(result.tables.narrators).toBe(1);

		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, fixture.narratorId),
		});
		expect(narrator?.title).toBe("Round-trip narrator");
		expect(narrator).not.toHaveProperty("prunedPercent");
		expect(narrator).not.toHaveProperty("pruneEnabled");
	});

	test("an archive with a missing table imports the tables it has", async () => {
		const fixture = await createFixture("nf-arc-notable-");
		await fullSync(fixture.projectId);
		await forgetProject(fixture);

		// `narrator_patches` has no writer in the export, so a fresh archive has the table but no
		// rows. Dropping it entirely is the shape of an archive predating the table.
		const writable = new Database(getProjectDbPath(fixture.gitPath));
		writable.run("DROP TABLE narrator_patches");
		writable.close();

		const result = await importProject(fixture.gitPath);
		expect(result.skipped).toBe(false);
		// Reported as zero rather than throwing: a missing table is an ordinary shape for an old
		// archive, not a corrupt file.
		expect(result.tables.narrator_patches).toBe(0);
		expect(result.tables.narrators).toBe(1);
		expect(
			await db.query.chapters.findFirst({ where: eq(chapters.id, fixture.chapterId) }),
		).toBeDefined();
	});

	test("an archive with no project record is rejected before anything is written", async () => {
		const fixture = await createFixture("nf-arc-noproject-");
		await fullSync(fixture.projectId);
		await forgetProject(fixture);

		const writable = new Database(getProjectDbPath(fixture.gitPath));
		writable.run("DELETE FROM projects");
		writable.close();

		await expect(importProject(fixture.gitPath)).rejects.toThrow(/no project record/);
		// Nothing partial: the chapters and narrators still in the file were not written either,
		// because the rejection happens before the transaction opens.
		expect(
			await db.query.chapters.findFirst({ where: eq(chapters.id, fixture.chapterId) }),
		).toBeUndefined();
		expect(
			await db.query.narrators.findFirst({ where: eq(narrators.id, fixture.narratorId) }),
		).toBeUndefined();
	});

	test("a missing archive file is a not-found error", async () => {
		const gitPath = mkdtempSync(join(tmpdir(), "nf-arc-absent-"));
		tempDirs.push(gitPath);
		// The route turns this into a 404, which is the pre-existing behavior.
		await expect(importProject(gitPath)).rejects.toThrow(/Project database/);
	});
});

describe("import resource budgets reject before the main-database transaction", () => {
	test("the total row ceiling fails with no partial writes", async () => {
		const fixture = await createFixture("nf-arc-row-limit-");
		await fullSync(fixture.projectId);
		await forgetProject(fixture);

		try {
			await importProject(fixture.gitPath, { maxTotalRows: 1 });
			throw new Error("expected total row limit rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).code).toBe("PROJECT_ARCHIVE_LIMIT_EXCEEDED");
			expect((error as Error).message).toContain("1-row import limit");
		}

		expect(
			await db.query.projects.findFirst({ where: eq(projects.id, fixture.projectId) }),
		).toBeUndefined();
		expect(
			await db.query.chapters.findFirst({ where: eq(chapters.id, fixture.chapterId) }),
		).toBeUndefined();
		expect(
			await db.query.narrators.findFirst({ where: eq(narrators.id, fixture.narratorId) }),
		).toBeUndefined();
	});

	test("the total serialized-byte ceiling fails with no partial writes", async () => {
		const fixture = await createFixture("nf-arc-byte-limit-");
		await fullSync(fixture.projectId);
		await forgetProject(fixture);

		try {
			await importProject(fixture.gitPath, { maxTotalSerializedBytes: 1 });
			throw new Error("expected total byte limit rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).code).toBe("PROJECT_ARCHIVE_LIMIT_EXCEEDED");
			expect((error as Error).message).toContain("1-byte serialized import limit");
		}

		expect(
			await db.query.projects.findFirst({ where: eq(projects.id, fixture.projectId) }),
		).toBeUndefined();
		expect(
			await db.query.chapters.findFirst({ where: eq(chapters.id, fixture.chapterId) }),
		).toBeUndefined();
		expect(
			await db.query.narrators.findFirst({ where: eq(narrators.id, fixture.narratorId) }),
		).toBeUndefined();
	});
});

describe("a failed import leaves nothing behind", () => {
	test("a foreign-key violation rolls back every table", async () => {
		const fixture = await createFixture("nf-arc-fkfail-");
		await fullSync(fixture.projectId);
		await forgetProject(fixture);

		// Point the chapter at an exploration group that does not exist. The archive has no
		// foreign keys so it accepts this happily; the MAIN database enforces them per statement,
		// and `INSERT OR IGNORE` does NOT swallow a foreign-key failure — it throws.
		const writable = new Database(getProjectDbPath(fixture.gitPath));
		writable.run("UPDATE chapters SET exploration_group_id = ?", ["missing-group-id"]);
		writable.close();

		await expect(importProject(fixture.gitPath)).rejects.toThrow();

		// The project row is inserted BEFORE chapters in the import order, so if the transaction
		// were not real it would survive the later failure. This is the assertion that proves the
		// atomic section replaced the old raw BEGIN/COMMIT correctly.
		expect(
			await db.query.projects.findFirst({ where: eq(projects.id, fixture.projectId) }),
		).toBeUndefined();
		expect(
			await db.query.chapters.findFirst({ where: eq(chapters.id, fixture.chapterId) }),
		).toBeUndefined();
		expect(
			await db.query.narrators.findFirst({ where: eq(narrators.id, fixture.narratorId) }),
		).toBeUndefined();
		const messages = await db
			.select()
			.from(narratorMessages)
			.where(inArray(narratorMessages.id, [fixture.userMessageId, fixture.assistantMessageId]));
		expect(messages).toHaveLength(0);
	});

	test("the source archive is byte-identical after a failed import", async () => {
		const fixture = await createFixture("nf-arc-failsafe-");
		await fullSync(fixture.projectId);
		await forgetProject(fixture);

		const writable = new Database(getProjectDbPath(fixture.gitPath));
		writable.run("UPDATE chapters SET exploration_group_id = ?", ["missing-group-id"]);
		writable.close();

		const path = getProjectDbPath(fixture.gitPath);
		const before = fingerprint(path);
		await expect(importProject(fixture.gitPath)).rejects.toThrow();
		const after = fingerprint(path);

		// The failure case is the one that matters most: this is precisely when the user needs
		// their backup intact to retry from.
		expect(after).toEqual(before);
	});
});
