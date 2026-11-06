/**
 * 「新完成」 on the task board (outline P2 PR 9b, owner decision D50 ④): a task a person manages
 * that an agent finished is marked for that person until they have seen it on a board, and for
 * nobody else; what counts as an agent's finish; the window; seen at a version (finished again is
 * new again); what the "seen" route records and ignores; and the board's reads stay bounded.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own people,
 * projects and sessions. `outline.enabled` is switched on before each case.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { OutlineBoardTask, OutlineTaskBoardResponse } from "@shared/outline-task-board";
import { Hono } from "hono";
import { db } from "../../../db";
import { aclGrants, narrators, projects, users } from "../../../db/schema";
import { AppError } from "../../../lib/errors";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { outlineRoutes } from "../../../routes/outline";
import { invalidateTaskBackend } from "../../task-source";
import { addPersonTask } from "../person-tasks";
import { ensureSessionSpace } from "../spaces";
import { outlineStore } from "../store";
import {
	markOutlineTasksSeen,
	OUTLINE_BOARD_NEW_DONE,
	readProjectTaskBoard,
	readSessionTaskBoard,
} from "../task-board";
import { type OutlineOp, writeOutline } from "../write";

const NOW = "2026-11-06T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
});

async function person(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `nd${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

async function project(owner: string): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `nd-${id}`,
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function session(owner: string, projectId: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: "Worker",
		ownerUserId: owner,
		visibility: "project",
		contextProjectId: projectId,
		taskBackend: "outline",
		status: "idle",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function grantRead(projectId: string, userId: string) {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: userId,
		capability: "read",
		createdAt: NOW,
	});
}

const principal = (userId: string) => ({ userId, isAdmin: false });

async function write(
	spaceId: string,
	who: { kind: "agent"; id: string } | { kind: "human"; id: string },
	ops: OutlineOp[],
	now?: Date,
) {
	return await writeOutline(
		{
			spaceId,
			ops,
			actor: who,
			...(who.kind === "agent" ? { narratorId: who.id } : {}),
			responsibleUserId: who.kind === "human" ? who.id : null,
		},
		now ? { now: () => now } : {},
	);
}

const setStatus = (id: string, status: "todo" | "doing" | "done" | "cancelled"): OutlineOp => ({
	op: "setTask",
	block: { id },
	task: { status },
});

/** A world: the manager's tasks in a session of a project another person may read. */
async function world() {
	const manager = await person();
	const reader = await person();
	const projectId = await project(manager);
	await grantRead(projectId, reader);
	const worker = await session(manager, projectId);
	const space = await ensureSessionSpace(worker);
	const add = async (text: string) =>
		(await addPersonTask({ narratorId: worker, userId: manager, text, lock: false })).blockId;
	return { manager, reader, projectId, worker, space, add };
}

async function finishedOn(board: OutlineTaskBoardResponse): Promise<OutlineBoardTask[]> {
	return board.sections.flatMap((section) => section.finished);
}

const marks = async (userId: string, worker: string) =>
	Object.fromEntries(
		(await finishedOn(await readSessionTaskBoard(principal(userId), worker))).map((task) => [
			task.title,
			task.newlyDone === true,
		]),
	);

describe("who sees the mark", () => {
	test("the person who manages it, until they have seen it; nobody else", async () => {
		const w = await world();
		const done = await w.add("Ship the importer");
		await write(w.space.id, { kind: "agent", id: w.worker }, [setStatus(done, "doing")]);
		await write(w.space.id, { kind: "agent", id: w.worker }, [setStatus(done, "done")]);
		expect(await marks(w.manager, w.worker)).toEqual({ "Ship the importer": true });
		// Another reader of the same board: their board shows no mark.
		expect(await marks(w.reader, w.worker)).toEqual({ "Ship the importer": false });
		// The project's board marks it the same way.
		const projectBoard = await readProjectTaskBoard(principal(w.manager), w.projectId);
		expect((await finishedOn(projectBoard)).map((t) => t.newlyDone)).toEqual([true]);

		// Seen: gone from the next read, for that person only.
		const version = (await outlineStore.getBlock(done))?.versionSeq as number;
		expect(
			await markOutlineTasksSeen(principal(w.manager), {
				tasks: [{ id: done, versionSeq: version }],
			}),
		).toBe(1);
		expect(await marks(w.manager, w.worker)).toEqual({ "Ship the importer": false });

		// Finished again later (reopened, done again by the agent): new again.
		await write(w.space.id, { kind: "agent", id: w.worker }, [setStatus(done, "todo")]);
		await write(w.space.id, { kind: "agent", id: w.worker }, [setStatus(done, "done")]);
		expect(await marks(w.manager, w.worker)).toEqual({ "Ship the importer": true });
	});

	test("what counts as an agent's finish", async () => {
		const w = await world();
		const other = await person();
		await grantRead(w.projectId, other);
		const [byAgent, byManager, byOtherWhileHeld, byOtherUnheld, cancelled] = await Promise.all(
			["By the agent", "By the manager", "By another while held", "By another", "Cancelled"].map(
				(text) => w.add(text),
			),
		);
		const agent = { kind: "agent" as const, id: w.worker };
		// Done straight from to do by the agent (no claim): still the agent's.
		await write(w.space.id, agent, [setStatus(byAgent as string, "done")]);
		// The session was doing it, and the manager ticked it done: theirs, never new to them.
		await write(w.space.id, agent, [setStatus(byManager as string, "doing")]);
		await write(w.space.id, { kind: "human", id: w.manager }, [
			setStatus(byManager as string, "done"),
		]);
		await write(w.space.id, agent, [setStatus(byOtherWhileHeld as string, "doing")]);
		await write(w.space.id, { kind: "human", id: other }, [
			setStatus(byOtherWhileHeld as string, "done"),
		]);
		await write(w.space.id, { kind: "human", id: other }, [
			setStatus(byOtherUnheld as string, "done"),
		]);
		await write(w.space.id, agent, [setStatus(cancelled as string, "cancelled")]);
		expect(await marks(w.manager, w.worker)).toEqual({
			"By the agent": true,
			"By the manager": false,
			"By another while held": true,
			"By another": false,
			Cancelled: false,
		});
	});

	test("an edit by the manager after the finish counts as seen; an older finish is not marked", async () => {
		const w = await world();
		const [edited, old] = await Promise.all(["Edited after", "Long ago"].map((t) => w.add(t)));
		const agent = { kind: "agent" as const, id: w.worker };
		await write(w.space.id, agent, [setStatus(edited as string, "done")]);
		await write(w.space.id, { kind: "human", id: w.manager }, [
			{ op: "update", block: { id: edited as string }, content: "Edited after (checked)" },
		]);
		const longAgo = new Date(Date.now() - (OUTLINE_BOARD_NEW_DONE.windowDays + 1) * 86_400_000);
		await write(w.space.id, agent, [setStatus(old as string, "done")], longAgo);
		expect(await marks(w.manager, w.worker)).toEqual({
			"Edited after (checked)": false,
			"Long ago": false,
		});
	});
});

