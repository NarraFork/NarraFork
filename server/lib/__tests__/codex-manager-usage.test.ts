import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexManager } from "../codex-manager";
import { isUnauthorizedCodexUsageError } from "../codex-usage";

function createManagerWithOneCredential(
	id: string,
	overrides: Record<string, unknown> = {},
): { manager: CodexManager; tmpHome: string } {
	const tmpHome = mkdtempSync(join(tmpdir(), "narrafork-codex-usage-"));
	const narraforkDir = join(tmpHome, ".narrafork");
	mkdirSync(narraforkDir, { recursive: true });

	const now = Date.now();
	const payload = [
		{
			id,
			refreshToken: `rt-${id}`,
			accessToken: `at-${id}`,
			expiresAt: now + 30 * 60_000,
			accountId: `acc-${id}`,
			priority: 0,
			disabled: false,
			...overrides,
		},
	];
	writeFileSync(join(narraforkDir, "codex-credentials.json"), JSON.stringify(payload, null, 2));
	writeFileSync(join(narraforkDir, "codex-stats.json"), JSON.stringify({}, null, 2));

	const manager = new CodexManager({ homeDir: tmpHome, registerProcessHooks: false });
	return { manager, tmpHome };
}

function createUsageResponse(primaryUsedPercent: number, resetAtSec: number): Response {
	return createUsageResponseWithWeekly(primaryUsedPercent, resetAtSec);
}

function createJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.signature`;
}

function createUsageResponseWithWeekly(
	primaryUsedPercent: number,
	primaryResetAtSec: number,
	weeklyUsedPercent?: number,
	weeklyResetAtSec?: number,
): Response {
	return new Response(
		JSON.stringify({
			plan_type: "plus",
			rate_limit: {
				allowed: true,
				limit_reached: primaryUsedPercent >= 100 || (weeklyUsedPercent ?? 0) >= 100,
				primary_window: {
					used_percent: primaryUsedPercent,
					limit_window_seconds: 18_000,
					reset_after_seconds: Math.max(primaryResetAtSec - Math.floor(Date.now() / 1000), 0),
					reset_at: primaryResetAtSec,
				},
				secondary_window:
					weeklyUsedPercent === undefined || weeklyResetAtSec === undefined
						? null
						: {
								used_percent: weeklyUsedPercent,
								limit_window_seconds: 604_800,
								reset_after_seconds: Math.max(weeklyResetAtSec - Math.floor(Date.now() / 1000), 0),
								reset_at: weeklyResetAtSec,
							},
			},
			code_review_rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: null,
				secondary_window: null,
			},
			additional_rate_limits: [],
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

function createManagerWithCachedUsageCredentials(
	creds: Array<{ id: string; priority: number; weeklyUsedPercent: number; weeklyResetAt: number }>,
): { manager: CodexManager; tmpHome: string } {
	const tmpHome = mkdtempSync(join(tmpdir(), "narrafork-codex-usage-"));
	const narraforkDir = join(tmpHome, ".narrafork");
	mkdirSync(narraforkDir, { recursive: true });

	const now = Date.now();
	const payload = creds.map((cred) => ({
		id: cred.id,
		refreshToken: `rt-${cred.id}`,
		accessToken: `at-${cred.id}`,
		expiresAt: now + 30 * 60_000,
		accountId: `acc-${cred.id}`,
		priority: cred.priority,
		disabled: false,
		usage: {
			plan_type: "plus",
			primary_window: {
				used_percent: 50,
				remaining_percent: 50,
				reset_at: Math.floor((now + 60 * 60_000) / 1000),
				reset_after_seconds: 60 * 60,
				window_type: "5h",
			},
			secondary_window: {
				used_percent: cred.weeklyUsedPercent,
				remaining_percent: 100 - cred.weeklyUsedPercent,
				reset_at: cred.weeklyResetAt,
				reset_after_seconds: Math.max(cred.weeklyResetAt - Math.floor(now / 1000), 0),
				window_type: "weekly",
			},
			queriedAt: new Date(now).toISOString(),
		},
	}));
	writeFileSync(join(narraforkDir, "codex-credentials.json"), JSON.stringify(payload, null, 2));
	writeFileSync(join(narraforkDir, "codex-stats.json"), JSON.stringify({}, null, 2));

	const manager = new CodexManager({ homeDir: tmpHome, registerProcessHooks: false });
	return { manager, tmpHome };
}

const tempHomes: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const p of tempHomes.splice(0)) {
		rmSync(p, { recursive: true, force: true });
	}
});

describe("CodexManager usage quota state", () => {
	test("支持导入只有 access_token 的凭据并且不会尝试刷新", async () => {
		const tmpHome = mkdtempSync(join(tmpdir(), "narrafork-codex-usage-"));
		tempHomes.push(tmpHome);
		const manager = new CodexManager({ homeDir: tmpHome, registerProcessHooks: false });
		const accessToken = createJwt({
			sub: "user-access-only",
			email: "access-only@example.com",
			chatgpt_account_id: "acc-access-only",
		});
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return new Response("should not refresh", { status: 500 });
		}) as unknown as typeof fetch;

		const result = manager.importCredentials([
			{ refreshToken: "", accessToken, displayName: "Access Only" },
		]);
		const ctx = await manager.acquireContext();
		const entry = manager.snapshot().entries[0];

		expect(result).toEqual({ added: 1, duplicates: 0, skipped: 0 });
		expect(ctx.token).toBe(accessToken);
		expect(fetchCalled).toBe(false);
		expect(entry?.accountId).toBe("acc-access-only");
		expect(entry?.email).toBe("access-only@example.com");
	});

	test("只有 access_token 且明确过期时跳过该凭据而不是刷新", async () => {
		const tmpHome = mkdtempSync(join(tmpdir(), "narrafork-codex-usage-"));
		tempHomes.push(tmpHome);
		const manager = new CodexManager({ homeDir: tmpHome, registerProcessHooks: false });
		const accessToken = createJwt({ sub: "expired-access-only" });
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return new Response("should not refresh", { status: 500 });
		}) as unknown as typeof fetch;

		manager.importCredentials([
			{ accessToken, expiresAt: Date.now() - 60_000, displayName: "Expired Access Only" },
		]);

		await expect(manager.acquireContext()).rejects.toThrow("All Codex credentials exhausted");
		expect(fetchCalled).toBe(false);
	});

	test("查询 usage 剩余为 0% 时直接标记 quota_exhausted", async () => {
		const { manager, tmpHome } = createManagerWithOneCredential("cred-a");
		tempHomes.push(tmpHome);
		const resetAtSec = Math.floor(Date.now() / 1000) + 3600;

		globalThis.fetch = (async () =>
			createUsageResponse(100, resetAtSec)) as unknown as typeof fetch;

		await manager.getUsage("cred-a");
		const entry = manager.snapshot().entries.find((item) => item.id === "cred-a");

		expect(entry).toBeDefined();
		expect(entry?.disabled).toBe(true);
		expect(entry?.disabledReason).toBe("quota_exhausted");
		expect(entry?.quotaResetsAt).toBe(resetAtSec * 1000);
	});

	test("查询 usage 仍有剩余时不标记 quota_exhausted", async () => {
		const { manager, tmpHome } = createManagerWithOneCredential("cred-b");
		tempHomes.push(tmpHome);
		const resetAtSec = Math.floor(Date.now() / 1000) + 3600;

		globalThis.fetch = (async () => createUsageResponse(62, resetAtSec)) as unknown as typeof fetch;

		await manager.getUsage("cred-b");
		const entry = manager.snapshot().entries.find((item) => item.id === "cred-b");

		expect(entry).toBeDefined();
		expect(entry?.disabled).toBe(false);
		expect(entry?.disabledReason).toBeUndefined();
	});

	test("刷新 usage 时记录并循环裁剪额度历史", async () => {
		const now = Date.now();
		const oldHistoryTimestamp = now - 3 * 60 * 60_000;
		const retainedHistoryTimestamp = now - 30 * 60_000;
		const { manager, tmpHome } = createManagerWithOneCredential("cred-history", {
			usageHistory: [
				{ timestamp: oldHistoryTimestamp, tier: "plus", remainingPercent: 10 },
				{ timestamp: retainedHistoryTimestamp, tier: "plus", remainingPercent: 30 },
			],
		});
		tempHomes.push(tmpHome);
		const resetAtSec = Math.floor(Date.now() / 1000) + 3600;

		globalThis.fetch = (async () => createUsageResponse(40, resetAtSec)) as unknown as typeof fetch;

		await manager.getUsage("cred-history");
		const saved = JSON.parse(
			readFileSync(join(tmpHome, ".narrafork", "codex-credentials.json"), "utf-8"),
		) as Array<{
			id: string;
			usageHistory?: Array<{ timestamp: number; remainingPercent: number }>;
		}>;
		const entry = saved.find((item) => item.id === "cred-history");
		const history = entry?.usageHistory ?? [];

		expect(history.some((item) => item.timestamp === oldHistoryTimestamp)).toBe(false);
		expect(history.some((item) => item.timestamp === retainedHistoryTimestamp)).toBe(true);
		expect(history.at(-1)?.remainingPercent).toBe(60);
	});

	test("usage 401 可被识别并用于 banned 标记", async () => {
		const { manager, tmpHome } = createManagerWithOneCredential("cred-401");
		tempHomes.push(tmpHome);

		globalThis.fetch = (async () =>
			new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;

		let caught: unknown;
		try {
			await manager.getUsage("cred-401");
		} catch (error) {
			caught = error;
		}
		expect(isUnauthorizedCodexUsageError(caught)).toBe(true);

		manager.markBanned("cred-401");
		const entry = manager.snapshot().entries.find((item) => item.id === "cred-401");
		expect(entry?.disabled).toBe(true);
		expect(entry?.disabledReason).toBe("banned");
	});

	test("查询 usage 恢复剩余时清理 quota_exhausted 状态", async () => {
		const { manager, tmpHome } = createManagerWithOneCredential("cred-c", {
			disabled: true,
			disabledReason: "quota_exhausted",
			quotaResetsAt: Date.now() - 1_000,
		});
		tempHomes.push(tmpHome);
		const resetAtSec = Math.floor(Date.now() / 1000) + 3600;

		globalThis.fetch = (async () => createUsageResponse(62, resetAtSec)) as unknown as typeof fetch;

		await manager.getUsage("cred-c");
		const entry = manager.snapshot().entries.find((item) => item.id === "cred-c");

		expect(entry).toBeDefined();
		expect(entry?.disabled).toBe(false);
		expect(entry?.disabledReason).toBeUndefined();
		expect(entry?.quotaResetsAt).toBeUndefined();
	});

	test("quota 错误后刷新 usage 以记录周限恢复时间", async () => {
		const { manager, tmpHome } = createManagerWithOneCredential("cred-quota-error");
		tempHomes.push(tmpHome);
		const primaryResetAtSec = Math.floor(Date.now() / 1000) + 1800;
		const weeklyResetAtSec = Math.floor(Date.now() / 1000) + 7200;

		globalThis.fetch = (async () =>
			createUsageResponseWithWeekly(
				50,
				primaryResetAtSec,
				100,
				weeklyResetAtSec,
			)) as unknown as typeof fetch;

		const hasMore = await manager.reportQuotaExhaustedAndRefreshUsage("cred-quota-error");
		const entry = manager.snapshot().entries.find((item) => item.id === "cred-quota-error");

		expect(hasMore).toBe(false);
		expect(entry?.disabled).toBe(true);
		expect(entry?.disabledReason).toBe("quota_exhausted");
		expect(entry?.quotaResetsAt).toBe(weeklyResetAtSec * 1000);
		expect(entry?.usage?.secondary_window?.window_type).toBe("weekly");
	});

	test("quota_exhausted 调度优先使用耗尽窗口的恢复时间", () => {
		const now = Date.now();
		const quotaResetsAt = now + 120_000;
		const { manager, tmpHome } = createManagerWithOneCredential("cred-d", {
			disabled: true,
			disabledReason: "quota_exhausted",
			quotaResetsAt,
			usage: {
				plan_type: "plus",
				primary_window: {
					used_percent: 50,
					remaining_percent: 50,
					reset_at: Math.floor((now + 60_000) / 1000),
					reset_after_seconds: 60,
					window_type: "5h",
				},
				secondary_window: {
					used_percent: 100,
					remaining_percent: 0,
					reset_at: Math.floor(quotaResetsAt / 1000),
					reset_after_seconds: 120,
					window_type: "weekly",
				},
				queriedAt: new Date(now).toISOString(),
			},
		});
		tempHomes.push(tmpHome);

		expect(manager.snapshot().usageScheduler.nextRunAt).toBe(quotaResetsAt);
	});

	test("选择凭据时跳过缓存中周限未恢复的账号", async () => {
		const now = Date.now();
		const weeklyResetAt = Math.floor((now + 2 * 60 * 60_000) / 1000);
		const { manager, tmpHome } = createManagerWithCachedUsageCredentials([
			{ id: "cred-weekly-exhausted", priority: 0, weeklyUsedPercent: 100, weeklyResetAt },
			{ id: "cred-ready", priority: 1, weeklyUsedPercent: 25, weeklyResetAt },
		]);
		tempHomes.push(tmpHome);

		const ctx = await manager.acquireContext();
		const exhausted = manager
			.snapshot()
			.entries.find((item) => item.id === "cred-weekly-exhausted");

		expect(ctx.id).toBe("cred-ready");
		expect(exhausted?.disabled).toBe(true);
		expect(exhausted?.disabledReason).toBe("quota_exhausted");
		expect(exhausted?.quotaResetsAt).toBe(weeklyResetAt * 1000);
	});
});
