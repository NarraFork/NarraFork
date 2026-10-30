/**
 * Outline task pieces that need no second dialect: the in-process rebuild stopping for shutdown,
 * the block the lease expiry job writes, and the lease keeper backing off a failing database.
 * The claim and lease rules themselves are in the store contract (`task-contract.ts`, both
 * dialects).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "@server/lib/logger";
import { parseBlock } from "@shared/outline";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { narrators, outlineBlocks, outlineSpaces, users } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import {
	OUTLINE_IN_PROCESS_TIMING,
	rebuildOutlineInProcess,
	requestOutlineInProcessRebuild,
	resumeOutlineInProcessRebuildForTests,
	runOutlineInProcessRebuild,
	stopOutlineInProcessRebuild,
} from "../in-process";
import { keepOutlineTaskLeases, OUTLINE_LEASE_RETRY } from "../lease-keeper";
import { contentLinks } from "../links";
import { OUTLINE_TASK_LEASE } from "../model";
import type { OutlineStore } from "../store/port";
import { sqliteOutlineStore as store } from "../store/sqlite-store";
import { outlineLeaseExpiredNote } from "../tasks";
import { writeOutline } from "../write";

const NOW = "2026-10-26T00:00:00.000Z";
const saved = { ...OUTLINE_IN_PROCESS_TIMING };

afterEach(() => {
	resumeOutlineInProcessRebuildForTests();
	Object.assign(OUTLINE_IN_PROCESS_TIMING, saved);
});

async function staleSpace(): Promise<string> {
	const user = generateId();
	await db
		.insert(users)
		.values({ id: user, username: `u-${user}`, passwordHash: "x", role: "user", createdAt: NOW });
	const narrator = generateId();
	await db.insert(narrators).values({ id: narrator, title: "t", createdAt: NOW, updatedAt: NOW });
	const space = await store.ensureSpace({ kind: "personal", ownerUserId: user }, NOW);
	await writeOutline(
		{
			spaceId: space.id,
			ops: [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", parent: { tempId: "p" }, content: "task", task: { status: "todo" } },
			],
			actor: { kind: "agent", id: narrator },
			narratorId: narrator,
			responsibleUserId: null,
		},
		{ store },
	);
	await db
		.update(outlineSpaces)
		.set({ inProcessReady: false })
		.where(eq(outlineSpaces.id, space.id));
	await db
		.update(outlineBlocks)
		.set({ inProcess: false })
		.where(eq(outlineBlocks.spaceId, space.id));
	return space.id;
}

describe("in-process rebuild at shutdown", () => {
	test("a stop ends the run in progress, and nothing runs or is scheduled after it", async () => {
		OUTLINE_IN_PROCESS_TIMING.retryMinMs = 20;
		OUTLINE_IN_PROCESS_TIMING.requestDelayMs = 10;
		let listings = 0;
		const failing: OutlineStore = {
			...store,
			async listSpacesPendingInProcess() {
				listings++;
				await new Promise((r) => setTimeout(r, 30));
				throw new Error("db closed");
			},
		};
		const run = runOutlineInProcessRebuild(failing);
		const stopped = stopOutlineInProcessRebuild();
		await stopped;
		expect(await run).toBeNull();
		// A failed run would retry after 20 ms, a request after 10 ms: neither does after a stop.
		requestOutlineInProcessRebuild(failing);
		expect(await runOutlineInProcessRebuild(failing)).toBeNull();
		await new Promise((r) => setTimeout(r, 120));
		expect(listings).toBe(1);
	});

	test("a stop lands between pages: the run visits no further page or space", async () => {
		const first = await staleSpace();
		const second = await staleSpace();
		let pagesListed = 0;
		const stopping: OutlineStore = {
			...store,
			async listSpacePages(spaceId, options) {
				pagesListed++;
				const pages = await store.listSpacePages(spaceId, options);
				void stopOutlineInProcessRebuild();
				return pages;
			},
		};
		const result = await rebuildOutlineInProcess({ store: stopping });
		expect(pagesListed).toBe(1);
		expect(result.spaces).toBe(0);
		const state = await store.getInProcessState([first, second]);
		expect(state.get(first)?.ready).toBe(false);
		expect(state.get(second)?.ready).toBe(false);
		// Resumed, it finishes both.
		resumeOutlineInProcessRebuildForTests();
		await rebuildOutlineInProcess({ store });
		const after = await store.getInProcessState([first, second]);
		expect(after.get(first)?.ready).toBe(true);
		expect(after.get(second)?.ready).toBe(true);
	});
});

describe("the lease expiry note", () => {
	test("a session title with outline syntax is written as plain text", () => {
		const title = "Fix [[Q1]] *now* ![[embed]] `code` #tag";
		const note = outlineLeaseExpiredNote("narrator_id-1", title);
		// No link, embed or mark comes out of the title.
		expect(contentLinks(note)).toEqual([]);
		const body = parseBlock(note).body;
		expect(body.type).toBe("paragraph");
		const inlines = body.type === "paragraph" ? body.content : [];
		const text = inlines.map((n) => (n.type === "text" ? n.text : "")).join("");
		expect(text).toContain(`"${title}"`);
		expect(text).toContain("narrator_id-1");
		// Only the session id is code.
		const code = inlines.filter((n) => n.type === "text" && n.marks.some((m) => m.type === "code"));
		expect(code.map((n) => (n.type === "text" ? n.text : ""))).toEqual(["narrator_id-1"]);
	});
});

describe("lease renewal against a failing database", () => {
	test("retries after a growing back-off rather than at every boundary, and warns at most every ten minutes", async () => {
		let down = true;
		const attempts: number[] = [];
		const flaky: OutlineStore = {
			...store,
			async renewTaskClaims(narratorId, expiresAt) {
				attempts.push(clock);
				if (down) throw new Error("database is locked");
				return store.renewTaskClaims(narratorId, expiresAt);
			},
		};
		const warn = spyOn(logger, "warn");
		const info = spyOn(logger, "info");
		const start = Date.parse(NOW);
		let clock = start;
		const keeper = keepOutlineTaskLeases(generateId(), {
			store: flaky,
			now: () => clock,
			enabled: () => true,
			intervalMs: 0,
		});
		try {
			await new Promise((r) => setTimeout(r, 0));
			// A tool boundary every second for twenty minutes.
			for (let second = 1; second <= 20 * 60; second++) {
				clock = start + second * 1000;
				await keeper.touch();
			}
			const gaps = attempts.slice(1).map((t, i) => (t - (attempts[i] as number)) / 1000);
			const cap = OUTLINE_TASK_LEASE.renewEveryMs / 1000;
			const first = OUTLINE_LEASE_RETRY.firstMs / 1000;
			expect(gaps.slice(0, 4)).toEqual([first, first * 2, first * 4, Math.min(cap, first * 8)]);
			expect(gaps.every((g) => g <= cap)).toBe(true);
			expect(attempts.length).toBeLessThan(20);
			const warned = warn.mock.calls.filter(
				([message]) => message === "Outline task leases could not be renewed",
			);
			// At the first failure and once more ten minutes on, not once per attempt.
			expect(warned.length).toBe(2);

			// The database is back: renewed at the next retry, said once, then every two minutes.
			down = false;
			const before = attempts.length;
			for (let second = 1; second <= 5 * 60; second++) {
				clock = start + (20 * 60 + second) * 1000;
				await keeper.touch();
			}
			expect(attempts.length - before).toBeGreaterThanOrEqual(2);
			expect(attempts.length - before).toBeLessThanOrEqual(4);
			expect(
				info.mock.calls.filter(([message]) => message === "Outline task leases renewed again"),
			).toHaveLength(1);
		} finally {
			await keeper.stop();
			warn.mockRestore();
			info.mockRestore();
		}
	});
});
