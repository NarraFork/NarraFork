/**
 * compact-exit-drains-queue.test.ts — the REAL compact run must consume the queue on
 * its way out, on every exit.
 *
 * `compact-queue-drain.test.ts` pins the drain function's own behaviour by calling it
 * directly, which cannot notice the failure that actually matters: the hook not being
 * wired into `runCustomCompact` at all. A missing hook is invisible — compaction keeps
 * working, and the only symptom is a user message that is accepted, shown as queued,
 * and then never answered until something else happens to wake the narrator.
 *
 * So this file drives the real run and asserts the call. The cancel path is covered
 * separately because it exits through `doRunCustomCompact`'s abort branch rather than
 * the success return, and a hook placed on the success path only would silently strand
 * exactly the messages a user queued and then changed their mind about mid-compact.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { chapters, narratorMessages, narrators, projects } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: () => {},
}));

/**
 * Record drain calls instead of running the resumed turn.
 *
 * The drain module is mocked (not `narrator-session`) so this test observes exactly the
 * boundary it is about: did the compact run reach the drain?
 */
let drainCalls: string[] = [];
const realDrainModule = { ...(await import("../compact-queue-drain")) };
mock.module("../compact-queue-drain", () => ({
	...realDrainModule,
	drainQueuedMessagesAfterCompact: async (narratorId: string) => {
		drainCalls.push(narratorId);
	},
}));

const { narratorContext } = await import("../narrator-context");
const { cancelCompact, compactLocks, runCustomCompact } = await import("../narrator-compact");

const realGenerateCompactSummary = narratorContext.generateCompactSummary.bind(narratorContext);
const NARRATOR_ID = "n-compact-exit";

function seed(): void {
	const now = new Date().toISOString();
	db.insert(projects)
		.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: now, updatedAt: now })
		.run();
	db.insert(chapters)
		.values({
			id: "ch1",
			projectId: "p1",
			title: "Chapter",
			branch: "chapter/ch1",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narrators)
		.values({
			id: NARRATOR_ID,
			chapterId: "ch1",
			type: "primary",
			inheritMode: "fresh",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	for (const [id, text, seq] of [
		["m-before", "before", 0],
		["m-target", "target", 1],
	] as const) {
		db.insert(narratorMessages)
			.values({
				id,
				narratorId: NARRATOR_ID,
				role: "user",
				contentJson: [{ type: "text", text }],
				contentText: text,
				createdAt: now,
			})
			.run();
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, ?)",
			[`r-${id}`, NARRATOR_ID, id, seq],
		);
	}
}

beforeEach(() => {
	cleanDb(sqlite);
	compactLocks.clear();
	drainCalls = [];
	narratorContext.generateCompactSummary = realGenerateCompactSummary;
});

afterEach(() => {
	compactLocks.clear();
	narratorContext.generateCompactSummary = realGenerateCompactSummary;
});

afterAll(() => {
	narratorContext.generateCompactSummary = realGenerateCompactSummary;
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.module("../compact-queue-drain", () => realDrainModule);
	mock.restore();
});

describe("runCustomCompact drains the queue on exit", () => {
	test("a successful compact reaches the drain", async () => {
		seed();
		narratorContext.generateCompactSummary = async () => ({
			summary: "a summary",
			contextPercent: 10,
		});

		await runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });

		expect(drainCalls).toEqual([NARRATOR_ID]);
		expect(compactLocks.has(NARRATOR_ID)).toBe(false);
	});

	test("a cancelled compact reaches the drain too, so nothing is stranded", async () => {
		seed();
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		narratorContext.generateCompactSummary = (
			_narratorId,
			_locale,
			_messages,
			_pruneBoundaryMessageId,
			signal,
		) => {
			started();
			return new Promise((_resolve, reject) => {
				signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Compact summary aborted", "AbortError")),
					{ once: true },
				);
			});
		};

		const promise = runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });
		await requestStarted;
		expect(cancelCompact(NARRATOR_ID)).toBe(true);
		await expect(promise).rejects.toMatchObject({ name: "AbortError" });

		expect(drainCalls).toEqual([NARRATOR_ID]);
		expect(compactLocks.has(NARRATOR_ID)).toBe(false);
	});
});
