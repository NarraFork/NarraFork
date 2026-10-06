/**
 * Lazy fork refs: a fork materializes only the refs the model still needs (those
 * after the parent's last history compact) and pulls older ones in on demand.
 *
 * These tests pin the properties that make that safe:
 *   - the model's view of history is byte-identical before and after the change
 *   - everything older is still *reachable*, just not copied up front
 *   - the client is told more history exists, so its upward scroll continues
 *   - the chain works across several generations of forks
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessageRefs, narratorMessages, narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { narratorService } = await import("../narrator-service");
const { narratorMessageQueries } = await import("../narrator-messages");
const {
	ensureAllRefsMaterialized,
	ensureRefsCoverSeq,
	hasUnmaterializedRefsBelow,
	requireSqliteLazyRefsBackfill,
	resolveLazyLineage,
} = await import("../narrator-refs-backfill");

const now = "2026-07-30T10:00:00.000Z";

function seedNarrator(id: string) {
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run(id, now, now);
}

async function seedMessage(params: {
	id: string;
	narratorId: string;
	seq: number;
	role?: "user" | "assistant" | "system";
	contentText?: string;
	contentJson?: unknown;
	isCompact?: boolean;
}) {
	await db.insert(narratorMessages).values({
		id: params.id,
		narratorId: params.narratorId,
		role: params.role ?? "assistant",
		contentJson: params.contentJson ?? [{ type: "text", text: params.contentText ?? params.id }],
		contentText: params.contentText ?? params.id,
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${params.narratorId}-${params.id}`,
		narratorId: params.narratorId,
		messageId: params.id,
		seq: params.seq,
		isCompact: params.isCompact ? 1 : 0,
	});
}

/** A compact marker that is finished, so a fork may legitimately share it. */
const STABLE_COMPACT = [{ type: "compact", status: "compacted", summary: "summary" }];

/**
 * Seed a parent with history spanning a compact boundary:
 *   seq 0..3  pre-compact turns
 *   seq 4     the compact marker
 *   seq 5..8  post-compact turns
 */
async function seedParentWithCompact(parentId = "parent") {
	seedNarrator(parentId);
	for (let seq = 0; seq <= 3; seq++) {
		await seedMessage({ id: `${parentId}-old-${seq}`, narratorId: parentId, seq });
	}
	await seedMessage({
		id: `${parentId}-compact`,
		narratorId: parentId,
		seq: 4,
		role: "system",
		contentText: "[Compact] summary",
		contentJson: STABLE_COMPACT,
		isCompact: true,
	});
	for (let seq = 5; seq <= 8; seq++) {
		await seedMessage({ id: `${parentId}-new-${seq}`, narratorId: parentId, seq });
	}
	return { tailMessageId: `${parentId}-new-8` };
}

async function refsOf(narratorId: string) {
	return db
		.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.orderBy(narratorMessageRefs.seq);
}

async function lazyStateOf(narratorId: string) {
	return db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { refsInheritedFrom: true, refsBackfillCursor: true },
	});
}

beforeEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("fork materializes only post-compact refs", () => {
	test("full fork inherits cached characters while fresh fork stays zero without backfilling legacy messages", async () => {
		const { tailMessageId } = await seedParentWithCompact();
		await db
			.update(narrators)
			.set({
				contextSummary: "legacy summary",
				contextSummaryChars: 4,
				contextSystemChars: 20,
				contextToolsChars: 30,
			})
			.where(eq(narrators.id, "parent"));
		const chars = { segments: [{ category: "assistant" as const, chars: 12 }] };
		await db
			.update(narratorMessages)
			.set({ contextCharsJson: chars })
			.where(eq(narratorMessages.id, tailMessageId));
		const full = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			standalone: true,
		});
		expect(full.contextSummaryChars).toBe(4);
		expect(full.contextSystemChars).toBe(20);
		expect(full.contextToolsChars).toBe(30);
		const sharedMessage = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, tailMessageId),
		});
		expect(sharedMessage?.contextCharsJson).toEqual(chars);
		const legacyMessage = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "parent-new-5"),
		});
		expect(legacyMessage?.contextCharsJson).toBeNull();
		const fresh = await narratorService.forkNarrator("parent", null, {
			inheritMode: "fresh",
			standalone: true,
		});
		expect(fresh.contextSummaryChars).toBe(0);
		expect(fresh.contextSystemChars).toBe(0);
		expect(fresh.contextToolsChars).toBe(0);
	});

	test("copies the post-compact tail and records the backfill boundary", async () => {
		const { tailMessageId } = await seedParentWithCompact();

		const child = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			forkMessageId: tailMessageId,
			standalone: true,
		});

		const childRefs = await refsOf(child.id);
		// Only seq 5..8 — the compact marker at 4 and everything before it stays put.
		expect(childRefs.map((r) => r.messageId)).toEqual([
			"parent-new-5",
			"parent-new-6",
			"parent-new-7",
			"parent-new-8",
		]);
		// seq is inherited verbatim, not renumbered from 0: this is what lets a later
		// backfill splice older rows in without shifting anything.
		expect(childRefs.map((r) => r.seq)).toEqual([5, 6, 7, 8]);

		const state = await lazyStateOf(child.id);
		expect(state?.refsInheritedFrom).toBe("parent");
		expect(state?.refsBackfillCursor).toBe(5);
	});

	test("the model's history is identical before and after the fork", async () => {
		const { tailMessageId } = await seedParentWithCompact();
		const parentHistory = await narratorMessageQueries.getModelHistorySinceLastCompact("parent");

		const child = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			forkMessageId: tailMessageId,
			standalone: true,
		});
		const childHistory = await narratorMessageQueries.getModelHistorySinceLastCompact(child.id);

		// The whole premise of the optimization: refs left behind are display-only, so
		// the context the model receives must be unchanged.
		expect(childHistory.map((m) => m.id)).toEqual(parentHistory.map((m) => m.id));
	});

	test("a parent with no compact is copied whole and is not lazy", async () => {
		seedNarrator("plain");
		for (let seq = 0; seq <= 3; seq++) {
			await seedMessage({ id: `plain-${seq}`, narratorId: "plain", seq });
		}

		const child = await narratorService.forkNarrator("plain", null, {
			inheritMode: "full",
			forkMessageId: "plain-3",
			standalone: true,
		});

		const childRefs = await refsOf(child.id);
		expect(childRefs.map((r) => r.messageId)).toEqual(["plain-0", "plain-1", "plain-2", "plain-3"]);
		const state = await lazyStateOf(child.id);
		expect(state?.refsInheritedFrom).toBeNull();
		expect(state?.refsBackfillCursor).toBeNull();
	});
});

