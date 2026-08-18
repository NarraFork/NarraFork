import { describe, expect, test } from "bun:test";
import {
	type DraftAttachmentRecordStat,
	selectDraftAttachmentsToEvict,
} from "./draft-image-attachments";

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

function record(draftKey: string, ageDays: number, megabytes: number): DraftAttachmentRecordStat {
	return {
		draftKey,
		updatedAtMs: NOW - ageDays * DAY_MS,
		totalBytes: megabytes * MB,
	};
}

/** Defaults chosen so only the rule under test can fire. */
function evict(
	records: DraftAttachmentRecordStat[],
	overrides: Partial<Parameters<typeof selectDraftAttachmentsToEvict>[0]> = {},
): string[] {
	return selectDraftAttachmentsToEvict({
		records,
		now: NOW,
		protectKey: null,
		ttlMs: 3 * DAY_MS,
		maxTotalBytes: 100 * MB,
		maxRecords: 20,
		...overrides,
	}).sort();
}

describe("draft attachment eviction — TTL", () => {
	test("evicts records past the TTL and keeps the rest", () => {
		const doomed = evict([record("old", 4, 1), record("fresh", 1, 1)]);
		expect(doomed).toEqual(["old"]);
	});

	test("a record exactly at the TTL boundary survives", () => {
		// `< cutoff` rather than `<=`: a record whose age equals the TTL has not yet
		// exceeded it, and rounding it out would expire drafts a tick early.
		expect(evict([record("boundary", 3, 1)])).toEqual([]);
	});

	test("a record with an unusable timestamp is treated as ancient, not fresh", () => {
		// Otherwise a record that lost its timestamp could never be evicted by age.
		expect(evict([{ draftKey: "no-time", updatedAtMs: 0, totalBytes: MB }])).toEqual(["no-time"]);
	});

	test("expired bytes do not count against records that are still current", () => {
		// The 200MB expired record is removed by rule 1, so the two small fresh ones
		// must survive rule 2 rather than being evicted to make room for bytes that
		// are already gone.
		const doomed = evict([record("huge-expired", 5, 200), record("a", 1, 1), record("b", 1, 1)]);
		expect(doomed).toEqual(["huge-expired"]);
	});
});

describe("draft attachment eviction — total bytes", () => {
	test("evicts oldest first until the total fits", () => {
		const doomed = evict([
			record("oldest", 2, 40),
			record("middle", 1, 40),
			record("newest", 0, 40),
		]);
		// 120MB > 100MB: dropping the oldest 40MB brings it to 80MB and stops.
		expect(doomed).toEqual(["oldest"]);
	});

	test("keeps evicting while still over budget", () => {
		const doomed = evict([
			record("a", 3, 50),
			record("b", 2, 50),
			record("c", 1, 50),
			record("d", 0, 50),
		]);
		expect(doomed).toEqual(["a", "b"]);
	});

	test("a total exactly at the budget evicts nothing", () => {
		expect(evict([record("a", 1, 50), record("b", 0, 50)])).toEqual([]);
	});
});

describe("draft attachment eviction — record count", () => {
	test("keeps the newest N records", () => {
		const records = Array.from({ length: 5 }, (_, index) =>
			// index 0 is the oldest.
			record(`r${index}`, 5 - index, 1),
		);
		expect(evict(records, { maxRecords: 3 })).toEqual(["r0", "r1"]);
	});

	test("evicts nothing when exactly at the cap", () => {
		const records = Array.from({ length: 3 }, (_, index) => record(`r${index}`, 3 - index, 1));
		expect(evict(records, { maxRecords: 3 })).toEqual([]);
	});
});

describe("draft attachment eviction — the protected record", () => {
	test("is never evicted for age", () => {
		// Reachable via a clock change: the record just written must not be removed
		// by the prune its own write triggered.
		expect(evict([record("current", 99, 1)], { protectKey: "current" })).toEqual([]);
	});

	test("is never evicted for bytes, even when it alone exceeds the budget", () => {
		// This is the case that made protection necessary: stored successfully, then
		// deleted by its own prune, with no signal anywhere.
		expect(evict([record("current", 0, 150)], { protectKey: "current" })).toEqual([]);
	});

	test("its bytes still count, so older records are evicted to make room", () => {
		const doomed = evict([record("current", 0, 90), record("old", 2, 30)], {
			protectKey: "current",
		});
		expect(doomed).toEqual(["old"]);
	});

	test("is never evicted for count, even as the oldest record", () => {
		const doomed = evict(
			[record("current", 9, 1), record("a", 2, 1), record("b", 1, 1), record("c", 0, 1)],
			{ protectKey: "current", maxRecords: 2 },
		);
		// Two of the three unprotected records go; `current` stays despite being oldest.
		expect(doomed).toEqual(["a", "b"]);
	});
});

describe("draft attachment eviction — edges", () => {
	test("no records selects nothing", () => {
		expect(evict([])).toEqual([]);
	});

	test("one fresh in-budget record selects nothing", () => {
		expect(evict([record("only", 0, 1)])).toEqual([]);
	});

	test("never returns the same key twice", () => {
		// A record can qualify under several rules; the caller deletes by key, so a
		// duplicate would mean a redundant delete per rule matched.
		const raw = selectDraftAttachmentsToEvict({
			records: [record("doomed", 10, 500), record("keep", 0, 1)],
			now: NOW,
			protectKey: null,
			ttlMs: 3 * DAY_MS,
			maxTotalBytes: 100 * MB,
			maxRecords: 1,
		});
		expect(raw).toEqual(["doomed"]);
		expect(new Set(raw).size).toBe(raw.length);
	});
});
