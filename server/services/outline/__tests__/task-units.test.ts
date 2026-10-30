/**
 * Outline task pieces that need no second dialect: the in-process rebuild stopping for shutdown,
 * and the block the lease expiry job writes. The claim and lease rules themselves are in the
 * store contract (`task-contract.ts`, both dialects).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
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
import { contentLinks } from "../links";
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
