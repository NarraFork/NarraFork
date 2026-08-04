import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deleteCredentialUsageTotals,
	getCredentialUsageTotals,
	recordCredentialUsage,
} from "@server/services/credential-usage-totals";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { CodexManager, isArchivedCodexCredential } from "../codex-manager";

interface SeedCredential {
	id: string;
	priority?: number;
	disabled?: boolean;
	disabledReason?: string;
	quotaResetsAt?: number;
	archivedAt?: number;
	planType?: string;
	remainingPercent?: number;
}

function createManager(creds: SeedCredential[]): { manager: CodexManager; tmpHome: string } {
	const tmpHome = mkdtempSync(join(tmpdir(), "narrafork-codex-archive-"));
	const narraforkDir = join(tmpHome, ".narrafork");
	mkdirSync(narraforkDir, { recursive: true });

	const now = Date.now();
	const payload = creds.map((c, index) => ({
		id: c.id,
		refreshToken: `rt-${c.id}`,
		accessToken: `at-${c.id}`,
		expiresAt: now + 30 * 60_000,
		accountId: `acc-${c.id}`,
		priority: c.priority ?? index,
		disabled: c.disabled ?? false,
		disabledReason: c.disabledReason,
		quotaResetsAt: c.quotaResetsAt,
		archivedAt: c.archivedAt,
		usage: c.planType
			? {
					plan_type: c.planType,
					primary_window: {
						used_percent: 100 - (c.remainingPercent ?? 100),
						remaining_percent: c.remainingPercent ?? 100,
						reset_at: Math.floor((now + 60 * 60_000) / 1000),
						reset_after_seconds: 60 * 60,
						window_type: "5h",
						limit_window_seconds: 18000,
					},
					queriedAt: new Date(now).toISOString(),
				}
			: undefined,
	}));
	writeFileSync(join(narraforkDir, "codex-credentials.json"), JSON.stringify(payload, null, 2));
	writeFileSync(join(narraforkDir, "codex-stats.json"), JSON.stringify({}, null, 2));

	return { manager: new CodexManager({ homeDir: tmpHome, registerProcessHooks: false }), tmpHome };
}

function readCredentialsFile(tmpHome: string): Array<Record<string, unknown>> {
	const raw = readFileSync(join(tmpHome, ".narrafork", "codex-credentials.json"), "utf8");
	return JSON.parse(raw) as Array<Record<string, unknown>>;
}

const tempHomes: string[] = [];
const { db, sqlite } = getTestDb();

afterEach(() => {
	for (const p of tempHomes.splice(0)) {
		rmSync(p, { recursive: true, force: true });
	}
	cleanDb(sqlite);
});

