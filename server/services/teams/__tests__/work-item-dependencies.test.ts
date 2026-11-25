/**
 * Dependencies between work items (D), at the service level against the migrated test database:
 * set / read / clear; same team only, no self edge, no cycle, at most 20, no cancelled target;
 * a blocked start is refused with 409; the last dependency merging records `work.unblocked` and
 * tells the coordinator exactly once; a cancelled dependency blocks until it is replaced; the
 * board and the drawer read the lists. Worktree creation is a fixture port (no git needed).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEAM_TOOL_ACTIONS, TEAM_WORK_DEPENDENCIES_MAX } from "@shared/project-teams";
import { eq, sql } from "drizzle-orm";
import { db, sqlite } from "../../../db";
import { narratorWorktreeResources, teamWorkEvents, teamWorkItems } from "../../../db/schema";
import { teamTool, teamToolParameters } from "../../../lib/agent/tools/team";
import type { ToolContext } from "../../../lib/agent/types";
import { AppError } from "../../../lib/errors";
import { eventBus } from "../../../lib/event-bus";
import { generateId } from "../../../lib/id";
import { unblockedNote } from "../../../lib/prompts/team-lead";
import { readBoardItem } from "../team-board";
import {
	assertWorkItemStartable,
	readDependencies,
	readDependents,
	setUnblockDeliveryForTests,
} from "../work-item-dependencies";
import {
	attachWorker,
	cancelWorkItem,
	createWorkItem,
	listWorkItems,
	markMergedByAncestry,
	markReady,
	recordReview,
	setWorkItemDependencies,
	setWorkItemPortsForTests,
	type WorkActor,
} from "../work-items";

const LEAD = "d-lead";
const OTHER = "d-lead2";
const PROJECT = "d-project";
const USER = "d-user";
const NOW = "2026-11-25T00:00:00.000Z";
const agent: WorkActor = { kind: "agent", id: LEAD };
const principal = { userId: USER, isAdmin: false };

let temporary: string;
const delivered: { teamId: string; itemId: string; text: string; userId: string | null }[] = [];

beforeEach(async () => {
	temporary = await mkdtemp(join(tmpdir(), "nf-team-deps-"));
	delivered.length = 0;
	sqlite.run(
		"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'x', 'user', ?)",
		[USER, USER, NOW],
	);
	sqlite.run(
		"INSERT INTO projects (id, name, git_path, created_at, updated_at) VALUES (?, 'p', ?, ?, ?)",
		[PROJECT, temporary, NOW, NOW],
	);
	for (const id of [LEAD, OTHER]) {
		sqlite.run(
			`INSERT INTO narrators (id, type, title, traits, cwd, created_at, updated_at)
			VALUES (?, 'primary', ?, '["team"]', ?, ?, ?)`,
			[id, id, temporary, NOW, NOW],
		);
		sqlite.run(
			`INSERT INTO project_teams (narrator_id, project_id, base_branch, created_at, updated_at)
			VALUES (?, ?, 'main', ?, ?)`,
			[id, PROJECT, NOW, NOW],
		);
	}
	setWorkItemPortsForTests({
		async createWorktree({ coordinatorId, requestId }) {
			const path = join(temporary, requestId);
			await mkdir(path);
			db.insert(narratorWorktreeResources)
				.values({
					id: generateId(),
					ownerNarratorId: coordinatorId,
					deviceId: "local",
					repositoryKey: "repo",
					worktreePath: path,
					state: "ready",
					createRequestId: requestId,
				})
				.run();
			return { path };
		},
		planRemoval: async () => {
			throw new Error("not used");
		},
		removeWorktree: async () => {
			throw new Error("not used");
		},
		principalOf: async (userId) => ({ userId, isAdmin: false }),
	});
	setUnblockDeliveryForTests(async (input) => {
		delivered.push(input);
		return true;
	});
});

afterEach(async () => {
	setUnblockDeliveryForTests(null);
	for (const table of [
		"team_work_events",
		"team_work_item_dependencies",
		"team_work_items",
		"project_teams",
		"narrator_worktree_resources",
	])
		sqlite.run(`DELETE FROM ${table}`);
	sqlite.run("DELETE FROM narrators WHERE id LIKE 'd-%'");
	sqlite.run("DELETE FROM projects WHERE id = ?", [PROJECT]);
	sqlite.run("DELETE FROM users WHERE id = ?", [USER]);
	await rm(temporary, { recursive: true, force: true });
});

afterAll(() => setWorkItemPortsForTests(null));

const create = (title: string, dependsOn?: string[], coordinatorId = LEAD) =>
	createWorkItem({
		coordinatorId,
		title,
		dependsOn,
		actor: { kind: "agent", id: coordinatorId },
		principal,
		signal: new AbortController().signal,
	});

const setDeps = (itemId: string, dependsOn: string[]) =>
	setWorkItemDependencies({ coordinatorId: LEAD, itemId, dependsOn, actor: agent });

/** The AppError a call throws (sync or async). */
async function refusal(run: () => unknown): Promise<AppError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof AppError) return error;
		throw error;
	}
	throw new Error("expected a refusal");
}

