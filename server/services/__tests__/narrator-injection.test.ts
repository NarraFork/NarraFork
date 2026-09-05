/**
 * narrator-injection.test.ts — `deliverInjection`, the single road for server-authored
 * content entering a narrator's conversation.
 *
 * The point of the design is that two things the old side-car channel welded together
 * are now independent:
 *
 *   `role`      what the content IS (a system fact vs. something speaking for the user)
 *   `schedule`  what should HAPPEN because of it
 *
 * So the matrix below is not busywork: every combination is reachable in production,
 * and the pairs that used to be inexpressible (`user` weight with no turn started;
 * `sys` weight that does start one) are exactly the ones the side-car existed to work
 * around. They are asserted individually.
 *
 * Scheduling side effects are stubbed at the `narrator-session` boundary. That module
 * owns the loop, the continuation lock and the runtime maps; instantiating it here
 * would test it rather than this. What matters at this seam is only that the right
 * effect is requested exactly once, and that a row is written first either way.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SideCarBody } from "@shared/sidecar-body";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
// Captured before the mock lands: `mock.module` is process-wide, so leaving the
// in-memory schema installed would hand it to every later file in the same run.
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

// Broadcasting is a side channel with no bearing on what is persisted, so it is
// silenced rather than served by a real WebSocket.
//
// The real module is SPREAD rather than replaced wholesale: `mock.module` is
// process-wide, and a partial replacement removes every export the stub omits for the
// rest of the run. Returning only `broadcastToNarrator` here made sibling modules that
// import `broadcastToUser` fail to link, which surfaced as nine unrelated
// narrator-buffer failures — in a suite this file never touches.
const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: () => {},
}));

const { deliverInjection, buildSystemInjectionBlock, setInjectionScheduler } = await import(
	"../narrator-injection"
);

// Scheduling stubs. Recorded rather than asserted inline so a test can prove an effect
// did NOT happen, which is half the matrix.
//
// Installed through the module's own seam rather than `mock.module("../narrator-session")`:
// that mock is process-wide and would be handed to every later test file in the run,
// which reset module-level lazy state in sibling services and broke nine unrelated
// narrator-buffer assertions.
const softStops: string[] = [];
const wakes: string[] = [];
let wakeResult = true;
let wakeThrows = false;

const previousScheduler = setInjectionScheduler({
	requestSoftStop: (narratorId: string) => {
		softStops.push(narratorId);
		return true;
	},
	wakeIfIdle: async (narratorId: string) => {
		wakes.push(narratorId);
		if (wakeThrows) throw new Error("narrator vanished");
		return { started: wakeResult };
	},
});

const now = "2026-07-28T10:00:00.000Z";

function seedNarrator(id = "n1") {
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run(id, now, now);
}

function seedUser(id = "u1") {
	sqlite
		.prepare(
			"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(id, "alice", "x", "admin", now);
}

interface Row {
	role: string;
	origin: string | null;
	origin_label: string | null;
	created_by: string | null;
	content_text: string | null;
	content_json: string;
}

function readRow(id: string): Row {
	return sqlite
		.prepare(
			"SELECT role, origin, origin_label, created_by, content_text, content_json FROM narrator_messages WHERE id = ?",
		)
		.get(id) as Row;
}

function blocksOf(id: string): Array<Record<string, unknown>> {
	return JSON.parse(readRow(id).content_json);
}

function rowCount(): number {
	return (sqlite.prepare("SELECT COUNT(*) AS n FROM narrator_messages").get() as { n: number }).n;
}

/** Refs decide a message's position in the narrator's history; a row without one is invisible. */
function refCount(messageId: string): number {
	return (
		sqlite
			.prepare("SELECT COUNT(*) AS n FROM narrator_message_refs WHERE message_id = ?")
			.get(messageId) as { n: number }
	).n;
}

const TASKS_BODY: SideCarBody = {
	kind: "tasks",
	variant: "current",
	tasks: [{ role: "doing", text: "migrate the queues", protected: true }],
};