describe("CodexManager credential archiving", () => {
	test("归档的凭据不会被选中，可用凭据只算活跃池", async () => {
		const { manager, tmpHome } = createManager([{ id: "cred-a" }, { id: "cred-b" }]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("priority");
		manager.archiveCredential("cred-a");

		expect(manager.archivedCount).toBe(1);
		expect(manager.availableCount).toBe(1);

		// Repeat because priority mode is deterministic but balanced modes are not:
		// an archived credential must never surface regardless of ordering luck.
		for (let i = 0; i < 5; i++) {
			const ctx = await manager.acquireContext();
			expect(ctx.id).toBe("cred-b");
		}

		manager.dispose();
	});

	test("归档最后一个可用凭据后 acquireContext 抛错而不是返回归档凭据", async () => {
		const { manager, tmpHome } = createManager([{ id: "solo" }]);
		tempHomes.push(tmpHome);

		manager.archiveCredential("solo");

		await expect(manager.acquireContext()).rejects.toThrow(/exhausted/i);
		expect(manager.hasCredentials).toBe(true);

		manager.dispose();
	});

	test("snapshot 把归档凭据放进独立分区，不计入可用/不可用", () => {
		const { manager, tmpHome } = createManager([
			{ id: "active" },
			{ id: "broken", disabled: true, disabledReason: "too_many_failures" },
			{ id: "retired" },
		]);
		tempHomes.push(tmpHome);

		manager.archiveCredential("retired");
		const snapshot = manager.snapshot();

		expect(snapshot.availableEntries.map((e) => e.id)).toEqual(["active"]);
		expect(snapshot.unavailableEntries.map((e) => e.id)).toEqual(["broken"]);
		expect(snapshot.archivedEntries.map((e) => e.id)).toEqual(["retired"]);
		expect(snapshot.availableTotal).toBe(1);
		expect(snapshot.unavailableTotal).toBe(1);
		expect(snapshot.archivedTotal).toBe(1);
		// `total` still counts every stored credential; only the pool buckets shrink.
		expect(snapshot.total).toBe(3);
		expect(snapshot.archivedEntries[0]?.archivedAt).toBeGreaterThan(0);

		manager.dispose();
	});

	test("归档凭据不参与 self-heal，也不被 unhealthy 批量删除清掉", () => {
		const { manager, tmpHome } = createManager([
			{ id: "healthy" },
			{ id: "retired-broken", disabled: true, disabledReason: "too_many_failures" },
		]);
		tempHomes.push(tmpHome);

		manager.archiveCredential("retired-broken");

		const removed = manager.removeUnhealthyCredentials();
		expect(removed.removed).toEqual([]);

		const snapshot = manager.snapshot();
		expect(snapshot.archivedEntries.map((e) => e.id)).toEqual(["retired-broken"]);
		// Still disabled: archiving freezes state instead of silently healing it.
		expect(snapshot.archivedEntries[0]?.disabled).toBe(true);

		manager.dispose();
	});

	test("归档凭据被 usage scheduler 跳过", () => {
		const soonReset = Date.now() + 60_000;
		const { manager, tmpHome } = createManager([
			{
				id: "exhausted",
				disabled: true,
				disabledReason: "quota_exhausted",
				quotaResetsAt: soonReset,
			},
		]);
		tempHomes.push(tmpHome);

		manager.startUsageRefreshScheduler();
		expect(manager.snapshot().usageScheduler.scheduledCredentialCount).toBe(1);

		manager.archiveCredential("exhausted");
		expect(manager.snapshot().usageScheduler.scheduledCredentialCount).toBe(0);

		manager.dispose();
	});

	test("归档凭据仍可按需刷新用量并写回数据", async () => {
		const { manager, tmpHome } = createManager([{ id: "retired" }]);
		tempHomes.push(tmpHome);
		manager.archiveCredential("retired");

		const originalFetch = globalThis.fetch;
		const resetAtSec = Math.floor((Date.now() + 3 * 60 * 60_000) / 1000);
		// The stub only needs to answer the usage GET; the rest of the fetch
		// surface (preconnect etc.) is irrelevant here.
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					plan_type: "pro",
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: {
							used_percent: 42,
							limit_window_seconds: 18000,
							reset_after_seconds: 3 * 60 * 60,
							reset_at: resetAtSec,
						},
						secondary_window: null,
					},
					code_review_rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: null,
						secondary_window: null,
					},
					additional_rate_limits: [],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof globalThis.fetch;

		try {
			const usage = await manager.getUsage("retired");
			expect(usage.plan_type).toBe("pro");
			expect(usage.primary_window?.used_percent).toBe(42);
		} finally {
			globalThis.fetch = originalFetch;
		}

		// The refresh must not resurrect the credential into the pool.
		const snapshot = manager.snapshot();
		expect(snapshot.archivedEntries.map((e) => e.id)).toEqual(["retired"]);
		expect(snapshot.availableTotal).toBe(0);
		expect(snapshot.usageCache.retired?.primary_window?.used_percent).toBe(42);

		manager.dispose();
	});

	test("归档凭据不计入配额概览的剩余额度", () => {
		const { manager, tmpHome } = createManager([
			{ id: "keep", planType: "pro", remainingPercent: 100 },
			{ id: "retire", planType: "pro", remainingPercent: 100 },
		]);
		tempHomes.push(tmpHome);

		const before = manager.getPublicQuotaOverview();
		expect(before.trackedAccountCount).toBe(2);
		expect(before.totalRemainingAccountEquivalents).toBeCloseTo(2, 4);

		manager.archiveCredential("retire");

		const after = manager.getPublicQuotaOverview();
		expect(after.trackedAccountCount).toBe(1);
		expect(after.totalRemainingAccountEquivalents).toBeCloseTo(1, 4);

		manager.dispose();
	});

	test("归档会解绑 session affinity，恢复后重新可选", async () => {
		const { manager, tmpHome } = createManager([{ id: "cred-a" }, { id: "cred-b" }]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("balanced");
		const first = await manager.acquireContext("session-1");
		expect(manager.snapshot().stickySessionCount).toBe(1);

		manager.archiveCredential(first.id);
		expect(manager.snapshot().stickySessionCount).toBe(0);

		const next = await manager.acquireContext("session-1");
		expect(next.id).not.toBe(first.id);

		manager.unarchiveCredential(first.id);
		expect(manager.archivedCount).toBe(0);
		expect(manager.availableCount).toBe(2);

		manager.dispose();
	});

	test("archivedAt 持久化到凭据文件，重启后仍然保持归档", () => {
		const { manager, tmpHome } = createManager([{ id: "retired" }, { id: "active" }]);
		tempHomes.push(tmpHome);

		manager.archiveCredential("retired");
		manager.dispose();

		const persisted = readCredentialsFile(tmpHome);
		const retiredRow = persisted.find((row) => row.id === "retired");
		expect(typeof retiredRow?.archivedAt).toBe("number");
		// Secrets and stats must survive: archiving is retirement, not deletion.
		expect(retiredRow?.refreshToken).toBe("rt-retired");

		const reloaded = new CodexManager({ homeDir: tmpHome, registerProcessHooks: false });
		const snapshot = reloaded.snapshot();
		expect(snapshot.archivedEntries.map((e) => e.id)).toEqual(["retired"]);
		expect(snapshot.availableEntries.map((e) => e.id)).toEqual(["active"]);
		reloaded.dispose();
	});

	test("unarchive 会清掉已过期的配额封禁", () => {
		const { manager, tmpHome } = createManager([
			{
				id: "cred",
				disabled: true,
				disabledReason: "quota_exhausted",
				quotaResetsAt: Date.now() - 60_000,
				archivedAt: Date.now() - 120_000,
			},
		]);
		tempHomes.push(tmpHome);

		// While archived the stale quota block is left untouched.
		expect(manager.snapshot().archivedEntries[0]?.disabled).toBe(true);

		manager.unarchiveCredential("cred");

		const snapshot = manager.snapshot();
		expect(snapshot.archivedTotal).toBe(0);
		expect(snapshot.availableEntries.map((e) => e.id)).toEqual(["cred"]);
		expect(snapshot.availableEntries[0]?.disabledReason).toBeUndefined();

		manager.dispose();
	});

	test("重复归档/恢复是幂等的，未知 id 抛错", () => {
		const { manager, tmpHome } = createManager([{ id: "cred" }]);
		tempHomes.push(tmpHome);

		manager.archiveCredential("cred");
		const firstArchivedAt = manager.snapshot().archivedEntries[0]?.archivedAt;
		manager.archiveCredential("cred");
		expect(manager.snapshot().archivedEntries[0]?.archivedAt).toBe(firstArchivedAt);

		manager.unarchiveCredential("cred");
		manager.unarchiveCredential("cred");
		expect(manager.archivedCount).toBe(0);

		expect(() => manager.archiveCredential("missing")).toThrow(/not found/i);
		expect(() => manager.unarchiveCredential("missing")).toThrow(/not found/i);

		manager.dispose();
	});

	test("isArchivedCodexCredential 只把正数时间戳视为归档", () => {
		expect(isArchivedCodexCredential({})).toBe(false);
		expect(isArchivedCodexCredential({ archivedAt: undefined })).toBe(false);
		expect(isArchivedCodexCredential({ archivedAt: 0 })).toBe(false);
		expect(isArchivedCodexCredential({ archivedAt: Date.now() })).toBe(true);
	});

	test("凭据文件以 0o600 落盘，不让 PAT 与 Ed25519 私钥世界可读", () => {
		if (process.platform === "win32") return; // NTFS ACLs, not POSIX modes.
		const { manager, tmpHome } = createManager([{ id: "cred" }]);
		tempHomes.push(tmpHome);

		// createManager seeded the file with default (umask) permissions; the
		// manager's own write must tighten it.
		manager.archiveCredential("cred");

		const mode = statSync(join(tmpHome, ".narrafork", "codex-credentials.json")).mode & 0o777;
		expect(mode).toBe(0o600);

		manager.dispose();
	});
});

