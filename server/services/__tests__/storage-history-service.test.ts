import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	StorageHistoryCandidate,
	StorageRetentionSettings,
	StorageRetentionTarget,
} from "@shared/storage-retention";
import type { StorageHistoryReadParams } from "../../lib/db-worker/storage-history-query";
import {
	createStorageHistoryService,
	normalizeStorageHistoryCutoff,
} from "../storage-history-service";

const homes: string[] = [];
const services: Array<ReturnType<typeof createStorageHistoryService>> = [];
const now = Date.parse("2026-11-08T12:00:00.000Z");
const cutoff = "2026-06-01T00:00:00.000Z";
afterEach(async () => {
	for (const service of services.splice(0)) {
		service.stop();
		await service.settled();
	}
	for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "nf-retention-job-"));
	homes.push(home);
	const policies: StorageRetentionSettings = {
		toolCallPayloads: { retentionDays: null, autoCleanup: false },
		messageHistory: { retentionDays: null, autoCleanup: false },
	};
	const rows: Record<StorageRetentionTarget, StorageHistoryCandidate[]> = {
		toolCallPayloads: [],
		messageHistory: [],
	};
	const reads: StorageHistoryReadParams[] = [];
	const cleared: Array<{ target: StorageRetentionTarget; id: string; cutoffAt: string }> = [];
	const path = join(home, "jobs.json");
	const deps = {
		journalPath: path,
		policies: () => policies,
		now: () => now,
		read: async <T>(params: StorageHistoryReadParams): Promise<T> => {
			reads.push(params);
			if (params.mode === "buckets")
				return (
					params.dayOffsetMs
						? [
								{ day: "2026-01-01", count: 3, approxBytes: 300 },
								{ day: "2026-05-31", count: 1, approxBytes: 40 },
								{ day: "2026-06-01", count: 1, approxBytes: 40 },
							]
						: [
								{ day: "2026-01-01", count: 3, approxBytes: 300 },
								{ day: "2026-06-01", count: 2, approxBytes: 80 },
							]
				) as T;
			return rows[params.target]
				.filter((r) => r.rowid > params.afterRowid)
				.slice(0, params.limit) as T;
		},
		clear: async (input: {
			target: StorageRetentionTarget;
			candidate: StorageHistoryCandidate;
			cutoffAt: string;
		}) => {
			cleared.push({ target: input.target, id: input.candidate.id, cutoffAt: input.cutoffAt });
			rows[input.target] = rows[input.target].filter((r) => r.id !== input.candidate.id);
			return { cleared: true, retained: false };
		},
		maintenance: async <T>(work: () => Promise<T>) => work(),
	};
	const create = () => {
		const s = createStorageHistoryService(deps);
		services.push(s);
		return s;
	};
	return { create, deps, path, policies, rows, reads, cleared };
}
function candidate(id: string, rowid: number): StorageHistoryCandidate {
	return { id, rowid, messageId: "message", revision: 0, approxBytes: 100 };
}

describe("history cleanup previews", () => {
	test("cache follows the selected midnight and reuses buckets for non-UTC dates", async () => {
		const f = await fixture();
		const service = f.create();
		expect(await service.preview("messageHistory", cutoff)).toEqual({
			target: "messageHistory",
			cutoffAt: cutoff,
			count: 3,
			approxBytes: 300,
		});
		expect((await service.preview("messageHistory", "2026-06-01T08:00:00+02:00")).approxBytes).toBe(
			340,
		);
		expect((await service.preview("messageHistory", "2026-06-02T08:00:00+02:00")).approxBytes).toBe(
			380,
		);
		expect(f.reads.map((r) => r.mode)).toEqual(["buckets", "buckets"]);
		expect(f.policies.messageHistory).toEqual({ retentionDays: null, autoCleanup: false });
	});
	test("tool and message previews have independent caches", async () => {
		const f = await fixture();
		const service = f.create();
		await service.preview("messageHistory", cutoff);
		await service.preview("toolCallPayloads", cutoff);
		expect(f.reads.filter((r) => r.mode === "buckets")).toHaveLength(2);
	});
	test("requires an absolute time with a timezone and rejects future dates", () => {
		expect(normalizeStorageHistoryCutoff("2026-06-01T00:00:00+08:00", now)).toBe(
			"2026-05-31T16:00:00.000Z",
		);
		for (const v of ["2026-06-01", "2026-06-01T00:00:00", "invalid", "2030-01-01T00:00:00Z"])
			expect(() => normalizeStorageHistoryCutoff(v, now)).toThrow();
	});
});