beforeEach(() => {
	cleanDb(sqlite);
	seedNarrator();
	seedUser();
	softStops.length = 0;
	wakes.length = 0;
	wakeResult = true;
	wakeThrows = false;
});

// Hand both mocked modules back so later files in this run see the real thing.
afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	setInjectionScheduler(previousScheduler);
});

// ─────────────────────────────────────────────────────────────────────────────
// The row that gets written
// ─────────────────────────────────────────────────────────────────────────────

describe("deliverInjection — the persisted row", () => {
	for (const role of ["user", "sys"] as const) {
		test(`${role} persistence hook rolls back the row/ref and never wakes on failure`, async () => {
			const countBefore = rowCount();
			await expect(
				deliverInjection("n1", {
					content: "This must not become visible",
					source: "test",
					role,
					schedule: "wakeIfIdle",
					onPersist: (tx, messageId) => {
						expect(tx).toBeDefined();
						expect(refCount(messageId)).toBe(1);
						throw new Error("injected atomic commit failure");
					},
				}),
			).rejects.toThrow("injected atomic commit failure");
			expect(rowCount()).toBe(countBefore);
			expect(sqlite.query("SELECT count(*) AS n FROM narrator_message_refs").get()).toEqual({
				n: 0,
			});
			expect(wakes).toEqual([]);
		});
	}

	test("writes a sys row whose FIRST block is the verbatim model-facing text", async () => {
		const content = "Dynamic Spec reminder:\n- doing: migrate the queues";
		const result = await deliverInjection("n1", {
			content,
			source: "living_work_spec",
			body: TASKS_BODY,
		});

		expect(result.messageId).not.toBeNull();
		const row = readRow(result.messageId as string);
		expect(row.role).toBe("sys");
		expect(row.content_text).toBe(content);

		// Providers project text blocks only, so the model-facing copy has to be the
		// text block — byte-for-byte, boilerplate included.
		const blocks = blocksOf(result.messageId as string);
		expect(blocks[0]).toEqual({ type: "text", text: content });
	});

	test("carries the STRUCTURED body, not pre-worded reader text", async () => {
		const result = await deliverInjection("n1", {
			content: "whatever the model reads",
			source: "living_work_spec",
			body: TASKS_BODY,
		});

		const injection = blocksOf(result.messageId as string)[1];
		expect(injection.type).toBe("system_injection");
		expect(injection.source).toBe("living_work_spec");
		// Reader-facing wording lives in the frontend message tables, so it must NOT be
		// frozen into the row at write time — otherwise a translation fix could never
		// reach an existing row.
		expect(injection.markdown).toBeUndefined();
		expect(injection.body).toEqual(TASKS_BODY);
	});

	test("omits body when the producer has none, leaving the text as the only source", async () => {
		const result = await deliverInjection("n1", {
			content: "a plain notice",
			source: "some_source",
		});
		const injection = blocksOf(result.messageId as string)[1];
		expect(injection).toEqual({ type: "system_injection", source: "some_source" });
	});

	test("appends a producer's own card after the injection block", async () => {
		const result = await deliverInjection("n1", {
			content: "2 background agents finished",
			source: "bg_agent",
			extraBlocks: [{ type: "background_agents_completed", tasks: [] }],
		});
		const blocks = blocksOf(result.messageId as string);
		expect(blocks.map((b) => b.type)).toEqual([
			"text",
			"system_injection",
			"background_agents_completed",
		]);
	});

	test("registers a history ref so the row is actually part of the conversation", async () => {
		const result = await deliverInjection("n1", { content: "x", source: "s" });
		expect(refCount(result.messageId as string)).toBe(1);
	});

	test("writes nothing for blank content, and reports it", async () => {
		// Producers drain queues and hit cadences that legitimately come up empty. A row
		// then would be a blank card for the reader and a wasted turn for the model.
		for (const content of ["", "   ", "\n\t "]) {
			const result = await deliverInjection("n1", { content, source: "s" });
			expect(result.messageId).toBeNull();
		}
		expect(rowCount()).toBe(0);
	});

	test("does not schedule anything when there was nothing to deliver", async () => {
		await deliverInjection("n1", { content: "  ", source: "s", schedule: "wakeIfIdle" });
		await deliverInjection("n1", { content: "  ", source: "s", schedule: "interject" });
		expect(wakes).toEqual([]);
		expect(softStops).toEqual([]);
	});

	test("trims the stored text so trailing whitespace cannot drift the two projections", async () => {
		const result = await deliverInjection("n1", { content: "  padded  ", source: "s" });
		expect(readRow(result.messageId as string).content_text).toBe("padded");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// role — protocol semantics and weight
// ─────────────────────────────────────────────────────────────────────────────

describe("deliverInjection — role", () => {
	test("defaults to sys, attributed to the system", async () => {
		const result = await deliverInjection("n1", { content: "container is up", source: "s" });
		const row = readRow(result.messageId as string);
		expect(row.role).toBe("sys");
		expect(row.origin).toBe("system");
	});

	test("role=user writes a real user turn, which is what taskReflection needs", async () => {
		const result = await deliverInjection("n1", {
			content: "I updated spec://tasks.json — align your plan",
			source: "spec_update",
			role: "user",
			createdBy: "u1",
		});
		const row = readRow(result.messageId as string);
		expect(row.role).toBe("user");
		expect(row.origin).toBe("user");
		expect(row.created_by).toBe("u1");
	});

	test("role=user still carries the injection block, so the UI can label it", async () => {
		const result = await deliverInjection("n1", {
			content: "user-weighted text",
			source: "spec_update",
			role: "user",
			body: { kind: "prose", text: "user-weighted text" },
		});
		// persistUserMessage takes the full block list with no implicit text block, so
		// this also pins that the text block was prepended rather than dropped.
		const blocks = blocksOf(result.messageId as string);
		expect(blocks[0]).toEqual({ type: "text", text: "user-weighted text" });
		expect(blocks[1].type).toBe("system_injection");
	});

	test("an attribution label is recorded for display when a source is given", async () => {
		const result = await deliverInjection("n1", {
			content: "review says: fix the leak",
			source: "review_feedback",
			originSource: "review",
			originDetail: "chapter-7",
		});
		expect(readRow(result.messageId as string).origin_label).toBe("review:chapter-7");
	});

	test("no label when the producer did not claim one", async () => {
		const result = await deliverInjection("n1", { content: "x", source: "s" });
		expect(readRow(result.messageId as string).origin_label).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// schedule — what happens as a result
// ─────────────────────────────────────────────────────────────────────────────

describe("deliverInjection — schedule", () => {
	test("none (the default): a row and nothing else", async () => {
		const result = await deliverInjection("n1", { content: "fyi", source: "s" });
		expect(result).toMatchObject({ turnText: null, started: false, interjected: false });
		expect(softStops).toEqual([]);
		expect(wakes).toEqual([]);
	});

	test("onNextTurn hands the text back for the RUNNING loop, and wakes nobody", async () => {
		// A loop rebuilds its in-memory history at pass start, so a row written mid-turn
		// is invisible until the next pass. Returning the text is how the current pass
		// still sees it — and it is not a double delivery, because the current pass reads
		// the returned copy while later passes read the row.
		const result = await deliverInjection("n1", {
			content: "you have made 20 tool calls",
			source: "silent_progress",
			schedule: "onNextTurn",
		});
		expect(result.turnText).toBe("you have made 20 tool calls");
		expect(result.messageId).not.toBeNull();
		expect(wakes).toEqual([]);
		expect(softStops).toEqual([]);
	});

	test("every other schedule returns turnText null, so a caller cannot double-deliver", async () => {
		for (const schedule of ["none", "interject", "wakeIfIdle"] as const) {
			const result = await deliverInjection("n1", { content: "t", source: "s", schedule });
			expect(result.turnText).toBeNull();
		}
	});

	test("interject asks the running loop to stop at the next tool boundary", async () => {
		const result = await deliverInjection("n1", {
			content: "plan changed",
			source: "spec_update",
			role: "user",
			schedule: "interject",
		});
		expect(softStops).toEqual(["n1"]);
		expect(result.interjected).toBe(true);
		expect(wakes).toEqual([]);
	});

	test("wakeIfIdle starts a turn and reports it", async () => {
		const result = await deliverInjection("n1", {
			content: "background agent finished",
			source: "bg_agent",
			schedule: "wakeIfIdle",
		});
		expect(wakes).toEqual(["n1"]);
		expect(result.started).toBe(true);
	});

	test("wakeIfIdle on a busy narrator keeps the row and reports not started", async () => {
		// Degrading to `none` is the correct outcome, not a failure: the row is in place
		// and the running loop reads it on its next pass.
		wakeResult = false;
		const result = await deliverInjection("n1", {
			content: "background agent finished",
			source: "bg_agent",
			schedule: "wakeIfIdle",
		});
		expect(result.started).toBe(false);
		expect(result.messageId).not.toBeNull();
		expect(refCount(result.messageId as string)).toBe(1);
	});

	test("a failed wake never loses the content", async () => {
		// The row is persisted before scheduling is attempted, so a wake failure only
		// costs immediacy — the content is read on whatever request comes next.
		wakeThrows = true;
		const result = await deliverInjection("n1", {
			content: "must not be lost",
			source: "bg_agent",
			schedule: "wakeIfIdle",
		});
		expect(result.started).toBe(false);
		expect(readRow(result.messageId as string).content_text).toBe("must not be lost");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The axes are independent — this is the design claim
// ─────────────────────────────────────────────────────────────────────────────

describe("deliverInjection — role x schedule are orthogonal", () => {
	const roles = ["sys", "user"] as const;
	const schedules = ["none", "onNextTurn", "interject", "wakeIfIdle"] as const;

	test("all 8 combinations write exactly one row with the requested role", async () => {
		for (const role of roles) {
			for (const schedule of schedules) {
				cleanDb(sqlite);
				seedNarrator();
				seedUser();
				softStops.length = 0;
				wakes.length = 0;

				const result = await deliverInjection("n1", {
					content: `${role}/${schedule}`,
					source: "s",
					role,
					schedule,
				});

				expect(rowCount()).toBe(1);
				expect(readRow(result.messageId as string).role).toBe(role);
				// The effect follows `schedule` alone; `role` must not influence it.
				expect(wakes.length).toBe(schedule === "wakeIfIdle" ? 1 : 0);
				expect(softStops.length).toBe(schedule === "interject" ? 1 : 0);
			}
		}
	});

	test("the two previously-inexpressible pairs both work", async () => {
		// User weight with NO turn started: the side-car channel existed largely because
		// this had no clean spelling.
		const quietUser = await deliverInjection("n1", {
			content: "queued for later, do not wake",
			source: "spec_update",
			role: "user",
			schedule: "none",
		});
		expect(readRow(quietUser.messageId as string).role).toBe("user");
		expect(wakes).toEqual([]);

		// System fact that DOES start a turn.
		const loudSys = await deliverInjection("n1", {
			content: "your background task finished",
			source: "bg_agent",
			role: "sys",
			schedule: "wakeIfIdle",
		});
		expect(readRow(loudSys.messageId as string).role).toBe("sys");
		expect(wakes).toEqual(["n1"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Block builder
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSystemInjectionBlock", () => {
	test("includes body only when there is one", () => {
		expect(buildSystemInjectionBlock("s", TASKS_BODY)).toEqual({
			type: "system_injection",
			source: "s",
			body: TASKS_BODY,
		});
		expect(buildSystemInjectionBlock("s", undefined)).toEqual({
			type: "system_injection",
			source: "s",
		});
	});
});
