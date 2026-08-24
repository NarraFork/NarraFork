/**
 * The bounded queries behind `TeamStatus`'s list actions, against a real database.
 *
 * Those listings used to be unbounded. A narrator that keeps working keeps
 * spawning subagents — which, unlike background task rows, are never reaped — and
 * keeps starting background bash tasks, so the tool's output grew for the lifetime
 * of the session until it dominated the turn it was meant to inform.
 *
 * The tool-level tests (`bash-stop-teamstatus.test.ts`) stub these two methods and
 * therefore cannot see a wrong query. These run the actual SQL: the ordering
 * expressions, the LIKE escaping and the bounded remainder count are all things
 * that read plausibly and are silently wrong.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { backgroundTaskService } = await import("../background-task-service");
const { narratorService } = await import("../narrator-service");

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

afterEach(() => {
	cleanDb(sqlite);
});

const PARENT = "team-parent";

async function seedParent(): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: PARENT, type: "primary", variant: "primary", createdAt: now, updatedAt: now });
}

async function seedSubagent(opts: {
	id: string;
	createdAt: string;
	status?: "idle" | "working" | "waiting" | "archived";
	title?: string | null;
	traits?: string[];
}): Promise<void> {
	await db.insert(narrators).values({
		id: opts.id,
		type: "subagent",
		variant: "subagent:general",
		parentNarratorId: PARENT,
		status: opts.status ?? "idle",
		title: opts.title ?? `sub ${opts.id}`,
		traits: opts.traits ?? [],
		createdAt: opts.createdAt,
		updatedAt: opts.createdAt,
	});
}

/** `createdAt` decides the listing order, so it is set explicitly. */
async function seedBashTask(opts: {
	id: string;
	createdAt: string;
	command?: string;
	title?: string;
	alias?: string;
	completed?: boolean;
}): Promise<void> {
	await backgroundTaskService.createBashTask({
		id: opts.id,
		parentNarratorId: PARENT,
		command: opts.command ?? `cmd ${opts.id}`,
		title: opts.title,
		alias: opts.alias,
	});
	if (opts.completed) await backgroundTaskService.markCompleted(opts.id, "");
	const { backgroundTasks } = await import("../../db/schema");
	const { eq } = await import("drizzle-orm");
	await db
		.update(backgroundTasks)
		.set({ createdAt: opts.createdAt })
		.where(eq(backgroundTasks.id, opts.id));
}