describe("independent persistent history cleanup jobs", () => {
	test("manual cleanup freezes its cutoff and leaves automatic settings unchanged", async () => {
		const f = await fixture();
		f.rows.toolCallPayloads = [candidate("t", 1)];
		f.rows.messageHistory = [candidate("m", 1)];
		const service = f.create();
		const job = await service.start("toolCallPayloads", cutoff);
		await service.settled();
		expect(f.cleared).toEqual([{ target: "toolCallPayloads", id: "t", cutoffAt: cutoff }]);
		expect(f.rows.messageHistory).toHaveLength(1);
		expect((await service.jobs()).toolCallPayloads).toMatchObject({
			id: job.id,
			status: "completed",
			cleared: 1,
			approxBytes: 100,
		});
		expect(f.policies.toolCallPayloads).toEqual({ retentionDays: null, autoCleanup: false });
		const saved = JSON.parse(await readFile(f.path, "utf8"));
		expect(saved.jobs.toolCallPayloads.cursor).toBe(1);
		expect(saved.jobs.messageHistory).toBeNull();
	});
	test("all-history defaults schedule nothing; automatic tool retention leaves messages alone", async () => {
		const f = await fixture();
		f.rows.toolCallPayloads = [candidate("t", 1)];
		const service = f.create();
		await service.startScheduler();
		await service.settled();
		expect(f.cleared).toHaveLength(0);
		f.policies.toolCallPayloads = { retentionDays: 30, autoCleanup: true };
		await service.automatic(true, ["toolCallPayloads"]);
		await service.settled();
		expect(f.cleared[0]).toMatchObject({
			target: "toolCallPayloads",
			cutoffAt: "2026-10-09T12:00:00.000Z",
		});
		expect((await service.jobs()).messageHistory).toBeNull();
		await service.automatic();
		await service.settled();
		expect(f.cleared).toHaveLength(1);
	});
	test("cancellation stops pending database work and persists a terminal job", async () => {
		const f = await fixture();
		f.rows.toolCallPayloads = [candidate("t", 1)];
		let release!: () => void;
		let entered!: () => void;
		const admitted = new Promise<void>((r) => (entered = r));
		const wait = new Promise<void>((r) => (release = r));
		f.deps.maintenance = async <T>(work: () => Promise<T>) => {
			entered();
			await wait;
			return work();
		};
		const service = f.create();
		await service.start("toolCallPayloads", cutoff);
		await admitted;
		await service.cancel("toolCallPayloads");
		release();
		await service.settled();
		expect(f.cleared).toHaveLength(0);
		expect((await service.jobs()).toolCallPayloads?.status).toBe("cancelled");
	});
	test("restart resumes a fixed manual range from its persisted cursor", async () => {
		const f = await fixture();
		f.rows.messageHistory = [candidate("m1", 1), candidate("m2", 2)];
		const service = f.create();
		const original = f.deps.clear;
		f.deps.clear = async (input) => {
			const result = await original(input);
			service.stop();
			return result;
		};
		await service.start("messageHistory", cutoff);
		await service.settled();
		expect((await service.jobs()).messageHistory).toMatchObject({ status: "queued", cleared: 1 });
		f.deps.clear = original;
		const restarted = f.create();
		await restarted.startScheduler();
		await restarted.settled();
		expect(f.cleared.map((r) => r.id)).toEqual(["m1", "m2"]);
		expect((await restarted.jobs()).messageHistory).toMatchObject({
			status: "completed",
			cleared: 2,
		});
	});
});