describe("older history stays reachable", () => {
	test("hasUnmaterializedRefsBelow reports the hidden history", async () => {
		const { tailMessageId } = await seedParentWithCompact();
		const child = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			forkMessageId: tailMessageId,
			standalone: true,
		});

		expect(await hasUnmaterializedRefsBelow(child.id, 5)).toBeTrue();
		// Nothing hidden below the very start of history.
		expect(await hasUnmaterializedRefsBelow(child.id, 0)).toBeFalse();
		// A narrator that owns all its refs never reports hidden history.
		expect(await hasUnmaterializedRefsBelow("parent", 5)).toBeFalse();
	});

	test("the exact-layout tail page keeps hasPrev true while history is un-materialized", async () => {
		const { tailMessageId } = await seedParentWithCompact();
		const child = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			forkMessageId: tailMessageId,
			standalone: true,
		});

		const tail = await narratorMessageQueries.getPretextDocumentPage(child.id);
		// Without the lazy-aware probe this would be false (only 4 local rows, well
		// under the limit) and the client would stop scrolling at the fork boundary.
		expect(tail.hasPrev).toBeTrue();

		// Walking older pulls the hidden refs in and yields the parent's history.
		const older = await narratorMessageQueries.getPretextDocumentPage(child.id, {
			beforeSeq: tail.minSeq ?? undefined,
			limit: 50,
		});
		expect(older.messages.map((m) => m.id)).toContain("parent-old-0");
		// Fully materialized now: the walk has reached actual start of history.
		expect(older.hasPrev).toBeFalse();
	});

	test("backfilling yields exactly the parent's visible history", async () => {
		const { tailMessageId } = await seedParentWithCompact();
		const child = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			forkMessageId: tailMessageId,
			standalone: true,
		});

		await ensureAllRefsMaterialized(child.id);

		const childRefs = await refsOf(child.id);
		const parentRefs = await refsOf("parent");
		expect(childRefs).toEqual(parentRefs);

		// Fully caught up: the link is dropped so later reads skip the lineage walk.
		const state = await lazyStateOf(child.id);
		expect(state?.refsInheritedFrom).toBeNull();
		expect(state?.refsBackfillCursor).toBeNull();
		expect(await hasUnmaterializedRefsBelow(child.id, 9)).toBeFalse();
	});

	test("a partial backfill advances the cursor without over-copying", async () => {
		const { tailMessageId } = await seedParentWithCompact();
		const child = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			forkMessageId: tailMessageId,
			standalone: true,
		});

		// Ask only for seq >= 3: seq 0..2 must remain in the parent.
		await ensureRefsCoverSeq(child.id, 3);

		const childRefs = await refsOf(child.id);
		expect(childRefs.map((r) => r.seq)).toEqual([3, 4, 5, 6, 7, 8]);
		const state = await lazyStateOf(child.id);
		expect(state?.refsInheritedFrom).toBe("parent");
		expect(state?.refsBackfillCursor).toBe(3);
		expect(await hasUnmaterializedRefsBelow(child.id, 3)).toBeTrue();
	});

	test("backfill is idempotent under concurrent callers", async () => {
		const { tailMessageId } = await seedParentWithCompact();
		const child = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			forkMessageId: tailMessageId,
			standalone: true,
		});

		await Promise.all([
			ensureRefsCoverSeq(child.id, 0),
			ensureRefsCoverSeq(child.id, 0),
			ensureRefsCoverSeq(child.id, 2),
		]);

		const childRefs = await refsOf(child.id);
		// No duplicate rows despite three overlapping backfills.
		expect(childRefs.map((r) => r.messageId)).toEqual(
			(await refsOf("parent")).map((r) => r.messageId),
		);
		expect(new Set(childRefs.map((r) => r.messageId)).size).toBe(childRefs.length);
	});
});

describe("chained forks", () => {
	/**
	 * parent (0..8, compact at 4)
	 *   └─ child   inherits 5..8, then gets its own turn at 9 and a compact at 10
	 *        └─ grandchild inherits 11..12
	 */
	async function seedChain() {
		const { tailMessageId } = await seedParentWithCompact();
		const child = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			forkMessageId: tailMessageId,
			standalone: true,
		});
		await seedMessage({ id: "child-own-9", narratorId: child.id, seq: 9 });
		await seedMessage({
			id: "child-compact-10",
			narratorId: child.id,
			seq: 10,
			role: "system",
			contentText: "[Compact] child",
			contentJson: STABLE_COMPACT,
			isCompact: true,
		});
		await seedMessage({ id: "child-own-11", narratorId: child.id, seq: 11 });
		await seedMessage({ id: "child-own-12", narratorId: child.id, seq: 12 });

		const grandchild = await narratorService.forkNarrator(child.id, null, {
			inheritMode: "full",
			forkMessageId: "child-own-12",
			standalone: true,
		});
		return { childId: child.id, grandchildId: grandchild.id };
	}

	test("the grandchild only materializes its own post-compact tail", async () => {
		const { grandchildId } = await seedChain();
		const refs = await refsOf(grandchildId);
		expect(refs.map((r) => r.messageId)).toEqual(["child-own-11", "child-own-12"]);
	});

	test("the lineage walk narrows the bound at each generation", async () => {
		const { childId, grandchildId } = await seedChain();
		const lineage = await resolveLazyLineage(grandchildId);

		expect(lineage.map((s) => s.parentNarratorId)).toEqual([childId, "parent"]);
		// The grandchild inherits from seq 11 down; it can never see more of the
		// original parent than its own parent was entitled to.
		expect(lineage[0].upperBoundSeq).toBe(11);
		expect(lineage[1].upperBoundSeq).toBeLessThanOrEqual(11);
	});

	test("backfill walks through two generations to the original history", async () => {
		const { grandchildId } = await seedChain();

		await ensureAllRefsMaterialized(grandchildId);

		const refs = await refsOf(grandchildId);
		// Reaches all the way back to the parent's oldest pre-compact turn.
		expect(refs.map((r) => r.messageId)).toContain("parent-old-0");
		expect(refs.map((r) => r.messageId)).toContain("child-own-9");
		expect(refs.map((r) => r.seq)).toEqual([...refs].map((r) => r.seq).sort((a, b) => a - b));
		expect(await hasUnmaterializedRefsBelow(grandchildId, 13)).toBeFalse();
	});
});

