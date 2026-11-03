/**
 * `GET /api/narrators/:id/tasks/current` (outline P2 PR 5, the status bar; review round 1 S8, S5,
 * nits): the current task of either backend with its address, how many of the session's goals
 * wait for a person to confirm their completion, and how many wait for the viewer (the locker, or
 * the person of the session confirming for them); someone who cannot read the session gets 404.
 * The session's open tasks are read once per request.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own people and
 * sessions.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { NarratorCurrentTaskResponse } from "@shared/outline-task-board";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, narrators, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { OUTLINE_BEHAVIOR_ALIAS } from "../../services/outline/model";
import { lockOutlineTask } from "../../services/outline/pending";
import { addPersonTask } from "../../services/outline/person-tasks";
import { outlineStore } from "../../services/outline/store";
import { writeOutline } from "../../services/outline/write";
import { invalidateTaskBackend, taskSourceForNarrator } from "../../services/task-source";
import { narratorRoutes } from "../narrators";

const NOW = "2026-11-03T00:00:00.000Z";
const restores: Array<() => void> = [];

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
});
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function get(userId: string, narratorId: string) {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.onError((error) => {
		const status = error instanceof AppError ? error.statusCode : 500;
		return new Response(JSON.stringify({ error: error.message }), { status });
	});
	instance.route("/narrators", narratorRoutes);
	return instance.request(`http://localhost/narrators/${narratorId}/tasks/current`);
}

async function person(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `cur${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

async function session(owner: string, backend: "spec" | "outline"): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		ownerUserId: owner,
		taskBackend: backend,
		visibility: "private",
		status: "idle",
		cwd: "/tmp",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function grantRead(narratorId: string, userId: string) {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "narrator",
		scopeId: narratorId,
		principalType: "user",
		principalId: userId,
		capability: "read",
		createdAt: NOW,
	});
}

describe("the current task route", () => {
	test("outline: the task in progress with its address, then the goal waiting for its locker", async () => {
		const owner = await person();
		const reader = await person();
		const id = await session(owner, "outline");
		await grantRead(id, reader);
		const goal = await addPersonTask({ narratorId: id, userId: owner, text: "Ship", lock: true });
		await (await taskSourceForNarrator(id)).prepareContinuation({ promoteTodo: true });

		const first = await get(owner, id);
		expect(first.status).toBe(200);
		expect((await first.json()) as NarratorCurrentTaskResponse).toEqual({
			backend: "outline",
			current: { text: "Ship", address: goal.address, protected: true },
			awaitingConfirmation: 0,
			awaitingYourConfirmation: 0,
		});

		// The agent ticks the goal done: held for the person who locked it (D26b).
		await writeOutline({
			spaceId: goal.spaceId,
			ops: [{ op: "setTask", block: { id: goal.blockId }, task: { status: "done" } }],
			actor: { kind: "agent", id },
			narratorId: id,
			responsibleUserId: owner,
		});
		expect(await (await get(owner, id)).json()).toEqual({
			backend: "outline",
			current: null,
			awaitingConfirmation: 1,
			awaitingYourConfirmation: 1,
		});
		// Someone who only reads the session sees that a goal waits, not that it waits for them.
		expect(await (await get(reader, id)).json()).toEqual({
			backend: "outline",
			current: null,
			awaitingConfirmation: 1,
			awaitingYourConfirmation: 0,
		});
	});

	test("outline: a goal whose locker named a session to confirm for them waits for that session's person too", async () => {
		const owner = await person();
		const delegatePerson = await person();
		const reader = await person();
		const id = await session(owner, "outline");
		const reviewer = await session(delegatePerson, "outline");
		await grantRead(id, delegatePerson);
		await grantRead(id, reader);
		const goal = await addPersonTask({ narratorId: id, userId: owner, text: "Ship", lock: false });
		await lockOutlineTask({ blockId: goal.blockId, userId: owner, delegate: reviewer });
		await writeOutline({
			spaceId: goal.spaceId,
			ops: [{ op: "setTask", block: { id: goal.blockId }, task: { status: "done" } }],
			actor: { kind: "agent", id },
			narratorId: id,
			responsibleUserId: owner,
		});
		const counts = async (userId: string) => {
			const body = (await (await get(userId, id)).json()) as NarratorCurrentTaskResponse;
			return [body.awaitingConfirmation, body.awaitingYourConfirmation];
		};
		expect(await counts(owner)).toEqual([1, 1]);
		expect(await counts(delegatePerson)).toEqual([1, 1]);
		expect(await counts(reader)).toEqual([1, 0]);
	});

	test("outline: the open tasks are read once per request", async () => {
		const owner = await person();
		const id = await session(owner, "outline");
		await addPersonTask({ narratorId: id, userId: owner, text: "Ship", lock: true });
		const spy = spyOn(outlineStore, "findAliasOwners");
		restores.push(() => spy.mockRestore());
		expect((await get(owner, id)).status).toBe(200);
		const behaviorReads = spy.mock.calls.filter(([, aliases]) =>
			aliases.includes(OUTLINE_BEHAVIOR_ALIAS),
		);
		expect(behaviorReads).toHaveLength(1);
	});

	test("spec: its backend, no address, nothing awaiting", async () => {
		const owner = await person();
		const id = await session(owner, "spec");
		const response = await get(owner, id);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			backend: "spec",
			current: null,
			awaitingConfirmation: 0,
			awaitingYourConfirmation: 0,
		});
	});

	test("someone who cannot read the session gets 404", async () => {
		const owner = await person();
		const stranger = await person();
		const outline = await session(owner, "outline");
		const spec = await session(owner, "spec");
		expect((await get(stranger, outline)).status).toBe(404);
		expect((await get(stranger, spec)).status).toBe(404);
	});
});