describe("automatic policy and cancellation races", () => {
	test("closing automatic cleanup is rechecked immediately before clearing a candidate", async () => {
		const f = await fixture();
		f.policies.toolCallPayloads = { retentionDays: 7, autoCleanup: true };
		f.rows.toolCallPayloads = [candidate("t", 1)];
		let release!: () => void;
		let enter!: () => void;
		const entered = new Promise<void>((r) => {
			enter = r;
		});
		const wait = new Promise<void>((r) => {
			release = r;
		});
		f.deps.maintenance = async <T>(work: () => Promise<T>) => {
			enter();
			await wait;
			return work();
		};
		const service = f.create();
		await service.automatic(true, ["toolCallPayloads"]);
		await entered;
		f.policies.toolCallPayloads.autoCleanup = false;
		release();
		await service.settled();
		expect(f.cleared).toHaveLength(0);
		expect((await service.jobs()).toolCallPayloads?.status).toBe("cancelled");
	});

	test("extending retention cancels the aggressive automatic range and creates the new one", async () => {
		const f = await fixture();
		f.policies.toolCallPayloads = { retentionDays: 7, autoCleanup: true };
		f.rows.toolCallPayloads = [candidate("t", 1)];
		let release!: () => void;
		let enter!: () => void;
		const entered = new Promise<void>((r) => {
			enter = r;
		});
		const wait = new Promise<void>((r) => {
			release = r;
		});
		f.deps.maintenance = async <T>(work: () => Promise<T>) => {
			enter();
			await wait;
			return work();
		};
		const service = f.create();
		await service.automatic(true, ["toolCallPayloads"]);
		await entered;
		f.policies.toolCallPayloads.retentionDays = 365;
		const replacement = service.automatic(true, ["toolCallPayloads"]);
		release();
		await replacement;
		await service.settled();
		expect(f.cleared).toEqual([
			{ target: "toolCallPayloads", id: "t", cutoffAt: "2025-11-08T12:00:00.000Z" },
		]);
	});

	test("confirmed cancellation is durable before a runner finishes and remains cancelled across shutdown", async () => {
		const f = await fixture();
		f.rows.messageHistory = [candidate("m", 1)];
		let release!: () => void;
		let enter!: () => void;
		const entered = new Promise<void>((r) => {
			enter = r;
		});
		const wait = new Promise<void>((r) => {
			release = r;
		});
		f.deps.maintenance = async <T>(work: () => Promise<T>) => {
			enter();
			await wait;
			return work();
		};
		const service = f.create();
		await service.start("messageHistory", cutoff);
		await entered;
		await service.cancel("messageHistory");
		const saved = JSON.parse(await readFile(f.path, "utf8"));
		expect(saved.jobs.messageHistory).toMatchObject({ status: "cancelled", cancelRequested: true });
		service.stop();
		release();
		await service.settled();
		const restarted = f.create();
		await restarted.startScheduler();
		await restarted.settled();
		expect((await restarted.jobs()).messageHistory?.status).toBe("cancelled");
		expect(f.cleared).toHaveLength(0);
	});
});

test("the final store guard observes policy changes while body preparation is awaiting", async () => {
	const f = await fixture();
	f.policies.toolCallPayloads = { retentionDays: 7, autoCleanup: true };
	f.rows.toolCallPayloads = [candidate("t", 1)];
	let release!: () => void;
	let enter!: () => void;
	const entered = new Promise<void>((r) => {
		enter = r;
	});
	const wait = new Promise<void>((r) => {
		release = r;
	});
	const original = f.deps.clear;
	f.deps.clear = async (input) => {
		enter();
		await wait;
		const canClear = (input as { canClear?: () => boolean }).canClear;
		expect(canClear).toBeFunction();
		return canClear?.() ? original(input) : { cleared: false, retained: true };
	};
	const service = f.create();
	await service.automatic(true, ["toolCallPayloads"]);
	await entered;
	f.policies.toolCallPayloads.retentionDays = 365;
	release();
	await service.settled();
	expect(f.cleared).toHaveLength(0);
	expect((await service.jobs()).toolCallPayloads).toMatchObject({
		status: "cancelled",
		retained: 1,
	});
});

test("a journal write failure leaves no phantom queued job and can be retried", async () => {
	const f = await fixture();
	const service = f.create();
	await service.jobs();
	const directory = join(dirname(f.path), "missing");
	f.deps.journalPath = join(directory, "jobs.json");
	await expect(service.start("toolCallPayloads", cutoff)).rejects.toThrow();
	expect((await service.jobs()).toolCallPayloads).toBeNull();
	expect(f.cleared).toHaveLength(0);
	await mkdir(directory, { recursive: true });
	await service.start("toolCallPayloads", cutoff);
	await service.settled();
	expect((await service.jobs()).toolCallPayloads?.status).toBe("completed");
});