function isoAt(seconds: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

describe("listSubagentsForTeamView", () => {
	test("returns the newest members and reports the exact remainder", async () => {
		await seedParent();
		for (let i = 0; i < 12; i++) await seedSubagent({ id: `s${i}`, createdAt: isoAt(i) });

		const view = await narratorService.listSubagentsForTeamView({
			parentNarratorId: PARENT,
			limit: 5,
		});

		expect(view.subagents.map((s) => s.id)).toEqual(["s11", "s10", "s9", "s8", "s7"]);
		expect(view.omitted).toBe(7);
		expect(view.omittedCapped).toBe(false);
	});

	test("orders active members ahead of finished ones regardless of age", async () => {
		await seedParent();
		// The active member is the OLDEST, so plain createdAt ordering would bury it.
		await seedSubagent({ id: "live", createdAt: isoAt(0), status: "working" });
		await seedSubagent({ id: "waiting", createdAt: isoAt(1), status: "waiting" });
		for (let i = 0; i < 10; i++) {
			await seedSubagent({ id: `done-${i}`, createdAt: isoAt(10 + i) });
		}

		const view = await narratorService.listSubagentsForTeamView({
			parentNarratorId: PARENT,
			limit: 3,
		});

		expect(
			view.subagents
				.map((s) => s.id)
				.slice(0, 2)
				.sort(),
		).toEqual(["live", "waiting"]);
	});

	test("omitted stays correct under the active-first ordering", async () => {
		await seedParent();
		await seedSubagent({ id: "live", createdAt: isoAt(0), status: "working" });
		for (let i = 0; i < 4; i++) await seedSubagent({ id: `done-${i}`, createdAt: isoAt(10 + i) });

		const view = await narratorService.listSubagentsForTeamView({
			parentNarratorId: PARENT,
			limit: 2,
		});

		expect(view.subagents).toHaveLength(2);
		expect(view.omitted).toBe(3);
	});

	test("no omission is reported when the whole team fits", async () => {
		await seedParent();
		await seedSubagent({ id: "only", createdAt: isoAt(0) });

		const view = await narratorService.listSubagentsForTeamView({
			parentNarratorId: PARENT,
			limit: 20,
		});

		expect(view.subagents).toHaveLength(1);
		expect(view.omitted).toBe(0);
	});

	test("query matches title, alias trait and id prefix", async () => {
		await seedParent();
		await seedSubagent({
			id: "AbcdEfghIjkl",
			createdAt: isoAt(0),
			title: "Audit The Migrations",
		});
		await seedSubagent({
			id: "aliased-one",
			createdAt: isoAt(1),
			title: "Untitled work",
			traits: ["subagent-alias:trace-providers"],
		});
		for (let i = 0; i < 30; i++) await seedSubagent({ id: `noise-${i}`, createdAt: isoAt(10 + i) });

		const byTitle = await narratorService.listSubagentsForTeamView({
			parentNarratorId: PARENT,
			limit: 10,
			query: "audit",
		});
		expect(byTitle.subagents.map((s) => s.id)).toEqual(["AbcdEfghIjkl"]);

		const byAlias = await narratorService.listSubagentsForTeamView({
			parentNarratorId: PARENT,
			limit: 10,
			query: "trace-providers",
		});
		expect(byAlias.subagents.map((s) => s.id)).toEqual(["aliased-one"]);

		const byIdPrefix = await narratorService.listSubagentsForTeamView({
			parentNarratorId: PARENT,
			limit: 10,
			query: "AbcdEfgh",
		});
		expect(byIdPrefix.subagents.map((s) => s.id)).toEqual(["AbcdEfghIjkl"]);
	});

	// An unescaped `%` would match every row, turning "no results" into "the whole
	// team" — a wrong answer that looks like a working search.
	test("LIKE wildcards in a query are matched literally", async () => {
		await seedParent();
		await seedSubagent({ id: "plain", createdAt: isoAt(0), title: "plain worker" });
		await seedSubagent({ id: "literal", createdAt: isoAt(1), title: "100% coverage" });

		const wildcard = await narratorService.listSubagentsForTeamView({
			parentNarratorId: PARENT,
			limit: 10,
			query: "%",
		});
		expect(wildcard.subagents.map((s) => s.id)).toEqual(["literal"]);

		const underscore = await narratorService.listSubagentsForTeamView({
			parentNarratorId: PARENT,
			limit: 10,
			query: "_",
		});
		expect(underscore.subagents).toHaveLength(0);
	});

	test("members of other parents are never listed", async () => {
		await seedParent();
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: "other-parent",
			type: "primary",
			variant: "primary",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(narrators).values({
			id: "foreign",
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: "other-parent",
			status: "working",
			createdAt: now,
			updatedAt: now,
		});
		await seedSubagent({ id: "mine", createdAt: isoAt(0) });

		const view = await narratorService.listSubagentsForTeamView({
			parentNarratorId: PARENT,
			limit: 10,
		});

		expect(view.subagents.map((s) => s.id)).toEqual(["mine"]);
		expect(view.omitted).toBe(0);
	});
});

describe("listTeamBashTasks", () => {
	test("keeps every running task and only a short tail of finished ones", async () => {
		await seedParent();
		for (let i = 0; i < 20; i++) {
			await seedBashTask({ id: `done-${i}`, createdAt: isoAt(i), completed: true });
		}
		for (let i = 0; i < 3; i++) {
			await seedBashTask({ id: `live-${i}`, createdAt: isoAt(30 + i) });
		}

		const view = await backgroundTaskService.listTeamBashTasks({
			parentNarratorIds: [PARENT],
			limit: 20,
			recentTerminalLimit: 5,
		});

		const ids = view.tasks.map((t) => t.id);
		expect(ids.filter((id) => id.startsWith("live-"))).toHaveLength(3);
		expect(ids.filter((id) => id.startsWith("done-"))).toHaveLength(5);
		// Newest finished first, so the tail is the recent one.
		expect(ids.filter((id) => id.startsWith("done-"))[0]).toBe("done-19");
		expect(view.omitted).toBe(15);
	});

	test("running tasks keep the budget when they exceed the limit", async () => {
		await seedParent();
		for (let i = 0; i < 8; i++) await seedBashTask({ id: `live-${i}`, createdAt: isoAt(i) });
		await seedBashTask({ id: "done-1", createdAt: isoAt(20), completed: true });

		const view = await backgroundTaskService.listTeamBashTasks({
			parentNarratorIds: [PARENT],
			limit: 3,
			recentTerminalLimit: 5,
		});

		expect(view.tasks).toHaveLength(3);
		expect(view.tasks.every((t) => t.status === "running")).toBe(true);
		expect(view.omitted).toBe(6);
	});

	test("agent rows are excluded — they are listed as narrators instead", async () => {
		await seedParent();
		await seedSubagent({ id: "agent-sub", createdAt: isoAt(0), status: "working" });
		await backgroundTaskService.createAgentTask({
			id: "agent-sub",
			parentNarratorId: PARENT,
			subagentNarratorId: "agent-sub",
			subagentType: "general",
		});
		await seedBashTask({ id: "bash-1", createdAt: isoAt(1) });

		const view = await backgroundTaskService.listTeamBashTasks({
			parentNarratorIds: [PARENT],
			limit: 20,
			recentTerminalLimit: 5,
		});

		expect(view.tasks.map((t) => t.id)).toEqual(["bash-1"]);
		// The excluded agent row must not inflate the remainder either.
		expect(view.omitted).toBe(0);
	});

	test("a query searches finished tasks past the recent tail", async () => {
		await seedParent();
		await seedBashTask({
			id: "needle",
			createdAt: isoAt(0),
			command: "bun run db:migrate",
			completed: true,
		});
		for (let i = 0; i < 20; i++) {
			await seedBashTask({ id: `noise-${i}`, createdAt: isoAt(10 + i), completed: true });
		}

		const unfiltered = await backgroundTaskService.listTeamBashTasks({
			parentNarratorIds: [PARENT],
			limit: 20,
			recentTerminalLimit: 5,
		});
		expect(unfiltered.tasks.map((t) => t.id)).not.toContain("needle");

		const found = await backgroundTaskService.listTeamBashTasks({
			parentNarratorIds: [PARENT],
			limit: 20,
			recentTerminalLimit: 5,
			query: "db:migrate",
		});
		expect(found.tasks.map((t) => t.id)).toEqual(["needle"]);
		expect(found.omitted).toBe(0);
	});

	test("query matches alias and title as well as command", async () => {
		await seedParent();
		await seedBashTask({
			id: "t1",
			createdAt: isoAt(0),
			command: "x",
			alias: "run-tests",
			title: "Suite",
		});
		await seedBashTask({ id: "t2", createdAt: isoAt(1), command: "y", title: "Build frontend" });

		const byAlias = await backgroundTaskService.listTeamBashTasks({
			parentNarratorIds: [PARENT],
			limit: 20,
			recentTerminalLimit: 5,
			query: "run-tests",
		});
		expect(byAlias.tasks.map((t) => t.id)).toEqual(["t1"]);

		const byTitle = await backgroundTaskService.listTeamBashTasks({
			parentNarratorIds: [PARENT],
			limit: 20,
			recentTerminalLimit: 5,
			query: "frontend",
		});
		expect(byTitle.tasks.map((t) => t.id)).toEqual(["t2"]);
	});

	test("LIKE wildcards in a query are matched literally", async () => {
		await seedParent();
		await seedBashTask({ id: "plain", createdAt: isoAt(0), command: "echo hi" });
		await seedBashTask({ id: "literal", createdAt: isoAt(1), command: "coverage 100% ok" });

		const view = await backgroundTaskService.listTeamBashTasks({
			parentNarratorIds: [PARENT],
			limit: 20,
			recentTerminalLimit: 5,
			query: "%",
		});

		expect(view.tasks.map((t) => t.id)).toEqual(["literal"]);
	});

	// The tool prints no output text, and the column stores up to 512 KB per row.
	test("the stored output column is never materialized", async () => {
		await seedParent();
		await backgroundTaskService.createBashTask({
			id: "big",
			parentNarratorId: PARENT,
			command: "generate",
		});
		await backgroundTaskService.markCompleted("big", "x".repeat(50_000));

		const view = await backgroundTaskService.listTeamBashTasks({
			parentNarratorIds: [PARENT],
			limit: 20,
			recentTerminalLimit: 5,
		});

		expect(view.tasks).toHaveLength(1);
		expect(view.tasks[0].output).toBeNull();
		// The true size is still reported, so a caller can tell output exists.
		expect(view.tasks[0].outputBytes).toBe(50_000);
	});

	test("an empty parent set short-circuits without querying", async () => {
		const view = await backgroundTaskService.listTeamBashTasks({
			parentNarratorIds: [],
			limit: 20,
			recentTerminalLimit: 5,
		});
		expect(view).toEqual({ tasks: [], omitted: 0, omittedCapped: false });
	});
});