describe("recording that a person saw a mark", () => {
	test("only done tasks they manage, in spaces they may read; never past the task's version", async () => {
		const w = await world();
		const outsider = await person();
		const [done, open] = await Promise.all(["Done", "Still open"].map((t) => w.add(t)));
		const agent = { kind: "agent" as const, id: w.worker };
		await write(w.space.id, agent, [setStatus(done as string, "done")]);
		const version = (await outlineStore.getBlock(done as string))?.versionSeq as number;
		// Not theirs (the reader manages nothing here), not readable, not done: nothing recorded.
		expect(
			await markOutlineTasksSeen(principal(w.reader), {
				tasks: [{ id: done as string, versionSeq: version }],
			}),
		).toBe(0);
		expect(
			await markOutlineTasksSeen(principal(outsider), {
				tasks: [{ id: done as string, versionSeq: version }],
			}),
		).toBe(0);
		expect(
			await markOutlineTasksSeen(principal(w.manager), {
				tasks: [
					{ id: open as string, versionSeq: 1 },
					{ id: "no-such-block", versionSeq: 1 },
				],
			}),
		).toBe(0);
		// A version from the future is recorded as the task's own.
		expect(
			await markOutlineTasksSeen(principal(w.manager), {
				tasks: [{ id: done as string, versionSeq: version + 1000 }],
			}),
		).toBe(1);
		expect(await outlineStore.getTaskSeen(w.manager, [done as string])).toEqual([
			{ taskBlockId: done as string, seenSeq: version },
		]);
	});

	test("the route: validated, the person's own count", async () => {
		const w = await world();
		const done = await w.add("Route");
		await write(w.space.id, { kind: "agent", id: w.worker }, [setStatus(done, "done")]);
		const version = (await outlineStore.getBlock(done))?.versionSeq as number;
		const app = (userId: string) => {
			const instance = new Hono();
			instance.use("*", async (c, next) => {
				c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
				await next();
			});
			instance.onError((error) => {
				const status = error instanceof AppError ? error.statusCode : 500;
				return new Response(JSON.stringify({ error: error.message }), { status });
			});
			instance.route("/outline", outlineRoutes);
			return instance;
		};
		const post = (userId: string, body: unknown) =>
			app(userId).request("http://localhost/outline/tasks/seen", {
				method: "POST",
				body: JSON.stringify(body),
				headers: { "content-type": "application/json" },
			});
		expect((await post(w.manager, { tasks: [] })).status).toBe(400);
		expect((await post(w.manager, { tasks: [{ id: done, versionSeq: -1 }] })).status).toBe(400);
		const tooMany = Array.from({ length: 101 }, () => ({ id: done, versionSeq: version }));
		expect((await post(w.manager, { tasks: tooMany })).status).toBe(400);
		const theirs = await post(w.reader, { tasks: [{ id: done, versionSeq: version }] });
		expect(await theirs.json()).toEqual({ marked: 0 });
		const mine = await post(w.manager, { tasks: [{ id: done, versionSeq: version }] });
		expect(mine.status).toBe(200);
		expect(await mine.json()).toEqual({ marked: 1 });
		expect(await marks(w.manager, w.worker)).toEqual({ Route: false });
	});
});

describe("cost", () => {
	test("a board without a task finished for its reader reads nothing more", async () => {
		const w = await world();
		const done = await w.add("Not mine to see");
		await write(w.space.id, { kind: "human", id: w.manager }, [setStatus(done, "done")]);
		const calls: string[] = [];
		const restores: Array<() => void> = [];
		for (const key of ["getCommitsBySeqs", "getTaskSeen"] as const) {
			const original = outlineStore[key];
			(outlineStore as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
				calls.push(key);
				return (original as (...a: unknown[]) => unknown).apply(outlineStore, args);
			};
			restores.push(() => {
				(outlineStore as unknown as Record<string, unknown>)[key] = original;
			});
		}
		try {
			// The reader manages nothing; the manager finished it themself (a commit read, no mark).
			await readSessionTaskBoard(principal(w.reader), w.worker);
			expect(calls).toEqual([]);
			await readSessionTaskBoard(principal(w.manager), w.worker);
			expect(calls).toEqual(["getCommitsBySeqs", "getTaskSeen"]);
		} finally {
			for (const restore of restores) restore();
		}
	});
});