/**
 * The archive/delete boundary for the lifetime usage rollup.
 *
 * "Archiving keeps the totals, deleting clears them" is the core invariant of the
 * archive state. The archive half is covered above; this covers the delete half,
 * including the archive → delete path where a user retires an account first and
 * removes it later.
 */
describe("归档与删除对累计用量的影响", () => {
	function seedUsage(credentialId: string) {
		recordCredentialUsage(
			{
				provider: "codex",
				credentialId,
				model: "gpt-5.5",
				inputTokens: 1000,
				outputTokens: 200,
				costUsd: 0.01,
			},
			db,
		);
	}

	test("归档保留累计用量（归档不是删除）", () => {
		const { manager, tmpHome } = createManager([{ id: "retired" }]);
		tempHomes.push(tmpHome);
		seedUsage("retired");

		manager.archiveCredential("retired");

		// No usage-totals call belongs on the archive path at all.
		const summary = getCredentialUsageTotals("codex", "retired", 50, db);
		expect(summary.requestCount).toBe(1);
		expect(summary.inputTokens).toBe(1000);

		manager.dispose();
	});

	test("归档后再删除会清空累计用量，且不影响其他凭据", () => {
		const { manager, tmpHome } = createManager([{ id: "retired" }, { id: "keep" }]);
		tempHomes.push(tmpHome);
		seedUsage("retired");
		seedUsage("keep");

		manager.archiveCredential("retired");
		expect(getCredentialUsageTotals("codex", "retired", 50, db).requestCount).toBe(1);

		// What DELETE /api/codex/credentials/:id does: remove, then drop the rollup.
		manager.removeCredential("retired");
		deleteCredentialUsageTotals("codex", "retired", db);

		expect(manager.snapshot().archivedTotal).toBe(0);
		expect(getCredentialUsageTotals("codex", "retired", 50, db).requestCount).toBe(0);
		// Deleting one credential must not disturb another's history.
		expect(getCredentialUsageTotals("codex", "keep", 50, db).requestCount).toBe(1);

		manager.dispose();
	});

	test("批量删除清空每个被删凭据的累计，保留未删的", () => {
		const { manager, tmpHome } = createManager([
			{ id: "a" },
			{ id: "b" },
			{ id: "c", archivedAt: Date.now() },
		]);
		tempHomes.push(tmpHome);
		for (const id of ["a", "b", "c"]) seedUsage(id);

		// Mirrors DELETE /api/codex/credentials/batch.
		const result = manager.removeCredentials(["a", "c"]);
		for (const id of result.removed) deleteCredentialUsageTotals("codex", id, db);

		expect(result.removed.sort()).toEqual(["a", "c"]);
		expect(getCredentialUsageTotals("codex", "a", 50, db).requestCount).toBe(0);
		// An archived credential deleted explicitly by id loses its totals too.
		expect(getCredentialUsageTotals("codex", "c", 50, db).requestCount).toBe(0);
		expect(getCredentialUsageTotals("codex", "b", 50, db).requestCount).toBe(1);

		manager.dispose();
	});

	test("unhealthy 批量清理不会碰归档凭据的累计", () => {
		const { manager, tmpHome } = createManager([
			{ id: "broken", disabled: true, disabledReason: "too_many_failures" },
			{ id: "retired-broken", disabled: true, disabledReason: "too_many_failures" },
		]);
		tempHomes.push(tmpHome);
		seedUsage("broken");
		seedUsage("retired-broken");

		manager.archiveCredential("retired-broken");

		// Mirrors DELETE /api/codex/credentials/unhealthy.
		const result = manager.removeUnhealthyCredentials();
		for (const id of result.removed) deleteCredentialUsageTotals("codex", id, db);

		expect(result.removed).toEqual(["broken"]);
		expect(getCredentialUsageTotals("codex", "broken", 50, db).requestCount).toBe(0);
		// Archived + unhealthy still keeps its history: the sweep skips it.
		expect(getCredentialUsageTotals("codex", "retired-broken", 50, db).requestCount).toBe(1);

		manager.dispose();
	});
});