const row = (id: string) =>
	db.select().from(teamWorkItems).where(eq(teamWorkItems.id, id)).get() as
		| typeof teamWorkItems.$inferSelect
		| undefined;

const kinds = (itemId: string) =>
	db
		.select({ kind: teamWorkEvents.kind, detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(eq(teamWorkEvents.workItemId, itemId))
		.orderBy(sql`rowid`)
		.all();

/** Put an item where the ancestry check finds it ready with a recorded head, then merge it. */
function merge(itemId: string, head = "a".repeat(40)): boolean {
	sqlite.run("UPDATE team_work_items SET state = 'ready', head_sha = ? WHERE id = ?", [
		head,
		itemId,
	]);
	const current = row(itemId);
	return markMergedByAncestry({
		itemId,
		head,
		base: "b".repeat(40),
		expectedHeadSha: head,
		expectedUpdatedAt: current?.updatedAt ?? "",
	});
}

async function settle(): Promise<void> {
	for (let i = 0; i < 100; i++) await Bun.sleep(5);
}

describe("work item dependencies", () => {
	test("set on create, read, replace and clear; each change is an event", async () => {
		const a = await create("Schema");
		const b = await create("API");
		const c = await create("UI", [a.id, b.id, a.id]);
		expect(
			readDependencies([c.id])
				.get(c.id)
				?.map((dep) => dep.id),
		).toEqual([a.id, b.id]);
		const listed = listWorkItems(LEAD).items.find((item) => item.id === c.id);
		expect(listed?.dependsOn).toEqual([a.id, b.id]);
		expect(listed?.blockedBy).toEqual([a.id, b.id]);
		expect(kinds(c.id).map((event) => event.kind)).toEqual([
			"work.created",
			"work.dependencies_changed",
		]);

		const replaced = setDeps(c.id, [b.id]);
		expect(replaced.changed).toBe(true);
		expect(kinds(c.id).at(-1)).toEqual({
			kind: "work.dependencies_changed",
			detail: { dependsOn: [b.id], added: [], removed: [a.id] },
		});
		// The same set again changes nothing and records nothing.
		expect(setDeps(c.id, [b.id]).changed).toBe(false);
		expect(kinds(c.id)).toHaveLength(3);

		expect(setDeps(c.id, []).changed).toBe(true);
		expect(readDependencies([c.id]).has(c.id)).toBe(false);
		expect(kinds(c.id).at(-1)?.detail).toEqual({ dependsOn: [], added: [], removed: [b.id] });
		// Board card and drawer lists.
		setDeps(c.id, [a.id]);
		expect(readBoardItem(LEAD, c.id)?.dependsOn).toEqual([
			{ id: a.id, title: "Schema", state: "queued" },
		]);
		expect(readBoardItem(LEAD, a.id)?.dependsOn).toEqual([]);
		expect(readDependents(LEAD, a.id)).toEqual({
			items: [{ id: c.id, title: "UI", state: "queued" }],
			more: false,
		});
	});

	test("refuses self, cycles, other teams' items, cancelled targets and more than the cap", async () => {
		const a = await create("A");
		const b = await create("B", [a.id]);
		const c = await create("C", [b.id]);

		expect((await refusal(() => setDeps(a.id, [a.id]))).code).toBe(
			"TEAM_WORK_ITEM_DEPENDENCY_CYCLE",
		);
		const cycle = await refusal(() => setDeps(a.id, [c.id]));
		expect(cycle.code).toBe("TEAM_WORK_ITEM_DEPENDENCY_CYCLE");
		expect(cycle.statusCode).toBe(409);
		expect(cycle.details).toEqual({ cycle: [a.id, c.id, b.id, a.id] });
		expect(readDependencies([a.id]).has(a.id)).toBe(false);

		const foreign = await create("Theirs", undefined, OTHER);
		const cross = await refusal(() => setDeps(a.id, [foreign.id]));
		expect(cross.code).toBe("TEAM_WORK_ITEM_DEPENDENCY_NOT_FOUND");
		expect(cross.statusCode).toBe(404);
		// On create it is refused before any worktree is made.
		const resources = db.select().from(narratorWorktreeResources).all().length;
		expect((await refusal(() => create("X", [foreign.id]))).code).toBe(
			"TEAM_WORK_ITEM_DEPENDENCY_NOT_FOUND",
		);
		expect(db.select().from(narratorWorktreeResources).all()).toHaveLength(resources);

		const gone = await create("Gone");
		cancelWorkItem({ coordinatorId: LEAD, itemId: gone.id, actor: agent });
		expect((await refusal(() => setDeps(a.id, [gone.id]))).code).toBe(
			"TEAM_WORK_ITEM_DEPENDENCY_CANCELLED",
		);

		const many = Array.from({ length: TEAM_WORK_DEPENDENCIES_MAX + 1 }, (_, i) => `id-${i}`);
		expect((await refusal(() => setDeps(a.id, many))).code).toBe("VALIDATION_ERROR");
		expect(teamToolParameters.safeParse({ action: "work.update", dependsOn: many }).success).toBe(
			false,
		);

		// A started item's dependencies no longer change.
		sqlite.run("UPDATE team_work_items SET state = 'in_progress' WHERE id = ?", [c.id]);
		expect((await refusal(() => setDeps(c.id, []))).code).toBe("TEAM_WORK_ITEM_NOT_QUEUED");
	});

	test("a blocked start is refused with 409 naming the blockers; merged unblocks", async () => {
		const a = await create("Schema");
		const b = await create("API", [a.id]);
		const blocked = await refusal(() => attachWorker(LEAD, b.id, "d-worker", agent));
		expect(blocked.statusCode).toBe(409);
		expect(blocked.code).toBe("TEAM_WORK_ITEM_BLOCKED");
		expect(blocked.message).toContain('"Schema"');
		expect(blocked.details).toEqual({ blockers: [{ id: a.id, title: "Schema", state: "queued" }] });
		expect(row(b.id)).toMatchObject({ state: "queued", workerNarratorId: null });
		// Ready is not enough.
		sqlite.run("UPDATE team_work_items SET state = 'ready' WHERE id = ?", [a.id]);
		expect((await refusal(() => assertWorkItemStartable(b.id))).code).toBe(
			"TEAM_WORK_ITEM_BLOCKED",
		);
		sqlite.run("UPDATE team_work_items SET state = 'merged' WHERE id = ?", [a.id]);
		expect(() => assertWorkItemStartable(b.id)).not.toThrow();
	});

	test("a change refreshes the team page; the same set again does not", async () => {
		const a = await create("Schema");
		const b = await create("API");
		const refreshed: string[] = [];
		const handler = (event: { teamId: string }) => refreshed.push(event.teamId);
		eventBus.on("team:communication_changed", handler);
		try {
			setDeps(b.id, [a.id]);
			expect(refreshed).toEqual([LEAD]);
			setDeps(b.id, [a.id]);
			expect(refreshed).toEqual([LEAD]);
			setDeps(b.id, []);
			expect(refreshed).toEqual([LEAD, LEAD]);
		} finally {
			eventBus.off("team:communication_changed", handler);
		}
	});

	test("a queued item cannot be reviewed or marked ready, so a review never skips the start", async () => {
		const a = await create("Schema");
		const b = await create("API", [a.id]);
		for (const verdict of ["blocker", "clear"] as const) {
			const refused = await refusal(() =>
				recordReview({
					coordinatorId: LEAD,
					itemId: b.id,
					verdict,
					findings: 0,
					reviewer: null,
					actor: agent,
				}),
			);
			expect(refused.statusCode).toBe(409);
			expect(refused.code).toBe("TEAM_WORK_ITEM_NOT_STARTED");
		}
		const ready = await refusal(() =>
			markReady({ coordinatorId: LEAD, itemId: b.id, actor: agent }),
		);
		expect(ready.code).toBe("TEAM_WORK_ITEM_NOT_STARTED");
		expect(row(b.id)).toMatchObject({ state: "queued", workerNarratorId: null, reviewRounds: 0 });
		expect(kinds(b.id).map((event) => event.kind)).toEqual([
			"work.created",
			"work.dependencies_changed",
		]);
	});

	test("an item with no worker is checked at start whatever its state", async () => {
		const a = await create("Schema");
		const b = await create("API", [a.id]);
		// Out of the queue with no worker (as a review of a queued item used to move it).
		for (const state of ["in_progress", "in_review"]) {
			sqlite.run("UPDATE team_work_items SET state = ? WHERE id = ?", [state, b.id]);
			const blocked = await refusal(() => attachWorker(LEAD, b.id, "d-worker", agent));
			expect(blocked.code).toBe("TEAM_WORK_ITEM_BLOCKED");
			expect(row(b.id)).toMatchObject({ state, workerNarratorId: null });
			const review = await refusal(() =>
				recordReview({
					coordinatorId: LEAD,
					itemId: b.id,
					verdict: "clear",
					findings: 0,
					reviewer: null,
					actor: agent,
				}),
			);
			expect(review.code).toBe("TEAM_WORK_ITEM_NOT_STARTED");
		}
	});

	test("the last dependency merging records work.unblocked and tells the coordinator once", async () => {
		const a = await create("Schema");
		const b = await create("Migrations");
		const c = await create("API", [a.id, b.id]);
		const lone = await create("Docs", [a.id]);

		expect(merge(a.id)).toBe(true);
		await settle();
		// Docs waited only for Schema; API still waits for Migrations.
		expect(kinds(lone.id).filter((event) => event.kind === "work.unblocked")).toHaveLength(1);
		expect(kinds(c.id).filter((event) => event.kind === "work.unblocked")).toHaveLength(0);
		expect(delivered.map((note) => note.itemId)).toEqual([lone.id]);
		expect(delivered[0]).toMatchObject({ teamId: LEAD, userId: USER });
		expect(delivered[0]?.text).toBe(unblockedNote("en", { itemId: lone.id, title: "Docs" }));

		expect(merge(b.id, "c".repeat(40))).toBe(true);
		await settle();
		const unblocked = kinds(c.id).filter((event) => event.kind === "work.unblocked");
		expect(unblocked).toEqual([
			{ kind: "work.unblocked", detail: { mergedItem: b.id, dependsOn: [a.id, b.id] } },
		]);
		expect(delivered.map((note) => note.itemId)).toEqual([lone.id, c.id]);

		// Merged is written once: a second pass changes nothing and says nothing again.
		expect(
			markMergedByAncestry({
				itemId: b.id,
				head: "c".repeat(40),
				base: "b".repeat(40),
				expectedHeadSha: "c".repeat(40),
				expectedUpdatedAt: row(b.id)?.updatedAt ?? "",
			}),
		).toBe(false);
		await settle();
		expect(kinds(c.id).filter((event) => event.kind === "work.unblocked")).toHaveLength(1);
		expect(delivered).toHaveLength(2);
		expect(() => assertWorkItemStartable(c.id)).not.toThrow();
	});

	test("the note is deterministic in both locales", () => {
		const input = { itemId: "it-1", title: "Login form" };
		expect(unblockedNote("zh-CN", input)).toBe(unblockedNote("zh-CN", input));
		expect(unblockedNote("zh-CN", input).startsWith("「Login form」现在可以开始了\n")).toBe(true);
		expect(unblockedNote("en", input).startsWith('"Login form" can start now\n')).toBe(true);
		for (const locale of ["en", "zh-CN"] as const)
			expect(unblockedNote(locale, input)).toContain("work.sync");
	});

	test("a cancelled dependency blocks until it is replaced; work.cancel names the waiting items", async () => {
		const a = await create("Schema");
		const started = await create("Started", [a.id]);
		const b = await create("API", [a.id]);
		// A dependent that already started is not waiting: only queued ones are named.
		sqlite.run("UPDATE team_work_items SET state = 'in_progress' WHERE id = ?", [started.id]);
		const ctx = { narratorId: LEAD, locale: "en" } as ToolContext;
		const cancelled = JSON.parse(
			(await teamTool.execute({ action: "work.cancel", item: a.id }, ctx)).output,
		);
		expect(cancelled.dependents).toEqual([b.id]);
		expect(cancelled.nextAction).toContain("work.update");

		const blocked = await refusal(() => assertWorkItemStartable(b.id));
		expect(blocked.code).toBe("TEAM_WORK_ITEM_BLOCKED");
		expect(blocked.message).toContain("was cancelled and will never merge");
		expect(blocked.message).toContain("work.update");

		const replacement = await create("Schema, again");
		const updated = JSON.parse(
			(
				await teamTool.execute(
					{ action: "work.update", item: b.id, dependsOn: [replacement.id] },
					ctx,
				)
			).output,
		);
		expect(updated.changed).toBe(true);
		expect(updated.item.dependsOn).toEqual([replacement.id]);
		expect(updated.item.blockedBy).toEqual([replacement.id]);
		const cleared = JSON.parse(
			(await teamTool.execute({ action: "work.update", item: b.id, dependsOn: [] }, ctx)).output,
		);
		expect(cleared.item.blockedBy).toEqual([]);
		expect(() => assertWorkItemStartable(b.id)).not.toThrow();
		const missing = JSON.parse(
			(await teamTool.execute({ action: "work.update", item: b.id }, ctx)).output,
		);
		expect(missing.error.code).toBe("INVALID_ARGUMENT");
	});

	test("the tool lists work.update and takes dependsOn", () => {
		expect(TEAM_TOOL_ACTIONS).toContain("work.update");
		expect(
			teamToolParameters.safeParse({ action: "work.create", title: "x", dependsOn: ["a", "b"] })
				.success,
		).toBe(true);
		expect(teamTool.description).toContain("dependsOn");
		expect(teamTool.description).toContain("TEAM_WORK_ITEM_BLOCKED");
	});

	test("deleting an item or its team removes its edges", async () => {
		const a = await create("A");
		const b = await create("B", [a.id]);
		sqlite.run("DELETE FROM team_work_events");
		sqlite.run("DELETE FROM team_work_items WHERE id = ?", [a.id]);
		expect(readDependencies([b.id]).has(b.id)).toBe(false);
		const c = await create("C");
		setDeps(b.id, [c.id]);
		sqlite.run("DELETE FROM team_work_events");
		sqlite.run("DELETE FROM project_teams WHERE narrator_id = ?", [LEAD]);
		expect(
			Number(
				(
					sqlite.prepare("SELECT count(*) AS n FROM team_work_item_dependencies").get() as {
						n: number;
					}
				).n,
			),
		).toBe(0);
	});
});