/**
 * The lineage is what widens search across a fork's ancestry — the scopes it
 * produces are consumed by `searchService.searchNarratorMessages`, whose own
 * behaviour is covered in tests/server/services/narrator-message-search.test.ts
 * (that file owns the FTS setup). Here we only pin the scopes themselves.
 */
describe("lineage scopes handed to search", () => {
	test("bounds the ancestor at the seq the child inherited from", async () => {
		const { tailMessageId } = await seedParentWithCompact();
		const child = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			forkMessageId: tailMessageId,
			standalone: true,
		});

		// The parent keeps working after the fork diverged.
		await seedMessage({ id: "parent-after-fork", narratorId: "parent", seq: 20 });

		const lineage = await resolveLazyLineage(child.id);
		expect(lineage).toEqual([
			{ narratorId: child.id, parentNarratorId: "parent", upperBoundSeq: 5 },
		]);
		// The bound is the child's own floor, so the parent's post-fork seq 20 — and its
		// compact marker at 4 — can never enter the child's search scope.
		expect(lineage[0].upperBoundSeq).toBeLessThan(20);
	});

	test("a non-lazy narrator produces no scopes at all", async () => {
		seedNarrator("solo");
		await seedMessage({ id: "solo-1", narratorId: "solo", seq: 0 });
		expect(await resolveLazyLineage("solo")).toEqual([]);
	});
});

describe("PostgreSQL lazy-ref admission", () => {
	test("refuses before querying or mutating the SQLite-shaped store", () => {
		expect(() => requireSqliteLazyRefsBackfill("Lazy narrator refs fallback", "postgres")).toThrow(
			/503|PostgreSQL backend/,
		);
		expect(() =>
			requireSqliteLazyRefsBackfill("Lazy narrator refs fallback", "sqlite"),
		).not.toThrow();
	});
});

describe("detaching lazy forks before their ancestor disappears", () => {
	/**
	 * `narratorService.remove` normally cascades into descendants via
	 * `parentNarratorId`, so a lazy fork is deleted along with its ancestor. This
	 * guard covers the case where the two links diverge (a child that exhausted its
	 * parent and relinked to a grandparent): the ancestor's removal must not leave a
	 * dangling `refsInheritedFrom`, which both violates the FK and would silently
	 * hide the child's older history.
	 */
	test("materializeChildrenOf preserves history and clears the link", async () => {
		const { tailMessageId } = await seedParentWithCompact();
		const child = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			forkMessageId: tailMessageId,
			standalone: true,
		});
		expect((await lazyStateOf(child.id))?.refsInheritedFrom).toBe("parent");

		const { materializeChildrenOf } = await import("../narrator-refs-backfill");
		const detached = await materializeChildrenOf("parent");

		expect(detached).toEqual([child.id]);
		const state = await lazyStateOf(child.id);
		expect(state?.refsInheritedFrom).toBeNull();
		expect(state?.refsBackfillCursor).toBeNull();
		// The pre-compact history was copied over before the link was cut.
		const refs = await refsOf(child.id);
		expect(refs.map((r) => r.messageId)).toContain("parent-old-0");
		expect(refs).toEqual(await refsOf("parent"));
	});

	test("removing a parent still cascades into its fork children", async () => {
		const { tailMessageId } = await seedParentWithCompact();
		const child = await narratorService.forkNarrator("parent", null, {
			inheritMode: "full",
			forkMessageId: tailMessageId,
			standalone: true,
		});

		await narratorService.remove("parent");

		// Unchanged behaviour: the child is a fork child, so it goes with the parent.
		expect(
			await db.query.narrators.findFirst({ where: eq(narrators.id, child.id) }),
		).toBeUndefined();
		expect(
			await db.query.narrators.findFirst({ where: eq(narrators.id, "parent") }),
		).toBeUndefined();
	});
});
